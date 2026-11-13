const PREC = { '==': 1, '!=': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3 };

export function tokenize(source) {
  const re = /#[^\n]*|[A-Za-z_]\w*|\d+|==|!=|<=|>=|[-+*/=(),\[\]<>]/g;
  const tokens = [];
  for (const m of source.matchAll(re)) {
    if (m[0][0] !== '#') tokens.push(m[0]);
  }
  return tokens;
}

export function compile(source, memSize = 256) {
  const tokens = tokenize(source);
  const initMem = new Int32Array(memSize);
  const cells = Array.from({ length: memSize }, () => ({ role: 'unused', label: '' }));
  const consts = new Map();
  const subs = Object.create(null);
  const code = [];
  let sym = Object.create(null);
  let pos = 0;
  let nextMem = 0;

  function alloc(size = 1, role = 'scratch', label = '') {
    if (nextMem + size > memSize) throw new Error(`RAM overflow (${memSize} cells)`);
    const base = nextMem;
    nextMem += size;
    for (let i = 0; i < size; i++) {
      cells[base + i] = { role, label: size > 1 ? `${label}[${i}]` : (label || `tmp_${base + i}`) };
    }
    return base;
  }

  function defConst(val) {
    const n = Number(val) | 0;
    if (consts.has(n)) return consts.get(n);
    const addr = alloc(1, 'rodata', `const(${n})`);
    initMem[addr] = n;
    consts.set(n, addr);
    return addr;
  }

  function getVar(name) {
    if (!(name in sym)) sym[name] = { addr: alloc(1, 'bss', name), dims: null, isRef: false };
    return sym[name];
  }

  const peek = () => (pos < tokens.length ? tokens[pos] : null);

  function eat(expected = null) {
    if (pos >= tokens.length) throw new SyntaxError('Unexpected end of input');
    const tok = tokens[pos++];
    if (expected && tok !== expected) throw new SyntaxError(`Expected '${expected}', got '${tok}'`);
    return tok;
  }

  function valAddr(opnd) {
    if (opnd.mode === 'DIR') return opnd.addr;
    const tmp = alloc(1);
    code.push(['LOAD_IND', tmp, opnd.addr, 0]);
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
      eat(',');
      const cOff = alloc(1);
      code.push(['*', cOff, valAddr(parseExpr()), defConst(dims[0])]);
      const tot = alloc(1);
      code.push(['+', tot, idx, cOff]);
      idx = tot;
    }
    eat(']');
    const ptr = alloc(1);
    code.push(['+', ptr, dims ? defConst(baseAddr) : baseAddr, idx]);
    return { mode: 'IND', addr: ptr };
  }

  function parseAtom() {
    const t = peek();
    if (t !== null && /^\d+$/.test(t)) return { mode: 'DIR', addr: defConst(eat()) };
    if (t === '-') {
      eat('-');
      const dst = alloc(1);
      code.push(['-', dst, defConst(0), valAddr(parseAtom())]);
      return { mode: 'DIR', addr: dst };
    }
    if (t === '(') { eat('('); const e = parseExpr(); eat(')'); return e; }
    return parseLValue();
  }

  function parseExpr(minPrec = 0) {
    let lhs = parseAtom();
    while (peek() !== null && peek() in PREC && PREC[peek()] >= minPrec) {
      const op = eat();
      const rhs = parseExpr(PREC[op] + 1);
      const dst = alloc(1);
      code.push([op, dst, valAddr(lhs), valAddr(rhs)]);
      lhs = { mode: 'DIR', addr: dst };
    }
    return lhs;
  }

  function parseBlock() {
    while (peek() !== null && peek() !== 'END' && peek() !== 'ELSE') {
      const tok = peek();
      if (tok === 'DIM') {
        eat('DIM');
        const { name, dims } = parseDecl();
        const size = dims ? dims[0] * (dims[1] ?? 1) : 1;
        sym[name] = { addr: alloc(size, 'bss', name), dims, isRef: false };
      } else if (tok === 'EQUIV') {
        eat('EQUIV');
        const { name, dims } = parseDecl();
        eat('=');
        sym[name] = { addr: sym[eat()].addr, dims, isRef: false };
      } else if (tok === 'PRINT') {
        eat('PRINT');
        code.push(['PRINT', valAddr(parseExpr()), 0, 0]);
      } else if (tok === 'IF') {
        eat('IF');
        const cond = valAddr(parseExpr());
        eat('THEN');
        const jzIdx = code.length;
        code.push(['JZ', 0, cond, 0]);
        parseBlock();
        if (peek() === 'ELSE') {
          eat('ELSE');
          const jmpIdx = code.length;
          code.push(['JMP', 0, 0, 0]);
          code[jzIdx] = ['JZ', code.length, cond, 0];
          parseBlock();
          code[jmpIdx] = ['JMP', code.length, 0, 0];
        } else {
          code[jzIdx] = ['JZ', code.length, cond, 0];
        }
        eat('END');
      } else if (tok === 'DO') {
        eat('DO');
        const vAddr = getVar(eat()).addr;
        eat('=');
        const start = valAddr(parseExpr());
        eat(',');
        const stop = valAddr(parseExpr());
        code.push(['MOV', vAddr, start, 0]);
        const loopTop = code.length;
        const cmpTmp = alloc(1);
        code.push(['<=', cmpTmp, vAddr, stop]);
        const exitIdx = code.length;
        code.push(['JZ', 0, cmpTmp, 0]);
        parseBlock();
        eat('END');
        code.push(['+', vAddr, vAddr, defConst(1)]);
        code.push(['JMP', loopTop, 0, 0]);
        code[exitIdx] = ['JZ', code.length, cmpTmp, 0];
      } else if (tok === 'SUB') {
        eat('SUB');
        const name = eat();
        eat('(');
        const savedSym = { ...sym };
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
        const skipIdx = code.length;
        code.push(['JMP', 0, 0, 0]);
        subs[name] = { entryIp: code.length, retSlot, params };
        parseBlock();
        eat('END');
        sym = savedSym;
        code.push(['JMP_IND', retSlot, 0, 0]);
        code[skipIdx] = ['JMP', code.length, 0, 0];
      } else if (tok === 'CALL') {
        eat('CALL');
        const name = eat();
        eat('(');
        const sub = subs[name];
        for (let i = 0; i < sub.params.length; i++) {
          if (i > 0) eat(',');
          code.push(['MOV', sub.params[i], ptrAddr(parseExpr()), 0]);
        }
        eat(')');
        code.push(['JAL', sub.retSlot, sub.entryIp, 0]);
      } else {
        const lhs = parseLValue();
        eat('=');
        const rhs = valAddr(parseExpr());
        code.push([lhs.mode === 'IND' ? 'STORE_IND' : 'MOV', lhs.addr, rhs, 0]);
      }
    }
  }

  parseBlock();
  return { code, initMem, usedCells: nextMem, cells: cells.slice(0, nextMem), sym, subs };
}
