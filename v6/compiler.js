import { encode, tagged } from './vm.js';

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
// A PUNCH list fills 10-column fields, 7 to a card's 72 columns, then goes on to the next card.
const CARD_FIELDS = 7;
// Index register C holds a SUB's return location and the pointers to its arguments, as FORTRAN II's linkage used
// one; DO loops get A and B.
const LINK = 2;
const viaLink = (addr) => tagged(addr, LINK);
// The transfer to take when a comparison is false, after leaving the AC holding left - right (or right - left).
const FALSE_JUMP = { '==': [false, 'TNZ'], '!=': [false, 'TZE'], '<': [false, 'TPL'], '>=': [false, 'TMI'], '>': [true, 'TPL'], '<=': [true, 'TMI'] };

// registers: how many of the index registers A, B the compiler may give DO loops (0 compiles without them).
export function compile(source, memSize = 256, registers = 2) {
  return build(source, memSize, build(source, memSize, 0, registers).codeLen, registers);
}

function build(source, memSize, dataBase, registers) {
  const tokens = tokenize(source);
  const initMem = new Int32Array(memSize);
  const refs = Array.from({ length: memSize }, () => new Set());
  const consts = new Map();
  const subs = Object.create(null);
  const code = [];
  const ipMap = [];
  const events = [];
  let sym = Object.create(null);
  let freeRegs = [1, 0].slice(2 - registers);
  const regLoops = [];
  // The expression result the accumulator holds, if any.
  let acHolds = null;
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

  function emit(op, a = 0, b = 0, c = 0) {
    const ip = code.length;
    code.push([op, a, b, c]);
    ipMap.push(line);
    events.push({ kind: 'emit', ip, instr: code[ip], line });
    return ip;
  }

  function patch(ip, target) {
    const [op, , b, c] = code[ip];
    code[ip] = [op, target, b, c];
    events.push({ kind: 'patch', ip, instr: code[ip], line });
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
  const dir = (addr) => ({ mode: 'DIR', addr });

  function eat(expected = null) {
    const tok = tokens[pos];
    if (tok.text === END && expected !== END) throw new SyntaxError('Unexpected end of input');
    pos++;
    line = tok.line;
    if (expected && tok.text !== expected) throw new SyntaxError(`Expected '${expected}', got '${tok.text}'`);
    return tok.text;
  }

  // The accumulator now holds an expression's value.
  function inAC() {
    acHolds = { mode: 'AC' };
    return acHolds;
  }

  // Store the AC's live value to a temporary so the AC can be reused; the place it held now names that cell.
  function spill() {
    if (!acHolds) return;
    const tmp = alloc(1);
    emit('STO', tmp);
    Object.assign(acHolds, dir(tmp));
    acHolds = null;
  }

  // Put a place's value in the AC.
  function load(p) {
    if (p.mode === 'AC') return;
    spill();
    if (p.mode === 'REG') emit('PXD', 0, 0, p.reg);
    else if (p.mode === 'IND') {
      emit('LXD', p.addr, 0, LINK);
      emit('CLA', viaLink(0));
    } else emit('CLA', valAddr(p));
  }

  // The operand that names a place's cell: a cell, an array element indexed by a register (an operand tag, no
  // instruction), or a temporary the AC stores a pointer's, a register's or an expression's value into.
  function valAddr(p) {
    if (p.mode === 'AC') spill();
    if (p.mode === 'DIR') return p.addr;
    if (p.mode === 'IDX') return tagged(p.base, p.reg);
    load(p);
    const tmp = alloc(1);
    emit('STO', tmp);
    return tmp;
  }

  // A cell holding the place's address, to pass it by reference. A value that is not in memory is passed in a temporary.
  function ptrAddr(p) {
    if (p.mode === 'IND') return p.addr;
    if (p.mode !== 'IDX') return defConst(valAddr(p));
    spill();
    emit('PXD', 0, 0, p.reg);
    emit('ADD', defConst(p.base));
    return valAddr(inAC());
  }

  // Store the AC into a place.
  function store(place) {
    if (place.mode === 'REG') emit('PAX', 0, 0, place.reg);
    else if (place.mode === 'IND') {
      emit('LXD', place.addr, 0, LINK);
      emit('STO', viaLink(0));
    } else emit('STO', valAddr(place));
    acHolds = null;
  }

  // l op r through the AC, or through the MQ for * / and MOD: LDQ l, then MPY r (the product in the MQ), or a
  // cleared AC and DVP r (the quotient in the MQ, the remainder in the AC).
  function arith(op, l, r) {
    if (!['+', '-', '*', '/', '%'].includes(op)) throw new SyntaxError(`'${op}' is allowed only in an IF or loop test`);
    const b = valAddr(r);
    if (op === '+' || op === '-') {
      load(l);
      emit(op === '+' ? 'ADD' : 'SUB', b);
      return inAC();
    }
    const a = valAddr(l);
    spill();
    emit('LDQ', a);
    if (op === '*') emit('MPY', b);
    else {
      emit('CLA', defConst(0));
      emit('DVP', b);
    }
    if (op === '%') return inAC();
    const tmp = alloc(1);
    emit('STQ', tmp);
    return dir(tmp);
  }

  // Leave the AC holding the difference a comparison tests, and emit the transfer taken when it is false.
  function condition() {
    const l = parseExpr(2);
    if (!(peek() in FALSE_JUMP)) {
      load(l);
      acHolds = null;
      return emit('TZE');
    }
    const [swap, jump] = FALSE_JUMP[eat()];
    const r = parseExpr(2);
    if (swap) arith('-', r, l);
    else arith('-', l, r);
    acHolds = null;
    return emit(jump);
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
    let idx = parseExpr();
    if (idx.mode === 'REG' && place.mode === 'DIR' && peek() === ']') {
      eat(']');
      return { mode: 'IDX', base: place.addr, reg: idx.reg };
    }
    if (peek() === ',') {
      eat(',');
      idx = arith('+', idx, arith('*', parseExpr(), dir(defConst(place.dims[0]))));
    }
    eat(']');
    return { mode: 'IND', addr: valAddr(arith('+', dir(ptrAddr(place)), idx)) };
  }

  function parseAtom() {
    const t = peek();
    if (/^\d+$/.test(t)) return dir(defConst(eat()));
    if (t === '-') {
      eat('-');
      const x = valAddr(parseAtom());
      spill();
      emit('CLS', x);
      return inAC();
    }
    if (t === '(') { eat('('); const e = parseExpr(); eat(')'); return e; }
    if (t === 'MOD') {
      eat('MOD');
      eat('(');
      const x = parseExpr();
      eat(',');
      const y = parseExpr();
      eat(')');
      return arith('%', x, y);
    }
    return parseLValue();
  }

  function parseExpr(minPrec = 0) {
    let lhs = parseAtom();
    while (peek() in PREC && PREC[peek()] >= minPrec) {
      const op = eat();
      lhs = arith(op, lhs, parseExpr(PREC[op] + 1));
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
    emit('REWIND');
  }

  function parsePunch() {
    for (let n = 1; ; n++) {
      emit('CARD', valAddr(parseExpr()));
      const more = peek() === ',';
      if (!more || n % CARD_FIELDS === 0) emit('PUNCH');
      if (!more) return;
      eat(',');
    }
  }

  function parsePrint() {
    emit('PRINT', valAddr(parseExpr()));
  }

  function parseIf() {
    const toElse = condition();
    eat('THEN');
    parseBlock();
    if (peek() === 'ELSE') {
      eat('ELSE');
      const toEnd = emit('TRA');
      patch(toElse, code.length);
      parseBlock();
      patch(toEnd, code.length);
    } else {
      patch(toElse, code.length);
    }
    eat('END');
  }

  // As FORTRAN I did, a DO loop keeps a local counter in a free index register; FORTRAN leaves a DO variable
  // undefined after its loop, so the register is never stored back.
  function parseDo() {
    const name = peek();
    const v = parseLValue();
    eat('=');
    const start = parseExpr();
    eat(',');
    const stop = dir(valAddr(parseExpr()));
    const reg = v === sym[name] && v.mode === 'DIR' && !v.dims ? freeRegs.pop() : undefined;
    if (reg !== undefined) {
      sym[name] = { mode: 'REG', reg, addr: v.addr, dims: null };
      emit('LXD', valAddr(start), 0, reg);
      const top = code.length;
      const exit = emit('TXH', 0, stop.addr, reg);
      parseBlock();
      eat('END');
      emit('TXI', top, 1, reg);
      patch(exit, code.length);
      regLoops.push({ reg, name, from: top - 1, to: code.length });
      sym[name] = v;
      freeRegs.push(reg);
      return;
    }
    load(start);
    store(v);
    const top = code.length;
    arith('-', stop, v);
    acHolds = null;
    const exit = emit('TMI');
    parseBlock();
    eat('END');
    arith('+', v, dir(defConst(1)));
    store(v);
    emit('TRA', top);
    patch(exit, code.length);
  }

  // A SUB saves its return location from index register C on entry and returns through it (TRA 1,C).
  function parseSub() {
    const name = eat();
    eat('(');
    const savedSym = sym;
    const savedRegs = freeRegs;
    sym = Object.create(null);
    // A call from inside a loop would overwrite the caller's registers, so a SUB's loops keep their counters in memory.
    freeRegs = [];
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
    const skip = emit('TRA');
    subs[name] = { entryIp: code.length, params };
    emit('SXD', retSlot, 0, LINK);
    parseBlock();
    eat('END');
    sym = savedSym;
    freeRegs = savedRegs;
    emit('LXD', retSlot, 0, LINK);
    emit('TRA', viaLink(1));
    patch(skip, code.length);
  }

  function parseCall() {
    const name = eat();
    eat('(');
    const sub = subs[name];
    for (let i = 0; i < sub.params.length; i++) {
      if (i > 0) eat(',');
      touch(sub.params[i]);
      emit('CLA', ptrAddr(parseExpr()));
      emit('STO', sub.params[i]);
    }
    eat(')');
    emit('TSX', sub.entryIp, 0, LINK);
  }

  const STATEMENTS = { __proto__: null, DIM: parseDim, EQUIV: parseEquiv, READ: parseRead, REWIND: parseRewind, PRINT: parsePrint, PUNCH: parsePunch, IF: parseIf, DO: parseDo, SUB: parseSub, CALL: parseCall };

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
        load(parseExpr());
        store(lhs);
      }
    }
  }

  parseBlock();
  eat(END);
  emit('HALT');
  code.forEach((instr, ip) => { initMem[ip] = encode(instr); });
  return { code, codeLen: code.length, initMem, usedCells: nextMem, cellLines: refs, sym, subs, ipMap, events, regLoops };
}
