import { RECORD_WORDS, SECTOR_WORDS, encode } from './vm.js';

const span = (dims) => (dims ? dims[0] * (dims[1] ?? 1) : 1);

const PREC = { '==': 1, '!=': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3 };

export function tokenize(source) {
  const re = /#[^\n]*|\n|[ \t\r]+|[A-Za-z_]\w*|\d+|==|!=|<=|>=|[-+*/=(),\[\]<>]|(\S)/g;
  const tokens = [];
  let line = 1;
  for (const m of source.matchAll(re)) {
    if (m[1]) throw new SyntaxError(`Unexpected character '${m[0]}' at line ${line}`);
    if (m[0] === '\n') { line++; continue; }
    if (!'# \t\r'.includes(m[0][0])) tokens.push({ text: m[0], line });
  }
  return tokens;
}

// Code fills MEM[0..] one instruction per cell, so data starts where the code ends.
export function compile(source, memSize = 256) {
  return build(source, memSize, build(source, memSize, 0).codeLen);
}

function build(source, memSize, dataBase) {
  const tokens = tokenize(source);
  const initMem = new Int32Array(memSize);
  const cells = Array.from({ length: memSize }, () => ({ role: 'unused', label: '' }));
  const refs = Array.from({ length: memSize }, () => new Set());
  const consts = new Map();
  const subs = Object.create(null);
  const code = [];
  const ipMap = [];
  const events = [];
  let sym = Object.create(null);
  let currentSub = null;
  let pos = 0;
  let nextMem = dataBase;
  let line = 1;
  const scoped = (name) => (currentSub ? `${currentSub}.${name}` : name);

  function touch(addr, size = 1) {
    for (let i = 0; i < size; i++) refs[addr + i].add(line);
  }

  function alloc(size = 1, role = 'scratch', label = '') {
    if (nextMem + size > memSize) throw new Error(`Program does not fit in ${memSize} cells of RAM`);
    const base = nextMem;
    nextMem += size;
    for (let i = 0; i < size; i++) {
      cells[base + i] = { role, label: size > 1 ? `${label}[${i}]` : (label || `tmp_${base + i}`) };
    }
    touch(base, size);
    events.push({ kind: 'alloc', base, size, line });
    return base;
  }

  function emit(op, a, b, c) {
    const ip = code.length;
    code.push([op, a, b, c]);
    ipMap.push(line);
    events.push({ kind: 'emit', ip, instr: code[ip], line });
    return ip;
  }

  function patch(ip, instr) {
    code[ip] = instr;
    events.push({ kind: 'patch', ip, instr, line });
  }

  function defConst(val) {
    const n = Number(val) | 0;
    if (consts.has(n)) { touch(consts.get(n)); return consts.get(n); }
    const addr = alloc(1, 'rodata', `const(${n})`);
    initMem[addr] = n;
    consts.set(n, addr);
    return addr;
  }

  function getVar(name) {
    if (!(name in sym)) sym[name] = { addr: alloc(1, 'bss', scoped(name)), dims: null, isRef: false };
    touch(sym[name].addr, span(sym[name].dims));
    return sym[name];
  }

  const peek = () => (pos < tokens.length ? tokens[pos].text : null);

  function eat(expected = null) {
    if (pos >= tokens.length) throw new SyntaxError('Unexpected end of input');
    const tok = tokens[pos++];
    line = tok.line;
    if (expected && tok.text !== expected) throw new SyntaxError(`Expected '${expected}', got '${tok.text}'`);
    return tok.text;
  }

  function valAddr(opnd) {
    if (opnd.mode === 'DIR') return opnd.addr;
    const tmp = alloc(1);
    emit('LOAD_IND', tmp, opnd.addr, 0);
    return tmp;
  }

  function ptrAddr(opnd) {
    return opnd.mode === 'IND' ? opnd.addr : defConst(opnd.addr);
  }

  function parseDecl() {
    const name = eat();
    if (peek() !== '(') return { name, dims: null };
    eat('(');
    const dims = [Number(eat())];
    if (peek() === ',') { eat(','); dims.push(Number(eat())); }
    eat(')');
    return { name, dims };
  }

  function parseLValue() {
    const tok = eat();
    if (!/^[A-Za-z_]/.test(tok)) throw new SyntaxError(`Expected identifier, got '${tok}'`);
    const { addr: baseAddr, dims, isRef } = getVar(tok);
    if (peek() !== '[') return isRef ? { mode: 'IND', addr: baseAddr } : { mode: 'DIR', addr: baseAddr };
    eat('[');
    let idx = valAddr(parseExpr());
    if (peek() === ',') {
      if (!dims || dims.length < 2) throw new SyntaxError(`2D index on non-2D variable '${tok}'`);
      eat(',');
      const cOff = alloc(1);
      emit('*', cOff, valAddr(parseExpr()), defConst(dims[0]));
      const tot = alloc(1);
      emit('+', tot, idx, cOff);
      idx = tot;
    }
    eat(']');
    const ptr = alloc(1);
    emit('+', ptr, isRef ? baseAddr : defConst(baseAddr), idx);
    return { mode: 'IND', addr: ptr };
  }

  function parseAtom() {
    const t = peek();
    if (t !== null && /^\d+$/.test(t)) return { mode: 'DIR', addr: defConst(eat()) };
    if (t === '-') {
      eat('-');
      const dst = alloc(1);
      emit('-', dst, defConst(0), valAddr(parseAtom()));
      return { mode: 'DIR', addr: dst };
    }
    if (t === '(') { eat('('); const e = parseExpr(); eat(')'); return e; }
    if (t === 'MOD') {
      eat('MOD');
      eat('(');
      const x = valAddr(parseExpr());
      eat(',');
      const y = valAddr(parseExpr());
      eat(')');
      const dst = alloc(1);
      emit('%', dst, x, y);
      return { mode: 'DIR', addr: dst };
    }
    return parseLValue();
  }

  function parseExpr(minPrec = 0) {
    let lhs = parseAtom();
    while (peek() !== null && peek() in PREC && PREC[peek()] >= minPrec) {
      const op = eat();
      const rhs = parseExpr(PREC[op] + 1);
      const dst = alloc(1);
      emit(op, dst, valAddr(lhs), valAddr(rhs));
      lhs = { mode: 'DIR', addr: dst };
    }
    return lhs;
  }

  function parseBlock() {
    while (peek() !== null && peek() !== 'END' && peek() !== 'ELSE') {
      line = tokens[pos].line;
      const tok = peek();
      if (tok === 'DIM') {
        eat('DIM');
        const { name, dims } = parseDecl();
        if (sym[name]?.isRef) { sym[name].dims = dims; touch(sym[name].addr); }
        else sym[name] = { addr: alloc(span(dims), 'bss', scoped(name)), dims, isRef: false };
      } else if (tok === 'EQUIV') {
        eat('EQUIV');
        const { name, dims } = parseDecl();
        eat('=');
        const tName = eat();
        const target = sym[tName];
        if (!target || target.isRef || span(dims) > span(target.dims)) throw new SyntaxError(`EQUIV '${name}' must fit inside '${tName}'`);
        sym[name] = { addr: target.addr, dims, isRef: false };
        touch(target.addr, span(dims));
      } else if (tok === 'READ') {
        eat('READ');
        const device = eat();
        if (device !== 'TAPE' && device !== 'DRUM') throw new SyntaxError(`Expected DRUM or TAPE, got '${device}'`);
        const sector = device === 'DRUM' ? valAddr(parseExpr()) : 0;
        if (device === 'DRUM') eat(',');
        const words = device === 'TAPE' ? RECORD_WORDS : SECTOR_WORDS;
        const buf = eat();
        const v = getVar(buf);
        if (!v.isRef && span(v.dims) < words) throw new SyntaxError(`${device} destination '${buf}' needs at least ${words} cells`);
        emit(device === 'TAPE' ? 'TAPE_READ' : 'DRUM_READ', v.addr, sector, v.isRef ? 1 : 0);
      } else if (tok === 'REWIND') {
        eat('REWIND');
        emit('REWIND', 0, 0, 0);
      } else if (tok === 'PRINT') {
        eat('PRINT');
        emit('PRINT', valAddr(parseExpr()), 0, 0);
      } else if (tok === 'IF') {
        eat('IF');
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
      } else if (tok === 'DO') {
        eat('DO');
        const name = eat();
        const v = getVar(name);
        if (v.isRef) throw new SyntaxError(`DO variable '${name}' cannot be a SUB argument`);
        eat('=');
        const start = valAddr(parseExpr());
        eat(',');
        const stop = valAddr(parseExpr());
        emit('MOV', v.addr, start, 0);
        const loopTop = code.length;
        const cmpTmp = alloc(1);
        emit('<=', cmpTmp, v.addr, stop);
        const exitIdx = emit('JZ', 0, cmpTmp, 0);
        parseBlock();
        eat('END');
        emit('+', v.addr, v.addr, defConst(1));
        emit('JMP', loopTop, 0, 0);
        patch(exitIdx, ['JZ', code.length, cmpTmp, 0]);
      } else if (tok === 'SUB') {
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
          const pAddr = alloc(1, 'linkage', `${name}.${p}`);
          sym[p] = { addr: pAddr, dims: null, isRef: true };
          params.push(pAddr);
          if (peek() === ',') eat(',');
        }
        eat(')');
        const retSlot = alloc(1, 'linkage', `${name}.ret`);
        const skipIdx = emit('JMP', 0, 0, 0);
        subs[name] = { entryIp: code.length, retSlot, params };
        parseBlock();
        eat('END');
        sym = savedSym;
        currentSub = savedSub;
        emit('JMP_IND', retSlot, 0, 0);
        patch(skipIdx, ['JMP', code.length, 0, 0]);
      } else if (tok === 'CALL') {
        eat('CALL');
        const name = eat();
        eat('(');
        const sub = subs[name];
        if (!sub) throw new SyntaxError(`Undefined subroutine '${name}'`);
        for (let i = 0; i < sub.params.length; i++) {
          if (i > 0) eat(',');
          touch(sub.params[i]);
          emit('MOV', sub.params[i], ptrAddr(parseExpr()), 0);
        }
        eat(')');
        touch(sub.retSlot);
        emit('JAL', sub.retSlot, sub.entryIp, 0);
      } else {
        const lhs = parseLValue();
        eat('=');
        const rhs = valAddr(parseExpr());
        emit(lhs.mode === 'IND' ? 'STORE_IND' : 'MOV', lhs.addr, rhs, 0);
      }
    }
  }

  parseBlock();
  if (pos < tokens.length) throw new SyntaxError(`Unexpected '${tokens[pos].text}' at line ${tokens[pos].line}`);
  emit('HALT', 0, 0, 0);
  code.forEach((instr, ip) => {
    cells[ip] = { role: 'code', label: instr.join(' ') };
    initMem[ip] = encode(instr);
  });
  return { code, codeLen: code.length, initMem, usedCells: nextMem, cells, cellLines: refs, sym, subs, ipMap, events };
}
