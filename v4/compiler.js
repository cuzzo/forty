const PREC = {
  '==': 1, '!=': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '+': 2, '-': 2, '*': 3, '/': 3,
};

const CMP_RISCV = {
  '<':  ['    slt t0, t0, t1'],
  '>':  ['    slt t0, t1, t0'],
  '<=': ['    slt t0, t1, t0', '    xori t0, t0, 1'],
  '>=': ['    slt t0, t0, t1', '    xori t0, t0, 1'],
  '==': ['    sub t0, t0, t1', '    seqz t0, t0'],
  '!=': ['    sub t0, t0, t1', '    snez t0, t0'],
};

const ALU_RISCV = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' };

// The last token of every program; it has a space, so no source text can be it.
const END = 'end of input';

export function tokenize(source) {
  const re = /#[^\n]*|\n|[A-Za-z_]\w*|\d+|==|!=|<=|>=|\S/g;
  const tokens = [];
  let line = 1;
  for (const m of source.matchAll(re)) {
    if (m[0] === '\n') { line++; continue; }
    if (m[0][0] !== '#') tokens.push({ text: m[0], line });
  }
  tokens.push({ text: END, line });
  return tokens;
}

const span = (dims) => (dims ? dims[0] * (dims[1] ?? 1) : 1);

export function compile(source, { memSize = 256 } = {}) {
  const tokens = tokenize(source);
  const consts = new Map();
  const subs = Object.create(null);
  const code = [];
  const compileEvents = [];
  const ipMap = [];
  const allocs = [];
  const aliases = [];
  const initMem = new Int32Array(memSize);
  let pos = 0;
  let nextMem = 0;
  let sym = Object.create(null);
  let currentLine = 1;

  function alloc(size = 1, role = 'scratch', label = '', dims = null) {
    if (nextMem + size > memSize) throw new Error(`Compile-time static RAM overflow (${memSize} cells)`);
    const base = nextMem;
    nextMem += size;
    allocs.push({ base, size, role, label, dims });
    return base;
  }

  function emit(op, a, b, c) {
    const ip = code.length;
    code.push([op, a, b, c]);
    ipMap.push(currentLine);
    compileEvents.push({ kind: 'emit', ip, instr: code[ip], line: currentLine });
    return ip;
  }

  function patch(ip, instr) {
    code[ip] = instr;
    compileEvents.push({ kind: 'patch', ip, instr, line: currentLine });
  }

  function defConst(val) {
    const num = Number(val) | 0;
    if (consts.has(num)) return consts.get(num);
    const addr = alloc(1, 'rodata', `const(${num})`);
    initMem[addr] = num;
    consts.set(num, addr);
    return addr;
  }

  function getVar(name) {
    if (!(name in sym)) sym[name] = { mode: 'DIR', addr: alloc(1, 'bss', name), dims: null };
    return sym[name];
  }

  const peek = () => tokens[pos].text;

  function eat(expected = null) {
    const tok = tokens[pos];
    if (tok.text === END && expected !== END) throw new SyntaxError(`Unexpected end of input (line ${currentLine})`);
    pos++;
    currentLine = tok.line;
    if (expected && tok.text !== expected) {
      throw new SyntaxError(`Expected '${expected}', got '${tok.text}' at line ${tok.line}`);
    }
    return tok.text;
  }

  function valAddr(opnd) {
    if (opnd.mode === 'DIR') return opnd.addr;
    const tmp = alloc(1, 'scratch', `deref_${opnd.addr}`);
    emit('LOAD_IND', tmp, opnd.addr, 0);
    return tmp;
  }

  function ptrAddr(opnd) {
    return opnd.mode === 'IND' ? opnd.addr : defConst(opnd.addr);
  }

  // Where a value bound for this place is written: the place itself, or a temporary that store() copies in.
  function into(place) {
    return place.mode === 'DIR' ? place.addr : alloc(1, 'scratch', 'tape_in');
  }

  // A value held directly is already in place when it was computed there.
  function store(place, src) {
    if (place.mode === 'IND') emit('STORE_IND', place.addr, src, 0);
    else if (src !== place.addr) emit('MOV', place.addr, src, 0);
  }

  function parseDecl() {
    const name = eat();
    if (peek() !== '(') return { name, dims: null };
    eat('(');
    const dims = [Number(eat())];
    if (peek() === ',') {
      eat(',');
      dims.push(Number(eat()));
    }
    eat(')');
    return { name, dims };
  }

  function parseLValue() {
    const tok = eat();
    if (!/^[A-Za-z_]/.test(tok)) {
      throw new SyntaxError(`Expected identifier, got '${tok}' at line ${currentLine}`);
    }
    const place = getVar(tok);
    if (peek() !== '[') return place;
    eat('[');
    let idx = valAddr(parseExpr());
    if (peek() === ',') {
      eat(',');
      const col = valAddr(parseExpr());
      const cOff = alloc(1, 'scratch', `${tok}_col_off`);
      emit('*', cOff, col, defConst(place.dims[0]));
      const tot = alloc(1, 'scratch', `${tok}_idx`);
      emit('+', tot, idx, cOff);
      idx = tot;
    }
    eat(']');
    const ptr = alloc(1, 'scratch', `&${tok}_elem`);
    emit('+', ptr, ptrAddr(place), idx);
    return { mode: 'IND', addr: ptr };
  }

  function parseAtom() {
    const t = peek();
    if (/^\d+$/.test(t)) return { mode: 'DIR', addr: defConst(eat()) };
    if (t === '-') {
      eat('-');
      const dst = alloc(1, 'scratch', 'neg_tmp');
      emit('-', dst, defConst(0), valAddr(parseAtom()));
      return { mode: 'DIR', addr: dst };
    }
    if (t === '(') {
      eat('(');
      const e = parseExpr();
      eat(')');
      return e;
    }
    return parseLValue();
  }

  function parseExpr(minPrec = 0) {
    let lhs = parseAtom();
    while (peek() in PREC && PREC[peek()] >= minPrec) {
      const op = eat();
      const rhs = parseExpr(PREC[op] + 1);
      const dst = alloc(1, 'scratch', `alu_${op}`);
      emit(op, dst, valAddr(lhs), valAddr(rhs));
      lhs = { mode: 'DIR', addr: dst };
    }
    return lhs;
  }

  function parseUnitOpt() {
    if (peek() !== '(') return defConst(0);
    eat('(');
    const unit = valAddr(parseExpr());
    eat(')');
    return unit;
  }

  function parseDim() {
    const { name, dims } = parseDecl();
    if (sym[name]?.mode === 'IND') sym[name].dims = dims;
    else sym[name] = { mode: 'DIR', addr: alloc(span(dims), 'bss', name, dims), dims };
  }

  function parseEquiv() {
    const { name, dims } = parseDecl();
    eat('=');
    sym[name] = { ...getVar(eat()), dims };
    aliases.push({ name, addr: sym[name].addr, dims });
  }

  function parseRead() {
    const unit = parseUnitOpt();
    const value = parseLValue();
    let eof = null;
    let flag = -1;
    if (peek() === ',') {
      eat(',');
      eof = parseLValue();
      flag = into(eof);
    }
    const dst = into(value);
    emit('TAPE_READ', dst, unit, flag);
    store(value, dst);
    if (eof) store(eof, flag);
  }

  function parseWrite() {
    const unit = parseUnitOpt();
    emit('TAPE_WRITE', valAddr(parseExpr()), unit, 0);
  }

  function parseRewind() {
    emit('TAPE_REWIND', parseUnitOpt(), 0, 0);
  }

  function parseDrumRead() {
    eat('(');
    const trk = valAddr(parseExpr());
    eat(',');
    const sec = valAddr(parseExpr());
    eat(',');
    const dstPtr = ptrAddr(parseLValue());
    eat(')');
    emit('DRUM_READ', dstPtr, trk, sec);
  }

  function parseDrumWrite() {
    eat('(');
    const trk = valAddr(parseExpr());
    eat(',');
    const sec = valAddr(parseExpr());
    eat(',');
    const srcPtr = ptrAddr(parseExpr());
    eat(')');
    emit('DRUM_WRITE', srcPtr, trk, sec);
  }

  function parsePrint() {
    emit('PRINT', valAddr(parseExpr()), 0, 0);
  }

  function parseIf() {
    const cond = valAddr(parseExpr());
    eat('THEN');
    const jzIdx = emit('JZ', 0, cond, 0);
    parseBlock();
    if (peek() === 'ELSE') {
      eat('ELSE');
      const jmpIdx = emit('JMP', 0, 0, 0);
      patch(jzIdx, ['JZ', code.length, cond, 0]);
      parseBlock();
      patch(jmpIdx, ['JMP', code.length, 0, 0]);
    } else {
      patch(jzIdx, ['JZ', code.length, cond, 0]);
    }
    eat('END');
  }

  function parseDo() {
    const v = parseLValue();
    eat('=');
    const start = valAddr(parseExpr());
    eat(',');
    const stop = valAddr(parseExpr());
    store(v, start);
    const loopTop = code.length;
    const cmpTmp = alloc(1, 'scratch', 'do_cmp');
    emit('<=', cmpTmp, valAddr(v), stop);
    const exitIdx = emit('JZ', 0, cmpTmp, 0);
    parseBlock();
    eat('END');
    const next = valAddr(v);
    emit('+', next, next, defConst(1));
    store(v, next);
    emit('JMP', loopTop, 0, 0);
    patch(exitIdx, ['JZ', code.length, cmpTmp, 0]);
  }

  function parseWhile() {
    const loopTop = code.length;
    const cond = valAddr(parseExpr());
    const exitIdx = emit('JZ', 0, cond, 0);
    parseBlock();
    eat('END');
    emit('JMP', loopTop, 0, 0);
    patch(exitIdx, ['JZ', code.length, cond, 0]);
  }

  function parseSub() {
    const name = eat();
    eat('(');
    const savedSym = sym;
    sym = Object.create(null);
    const params = [];
    while (peek() !== ')') {
      const p = eat();
      const pAddr = alloc(1, 'linkage_param', `${name}.${p}`);
      sym[p] = { mode: 'IND', addr: pAddr, dims: null };
      params.push(pAddr);
      if (peek() === ',') eat(',');
    }
    eat(')');
    const retSlot = alloc(1, 'linkage_ret', `${name}.ret`);
    const skipIdx = emit('JMP', 0, 0, 0);
    subs[name] = { entryIp: code.length, retSlot, params };
    parseBlock();
    eat('END');
    sym = savedSym;
    emit('JMP_IND', retSlot, 0, 0);
    patch(skipIdx, ['JMP', code.length, 0, 0]);
  }

  function parseCall() {
    const name = eat();
    eat('(');
    const sub = subs[name];
    for (let i = 0; i < sub.params.length; i++) {
      if (i > 0) eat(',');
      emit('MOV', sub.params[i], ptrAddr(parseExpr()), 0);
    }
    eat(')');
    emit('JAL', sub.retSlot, sub.entryIp, 0);
  }

  const STATEMENTS = {
    __proto__: null,
    DIM: parseDim,
    EQUIV: parseEquiv,
    PRINT: parsePrint,
    READ: parseRead,
    WRITE: parseWrite,
    REWIND: parseRewind,
    DRUM_READ: parseDrumRead,
    DRUM_WRITE: parseDrumWrite,
    IF: parseIf,
    DO: parseDo,
    WHILE: parseWhile,
    SUB: parseSub,
    CALL: parseCall,
  };

  function parseBlock() {
    while (peek() !== 'END' && peek() !== 'ELSE' && peek() !== END) {
      currentLine = tokens[pos].line;
      const statement = STATEMENTS[peek()];
      if (statement) {
        eat();
        statement();
      } else {
        const lhs = parseLValue();
        eat('=');
        store(lhs, valAddr(parseExpr()));
      }
    }
  }

  parseBlock();
  eat(END);
  return { code, initMem, usedCells: nextMem, debug: { allocs, aliases, symbols: { ...sym }, subs, compileEvents, ipMap } };
}

