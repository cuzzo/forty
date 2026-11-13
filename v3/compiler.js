import { encode } from './vm.js';

const span = (dims) => (dims ? dims[0] * (dims[1] ?? 1) : 1);

// The last token of every program; it has a space, so no source text can be it.
const END = 'end of input';

const PREC = { '==': 1, '!=': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3 };

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

// Code fills MEM[0..] one instruction per cell, so data starts where the code ends.
export function compile(source, memSize = 256) {
  return build(source, memSize, build(source, memSize, 0).codeLen);
}

function build(source, memSize, dataBase) {
  const tokens = tokenize(source);
  const initMem = new Int32Array(memSize);
  const refs = Array.from({ length: memSize }, () => new Set());
  const consts = new Map();
  const subs = Object.create(null);
  const code = [];
  const ipMap = [];
  const events = [];
  let sym = Object.create(null);
  let pos = 0;
  let nextMem = dataBase;
  let line = 1;

  function touch(addr, size = 1) {
    for (let i = 0; i < size; i++) refs[addr + i].add(line);
  }

  function alloc(size = 1, role = 'scratch', label = '') {
    if (nextMem + size > memSize) throw new Error(`Program does not fit in ${memSize} cells of RAM`);
    const base = nextMem;
    nextMem += size;
    touch(base, size);
    events.push({ kind: 'alloc', base, size, line, role, label });
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
    if (!(name in sym)) sym[name] = { mode: 'DIR', addr: alloc(1, 'bss', name), dims: null };
    touch(sym[name].addr, span(sym[name].dims));
    return sym[name];
  }

  const peek = () => tokens[pos].text;

  function eat(expected = null) {
    const tok = tokens[pos];
    if (tok.text === END && expected !== END) throw new SyntaxError('Unexpected end of input');
    pos++;
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
    if (peek() === ',') { eat(','); dims.push(Number(eat())); }
    eat(')');
    return { name, dims };
  }

  function parseLValue() {
    const tok = eat();
    if (!/^[A-Za-z_]/.test(tok)) throw new SyntaxError(`Expected identifier, got '${tok}'`);
    const place = getVar(tok);
    if (peek() !== '[') return place;
    eat('[');
    let idx = valAddr(parseExpr());
    if (peek() === ',') {
      eat(',');
      const cOff = alloc(1);
      emit('*', cOff, valAddr(parseExpr()), defConst(place.dims[0]));
      const tot = alloc(1);
      emit('+', tot, idx, cOff);
      idx = tot;
    }
    eat(']');
    const ptr = alloc(1);
    emit('+', ptr, ptrAddr(place), idx);
    return { mode: 'IND', addr: ptr };
  }

  function parseAtom() {
    const t = peek();
    if (/^\d+$/.test(t)) return { mode: 'DIR', addr: defConst(eat()) };
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
    while (peek() in PREC && PREC[peek()] >= minPrec) {
      const op = eat();
      const rhs = parseExpr(PREC[op] + 1);
      const dst = alloc(1);
      emit(op, dst, valAddr(lhs), valAddr(rhs));
      lhs = { mode: 'DIR', addr: dst };
    }
    return lhs;
  }

  function parseDim() {
    const { name, dims } = parseDecl();
    if (sym[name]?.mode === 'IND') sym[name].dims = dims;
    else sym[name] = { mode: 'DIR', addr: alloc(span(dims), 'bss', name), dims };
  }

  function parseEquiv() {
    const { name, dims } = parseDecl();
    eat('=');
    sym[name] = { ...getVar(eat()), dims };
  }

  function parseRead() {
    const device = eat();
    if (device !== 'DRUM' && device !== 'TAPE') throw new SyntaxError(`Expected DRUM or TAPE, got '${device}'`);
    let sector = 0;
    if (device === 'DRUM') {
      sector = valAddr(parseExpr());
      eat(',');
    }
    // FORTRAN reads as many words as the list names: here the whole array.
    const list = parseLValue();
    emit(`${device}_READ`, ptrAddr(list), sector, span(list.dims));
  }

  function parseRewind() {
    emit('REWIND', 0, 0, 0);
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
    const cmpTmp = alloc(1);
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

  function parseSub() {
    const name = eat();
    eat('(');
    const savedSym = sym;
    sym = Object.create(null);
    const params = [];
    while (peek() !== ')') {
      const p = eat();
      const pAddr = alloc(1, 'linkage', `${name}.${p}`);
      sym[p] = { mode: 'IND', addr: pAddr, dims: null };
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
    emit('JMP_IND', retSlot, 0, 0);
    patch(skipIdx, ['JMP', code.length, 0, 0]);
  }

  function parseCall() {
    const name = eat();
    eat('(');
    const sub = subs[name];
    for (let i = 0; i < sub.params.length; i++) {
      if (i > 0) eat(',');
      touch(sub.params[i]);
      emit('MOV', sub.params[i], ptrAddr(parseExpr()), 0);
    }
    eat(')');
    touch(sub.retSlot);
    emit('JAL', sub.retSlot, sub.entryIp, 0);
  }

  const STATEMENTS = { __proto__: null, DIM: parseDim, EQUIV: parseEquiv, READ: parseRead, REWIND: parseRewind, PRINT: parsePrint, IF: parseIf, DO: parseDo, SUB: parseSub, CALL: parseCall };

  function parseBlock() {
    while (peek() !== 'END' && peek() !== 'ELSE' && peek() !== END) {
      line = tokens[pos].line;
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
  emit('HALT', 0, 0, 0);
  code.forEach((instr, ip) => { initMem[ip] = encode(instr); });
  return { code, codeLen: code.length, initMem, usedCells: nextMem, cellLines: refs, sym, subs, ipMap, events };
}
