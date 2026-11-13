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

export function tokenize(source) {
  const tokens = [];
  const re = /#[^\n]*|\n|[ \t\r]+|[A-Za-z_]\w*|\d+|==|!=|<=|>=|[-+*/=(),\[\]<>]|(\S)/g;
  let line = 1;
  let lineStart = 0;

  for (const m of source.matchAll(re)) {
    const text = m[0];
    if (m[1]) throw new SyntaxError(`Unexpected character '${text}' at line ${line}`);
    if (text === '\n') {
      line++;
      lineStart = m.index + 1;
      continue;
    }
    if (text[0] === '#' || text[0] === ' ' || text[0] === '\t' || text[0] === '\r') continue;
    tokens.push({ text, line, col: m.index - lineStart });
  }

  return tokens;
}

function cellLabelFor(name, i, dims) {
  if (!dims) return name;
  if (dims.length === 2) return `${name}[${i % dims[0]},${Math.floor(i / dims[0])}]`;
  return `${name}[${i}]`;
}

const span = (dims) => (dims ? dims[0] * (dims[1] ?? 1) : 1);

export function compile(source, { memSize = 256 } = {}) {
  const tokens = tokenize(source);
  const lines = source.split('\n');
  const consts = new Map();
  const subs = Object.create(null);
  const code = [];
  const compileEvents = [];
  const ipMap = [];
  const initMem = new Int32Array(memSize);
  const cells = Array.from({ length: memSize }, (_, addr) => ({
    addr, role: 'unused', label: '', aliases: [], symbol: null, dims: null, initVal: 0,
  }));

  let pos = 0;
  let nextMem = 0;
  let sym = Object.create(null);
  let currentSub = null;
  let currentLine = 1;

  function alloc(size = 1, role = 'scratch', label = '', symbol = null, dims = null) {
    if (nextMem + size > memSize) {
      throw new Error(`Compile-time static RAM overflow (${memSize} cells)`);
    }
    const base = nextMem;
    nextMem += size;
    for (let i = 0; i < size; i++) {
      const cellLabel = label ? cellLabelFor(label, i, dims) : `tmp_${base + i}`;
      cells[base + i] = { addr: base + i, role, label: cellLabel, aliases: [], symbol, dims, initVal: 0 };
    }
    return base;
  }

  function emit(op, a, b, c, note = '') {
    const ip = code.length;
    const instr = [op, a, b, c];
    code.push(instr);
    ipMap.push({ ip, line: currentLine, sourceText: (lines[currentLine - 1] ?? '').trim() });
    compileEvents.push({ seq: compileEvents.length, kind: 'emit', ip, instr: [...instr], line: currentLine, note });
    return ip;
  }

  function patch(ip, instr, note = '') {
    const before = [...code[ip]];
    code[ip] = instr;
    compileEvents.push({
      seq: compileEvents.length, kind: 'patch', ip, before, after: [...instr], line: currentLine, note,
    });
  }

  function defConst(val) {
    const num = Number(val) | 0;
    if (consts.has(num)) return consts.get(num);
    const addr = alloc(1, 'rodata', `const(${num})`);
    initMem[addr] = num;
    cells[addr].initVal = num;
    consts.set(num, addr);
    return addr;
  }

  function getVar(name) {
    if (name in sym) return sym[name];
    const label = currentSub ? `${currentSub}.${name}` : name;
    const addr = alloc(1, 'bss', label, label, null);
    sym[name] = { addr, dims: null, isRef: false };
    return sym[name];
  }

  const peek = () => (pos < tokens.length ? tokens[pos].text : null);

  function eat(expected = null) {
    if (pos >= tokens.length) throw new SyntaxError(`Unexpected end of input (line ${currentLine})`);
    const tok = tokens[pos++];
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
    const { addr: baseAddr, dims, isRef } = getVar(tok);
    if (peek() !== '[') {
      return isRef ? { mode: 'IND', addr: baseAddr } : { mode: 'DIR', addr: baseAddr };
    }
    eat('[');
    let idx = valAddr(parseExpr());
    if (peek() === ',') {
      if (!dims || dims.length < 2) throw new SyntaxError(`2D index on non-2D variable '${tok}'`);
      eat(',');
      const col = valAddr(parseExpr());
      const cOff = alloc(1, 'scratch', `${tok}_col_off`);
      emit('*', cOff, col, defConst(dims[0]));
      const tot = alloc(1, 'scratch', `${tok}_idx`);
      emit('+', tot, idx, cOff);
      idx = tot;
    }
    eat(']');
    const ptr = alloc(1, 'scratch', `&${tok}_elem`);
    emit('+', ptr, isRef ? baseAddr : defConst(baseAddr), idx);
    return { mode: 'IND', addr: ptr };
  }

  function parseAtom() {
    const t = peek();
    if (t !== null && /^\d+$/.test(t)) return { mode: 'DIR', addr: defConst(eat()) };
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
    while (peek() !== null && peek() in PREC && PREC[peek()] >= minPrec) {
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

  function stmtDim() {
    eat('DIM');
    const { name, dims } = parseDecl();
    if (sym[name]?.isRef) {
      sym[name].dims = dims;
      return;
    }
    const size = span(dims);
    const label = currentSub ? `${currentSub}.${name}` : name;
    const addr = alloc(size, 'bss', label, label, dims);
    sym[name] = { addr, dims, isRef: false };
  }

  function stmtEquiv() {
    eat('EQUIV');
    const { name, dims } = parseDecl();
    eat('=');
    const targetName = eat();
    const target = sym[targetName];
    const size = span(dims);
    if (!target || target.isRef || size > span(target.dims)) {
      throw new SyntaxError(`EQUIV '${name}' must fit inside '${targetName}' (line ${currentLine})`);
    }
    sym[name] = { addr: target.addr, dims, isRef: false };
    for (let i = 0; i < size; i++) {
      cells[target.addr + i].aliases.push(cellLabelFor(name, i, dims));
    }
  }

  function stmtRead() {
    eat('READ');
    const unitAddr = parseUnitOpt();
    const lhs = parseLValue();
    let eofAddr = -1;
    if (peek() === ',') {
      eat(',');
      const eofVar = getVar(eat());
      if (eofVar.isRef) {
        throw new SyntaxError(`EOF status variable cannot be a SUB reference parameter (line ${currentLine})`);
      }
      eofAddr = eofVar.addr;
    }
    if (lhs.mode === 'DIR') {
      emit('TAPE_READ', lhs.addr, unitAddr, eofAddr);
      return;
    }
    const tmp = alloc(1, 'scratch', 'tape_in');
    emit('TAPE_READ', tmp, unitAddr, eofAddr);
    emit('STORE_IND', lhs.addr, tmp, 0);
  }

  function stmtDrumRead() {
    eat('DRUM_READ');
    eat('(');
    const trk = valAddr(parseExpr());
    eat(',');
    const sec = valAddr(parseExpr());
    eat(',');
    const dstPtr = ptrAddr(parseLValue());
    eat(')');
    emit('DRUM_READ', dstPtr, trk, sec);
  }

  function stmtDrumWrite() {
    eat('DRUM_WRITE');
    eat('(');
    const trk = valAddr(parseExpr());
    eat(',');
    const sec = valAddr(parseExpr());
    eat(',');
    const srcPtr = ptrAddr(parseExpr());
    eat(')');
    emit('DRUM_WRITE', srcPtr, trk, sec);
  }

  function stmtIf() {
    eat('IF');
    const cond = valAddr(parseExpr());
    eat('THEN');
    const jzIdx = emit('JZ', 0, cond, 0, 'IF placeholder');
    parseBlock();
    if (peek() === 'ELSE') {
      eat('ELSE');
      const jmpIdx = emit('JMP', 0, 0, 0, 'ELSE skip placeholder');
      patch(jzIdx, ['JZ', code.length, cond, 0], 'Patch IF false -> ELSE');
      parseBlock();
      patch(jmpIdx, ['JMP', code.length, 0, 0], 'Patch ELSE end');
    } else {
      patch(jzIdx, ['JZ', code.length, cond, 0], 'Patch IF end');
    }
    eat('END');
  }

  function stmtDo() {
    eat('DO');
    const v = parseLValue();
    eat('=');
    const start = valAddr(parseExpr());
    eat(',');
    const stop = valAddr(parseExpr());
    store(v, start);
    const loopTop = code.length;
    const cmpTmp = alloc(1, 'scratch', 'do_cmp');
    emit('<=', cmpTmp, valAddr(v), stop);
    const exitIdx = emit('JZ', 0, cmpTmp, 0, 'DO exit placeholder');
    parseBlock();
    eat('END');
    const next = valAddr(v);
    emit('+', next, next, defConst(1));
    store(v, next);
    emit('JMP', loopTop, 0, 0);
    patch(exitIdx, ['JZ', code.length, cmpTmp, 0], 'Patch DO exit');
  }

  function stmtWhile() {
    eat('WHILE');
    const loopTop = code.length;
    const cond = valAddr(parseExpr());
    const exitIdx = emit('JZ', 0, cond, 0, 'WHILE exit placeholder');
    parseBlock();
    eat('END');
    emit('JMP', loopTop, 0, 0);
    patch(exitIdx, ['JZ', code.length, cond, 0], 'Patch WHILE exit');
  }

  function stmtSub() {
    eat('SUB');
    const name = eat();
    eat('(');
    const savedSym = sym;
    const savedSub = currentSub;
    sym = Object.create(null);
    currentSub = name;
    const params = [];
    while (peek() !== ')') {
      const p = eat();
      const pAddr = alloc(1, 'linkage_param', `${name}.${p}`, p);
      sym[p] = { addr: pAddr, dims: null, isRef: true };
      params.push(pAddr);
      if (peek() === ',') eat(',');
    }
    eat(')');
    const retSlot = alloc(1, 'linkage_ret', `${name}.ret`);
    const skipIdx = emit('JMP', 0, 0, 0, `Skip SUB ${name}`);
    subs[name] = { entryIp: code.length, retSlot, params };
    parseBlock();
    eat('END');
    sym = savedSym;
    currentSub = savedSub;
    emit('JMP_IND', retSlot, 0, 0, `Return from ${name}`);
    patch(skipIdx, ['JMP', code.length, 0, 0], `Patch skip SUB ${name}`);
  }

  function stmtCall() {
    eat('CALL');
    const name = eat();
    eat('(');
    const sub = subs[name];
    if (!sub) throw new SyntaxError(`Undefined subroutine '${name}' at line ${currentLine}`);
    for (let i = 0; i < sub.params.length; i++) {
      if (i > 0) eat(',');
      emit('MOV', sub.params[i], ptrAddr(parseExpr()), 0);
    }
    eat(')');
    emit('JAL', sub.retSlot, sub.entryIp, 0, `CALL ${name}`);
  }

  const STMT = {
    DIM: stmtDim,
    EQUIV: stmtEquiv,
    PRINT: () => { eat('PRINT'); emit('PRINT', valAddr(parseExpr()), 0, 0); },
    READ: stmtRead,
    WRITE: () => { eat('WRITE'); const u = parseUnitOpt(); emit('TAPE_WRITE', valAddr(parseExpr()), u, 0); },
    REWIND: () => { eat('REWIND'); emit('TAPE_REWIND', parseUnitOpt(), 0, 0); },
    DRUM_READ: stmtDrumRead,
    DRUM_WRITE: stmtDrumWrite,
    IF: stmtIf,
    DO: stmtDo,
    WHILE: stmtWhile,
    SUB: stmtSub,
    CALL: stmtCall,
  };

  function parseBlock() {
    while (peek() !== null && peek() !== 'END' && peek() !== 'ELSE') {
      currentLine = tokens[pos].line;
      const tok = peek();
      if (tok in STMT) {
        STMT[tok]();
        continue;
      }
      const lhs = parseLValue();
      eat('=');
      const rhs = valAddr(parseExpr());
      store(lhs, rhs);
    }
  }

  parseBlock();
  if (pos < tokens.length) {
    throw new SyntaxError(`Unexpected token '${tokens[pos].text}' at line ${tokens[pos].line}`);
  }

  return {
    code,
    initMem,
    usedCells: nextMem,
    debug: {
      cells: cells.slice(0, nextMem),
      symbols: { ...sym },
      subs,
      compileEvents,
      ipMap,
    },
  };
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