export function emitRiscv(code, initMem, usedCells) {
  const words = Array.from(initMem.subarray(0, usedCells)).join(', ');
  const asm = [
    '.data',
    `MEM: .word ${words}`,
    '.text',
    '.globl main',
    'main:',
    '    la s0, MEM',
  ];

  for (let i = 0; i < code.length; i++) {
    const [op, a, b, c] = code[i];
    const A = a * 4;
    const B = b * 4;
    const C = c * 4;
    asm.push(`L_${i}:`);

    if (op === 'MOV') {
      asm.push(`    lw t0, ${B}(s0)`, `    sw t0, ${A}(s0)`);
    } else if (op === 'LOAD_IND') {
      asm.push(`    lw t0, ${B}(s0)`, '    slli t0, t0, 2', '    add t0, s0, t0', '    lw t1, 0(t0)', `    sw t1, ${A}(s0)`);
    } else if (op === 'STORE_IND') {
      asm.push(`    lw t0, ${A}(s0)`, '    slli t0, t0, 2', '    add t0, s0, t0', `    lw t1, ${B}(s0)`, '    sw t1, 0(t0)');
    } else if (op === 'JAL') {
      asm.push(`    la t0, L_${i + 1}`, `    sw t0, ${A}(s0)`, `    j L_${b}`);
    } else if (op === 'JMP') {
      asm.push(`    j L_${a}`);
    } else if (op === 'JMP_IND') {
      asm.push(`    lw t0, ${A}(s0)`, '    jr t0');
    } else if (op === 'JZ') {
      asm.push(`    lw t0, ${B}(s0)`, `    beqz t0, L_${a}`);
    } else if (op === 'PRINT') {
      asm.push(`    lw a0, ${A}(s0)`, '    li a7, 1', '    ecall', '    li a0, 10', '    li a7, 11', '    ecall');
    } else if (op === 'TAPE_READ') {
      asm.push(`    lw a2, ${B}(s0)`, `    li a3, ${c >= 0 ? 1 : 0}`, '    li a7, 20', '    ecall', `    sw a0, ${A}(s0)`);
      if (c >= 0) asm.push(`    sw a1, ${C}(s0)`);
    } else if (op === 'TAPE_WRITE') {
      asm.push(`    lw a0, ${A}(s0)`, `    lw a1, ${B}(s0)`, '    li a7, 21', '    ecall');
    } else if (op === 'TAPE_REWIND') {
      asm.push(`    lw a1, ${A}(s0)`, '    li a7, 22', '    ecall');
    } else if (op === 'DRUM_READ') {
      asm.push(`    lw a0, ${A}(s0)`, '    slli a0, a0, 2', `    lw a1, ${B}(s0)`, `    lw a2, ${C}(s0)`, '    li a7, 23', '    ecall');
    } else if (op === 'DRUM_WRITE') {
      asm.push(`    lw a0, ${A}(s0)`, '    slli a0, a0, 2', `    lw a1, ${B}(s0)`, `    lw a2, ${C}(s0)`, '    li a7, 24', '    ecall');
    } else if (op in ALU_RISCV) {
      asm.push(`    lw t0, ${B}(s0)`, `    lw t1, ${C}(s0)`, `    ${ALU_RISCV[op]} t0, t0, t1`, `    sw t0, ${A}(s0)`);
    } else if (op in CMP_RISCV) {
      asm.push(`    lw t0, ${B}(s0)`, `    lw t1, ${C}(s0)`, ...CMP_RISCV[op], `    sw t0, ${A}(s0)`);
    } else {
      throw new Error(`Unsupported opcode in RV32IM emitter: ${op}`);
    }
  }

  asm.push(`L_${code.length}:`, '    li a7, 10', '    ecall');
  return asm.join('\n');
}
