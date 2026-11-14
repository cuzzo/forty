import { MEM_WORDS, encode, tagged } from './vm.js';

// Puck v4's tokenizer, ported from examples/puck/v4/tokenizer.rb. Each token also keeps its line, for the page.
const KEYWORDS = new Set(['PROCEDURE', 'RETURN', 'IF', 'THEN', 'LOOP', 'EXIT', 'END', 'SYSCALL']);

export function tokenize(code) {
  const tokens = [];
  const re = /\s+|\d+|:=|[()+\-*/%=,;]|[a-zA-Z_]\w*/y;
  let line = 1;
  while (re.lastIndex < code.length) {
    const at = re.lastIndex;
    const match = re.exec(code);
    if (!match) throw new SyntaxError(`Unexpected character ${JSON.stringify(code[at])} at position ${at}`);
    const text = match[0];
    if (/^\s/.test(text)) line += text.split('\n').length - 1;
    else if (/^\d/.test(text)) tokens.push({ type: 'INTEGER', value: Number(text), line });
    else if (/^\w/.test(text)) tokens.push({ type: KEYWORDS.has(text) ? text : 'SYMBOL', value: text, line });
    else tokens.push({ type: 'OPERATOR', value: text, line });
  }
  return tokens;
}

// The operators of an expression. Only operator tokens have these values.
const EXPRESSION_OPERATORS = new Set(['+', '-', '*', '/', '%', '=']);

// Puck v4's parser, ported from examples/puck/v4/parser.rb, one function per statement. Nodes also keep their line,
// and a block its END's line.
export function parse(tokens) {
  let pos = 0;

  function consume(type) {
    const t = tokens[pos++];
    if (t?.type !== type) throw new SyntaxError(`Expected ${type}`);
    return t;
  }

  function parseStatements(stopType = null) {
    const nodes = [];
    while (pos < tokens.length && tokens[pos].type !== stopType) nodes.push(parseStatement());
    return nodes;
  }

  function parseStatement() {
    const parser = STATEMENTS[tokens[pos].type];
    if (!parser) throw new SyntaxError(`Unexpected token ${JSON.stringify(tokens[pos])}`);
    return parser();
  }

  function parseProcedure() {
    const { line } = consume('PROCEDURE');
    const name = consume('SYMBOL').value;
    const params = parseParams();
    consume('OPERATOR'); // ;
    const body = parseStatements('END');
    const endLine = consume('END').line;
    consume('OPERATOR'); // ;
    return { type: 'Procedure', var: name, val: { params, body }, line, endLine };
  }

  function parseIf() {
    const { line } = consume('IF');
    const condition = parseExpression();
    consume('THEN');
    const body = parseStatements('END');
    consume('END');
    consume('OPERATOR'); // ;
    return { type: 'If', val: { condition, body }, line };
  }

  function parseLoop() {
    const { line } = consume('LOOP');
    const body = parseStatements('END');
    const endLine = consume('END').line;
    consume('OPERATOR'); // ;
    return { type: 'Loop', val: body, line, endLine };
  }

  function parseExit() {
    const { line } = consume('EXIT');
    consume('OPERATOR'); // ;
    return { type: 'Exit', line };
  }

  function parseReturn() {
    const { line } = consume('RETURN');
    const expression = parseExpression();
    consume('OPERATOR'); // ;
    return { type: 'Return', val: expression, line };
  }

  function parseSyscall() {
    const { line } = consume('SYSCALL');
    consume('OPERATOR'); // (
    const id = consume('INTEGER').value;
    consume('OPERATOR'); // ,
    const name = consume('SYMBOL').value;
    consume('OPERATOR'); // )
    consume('OPERATOR'); // ;
    return { type: 'Syscall', var: name, val: id, line };
  }

  // A statement that starts with a name: an assignment, or a call.
  function parseNamed() {
    const { value: name, line } = consume('SYMBOL');
    if (tokens[pos].value === ':=') {
      consume('OPERATOR'); // :=
      const val = parseExpression();
      consume('OPERATOR'); // ;
      return { type: 'Assignment', var: name, val, line };
    }
    const args = parseCallArgs();
    consume('OPERATOR'); // ;
    return { type: 'CallStatement', var: name, val: args, line };
  }

  function parseParams() {
    const params = [];
    consume('OPERATOR'); // (
    if (tokens[pos].value !== ')') {
      params.push(consume('SYMBOL').value);
      while (tokens[pos].value === ',') {
        consume('OPERATOR'); // ,
        params.push(consume('SYMBOL').value);
      }
    }
    consume('OPERATOR'); // )
    return params;
  }

  function parseCallArgs() {
    const args = [];
    consume('OPERATOR'); // (
    if (tokens[pos].value !== ')') {
      args.push(parseExpression());
      while (tokens[pos].value === ',') {
        consume('OPERATOR'); // ,
        args.push(parseExpression());
      }
    }
    consume('OPERATOR'); // )
    return args;
  }

  // Puck has no operator precedence: an expression runs left to right.
  function parseExpression() {
    let expression = parseTerm();
    while (EXPRESSION_OPERATORS.has(tokens[pos]?.value)) {
      const op = consume('OPERATOR').value;
      expression = { type: op === '=' ? 'Equal' : 'Math', value: op, left: expression, right: parseTerm() };
    }
    return expression;
  }

  function parseTerm() {
    if (tokens[pos].type === 'INTEGER') return { type: 'Integer', value: consume('INTEGER').value };
    if (tokens[pos].type !== 'SYMBOL') {
      throw new SyntaxError(`Unexpected expression token ${JSON.stringify(tokens[pos])}`);
    }
    const name = consume('SYMBOL').value;
    if (tokens[pos]?.value === '(') return { type: 'Call', name, args: parseCallArgs() };
    return { type: 'Variable', name };
  }

  // Each statement's parser, by its first token: a keyword, or a name.
  const STATEMENTS = {
    PROCEDURE: parseProcedure,
    IF: parseIf,
    LOOP: parseLoop,
    EXIT: parseExit,
    RETURN: parseReturn,
    SYSCALL: parseSyscall,
    SYMBOL: parseNamed,
  };

  return parseStatements();
}

// The code generator, in place of Puck's stack-machine compiler: v6's one-address 704 code, using all five registers.
// The AC holds the value being worked out, and the MQ a product or quotient. Index register C holds the running
// procedure's frame, so slot k of a frame is the one operand k,C; B holds the return address a call leaves.
const C = 2;
const B = 1;

function at(slot) {
  if (slot > 255) throw new RangeError(`A frame of ${slot + 1} words does not fit in an address's 8 bits`);
  return tagged(slot, C);
}

// A frame is [ret, link, the parameters and locals by name], with temporaries above them. top is its first free
// slot; size, the most it has used.
const frame = (name, params) => ({ name, names: [...params], top: 2 + params.length, size: 2 + params.length });

// A frame's slot names, for the page: its temporaries are all named tmp.
function slotNames({ name, names, size, entry }) {
  const temporaries = Array(size - 2 - names.length).fill('tmp');
  return { name, entry, slots: ['ret', 'link', ...names, ...temporaries] };
}

export function compile(source) {
  return build(source, build(source, 0).codeLen);
}

function build(source, dataBase) {
  const ast = parse(tokenize(source));
  const initMem = new Int32Array(MEM_WORDS);
  const refs = Array.from({ length: MEM_WORDS }, () => new Set());
  const consts = new Map();
  const code = [];
  const ipMap = [];
  const events = [];
  const procs = [];
  let nextMem = dataBase;
  let line = 1;
  // The value the AC holds, if any: a place that becomes a slot if the AC must be stored to make room.
  let acHolds = null;

  function touch(addr) {
    refs[addr].add(line);
  }

  function alloc(role, label) {
    if (nextMem + 1 > MEM_WORDS) throw new Error(`Program does not fit in ${MEM_WORDS} cells of RAM`);
    touch(nextMem);
    events.push({ kind: 'alloc', base: nextMem, size: 1, line, role, label });
    return nextMem++;
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

  function defConst(n) {
    if (!consts.has(n)) {
      consts.set(n, alloc('rodata', `const(${n})`));
      initMem[consts.get(n)] = n;
    }
    touch(consts.get(n));
    return consts.get(n);
  }

  const baseCell = alloc('rodata', 'stack base');
  const main = frame('main', []);

  function claim(f, slots) {
    const slot = f.top;
    f.top += slots;
    f.size = Math.max(f.size, f.top);
    return slot;
  }

  function slotOf(f, name) {
    const k = f.names.indexOf(name);
    if (k < 0) throw new Error(`key not found: "${name}"`);
    return 2 + k;
  }

  const cell = (addr) => ({ mode: 'MEM', addr });
  const inAC = () => (acHolds = { mode: 'AC' });

  // Store the AC's value in a temporary, so the AC can be used again: the place it held now names that slot.
  function spill(f) {
    if (!acHolds) return;
    const t = at(claim(f, 1));
    emit('STO', t);
    Object.assign(acHolds, cell(t));
    acHolds = null;
  }

  function load(place, f) {
    if (place.mode === 'AC') return;
    spill(f);
    emit('CLA', place.addr);
  }

  // The address holding a place's value: a value in the AC is stored to a temporary first.
  function operand(place, f) {
    if (place.mode === 'AC') spill(f);
    return place.addr;
  }

  // Where an expression's value is: a constant's cell, a variable's slot, a temporary, or the AC.
  function value(e, f) {
    if (e.type === 'Integer') return cell(defConst(e.value));
    if (e.type === 'Variable') return cell(at(slotOf(f, e.name)));
    if (e.type === 'Call') {
      call(e, f);
      return inAC();
    }
    return ARITHMETIC[e.value](value(e.left, f), value(e.right, f), f);
  }

  function addOrSubtract(op, l, r, f) {
    const b = operand(r, f);
    load(l, f);
    emit(op, b);
    return inAC();
  }

  // LDQ l, then MPY r leaves the product in the MQ; a cleared AC and DVP r, the quotient in the MQ and the
  // remainder in the AC.
  function multiplyOrDivide(op, l, r, f) {
    const b = operand(r, f);
    const a = operand(l, f);
    spill(f);
    emit('LDQ', a);
    if (op === '*') {
      emit('MPY', b);
    } else {
      emit('CLA', defConst(0));
      emit('DVP', b);
    }
    if (op === '%') return inAC();
    const t = at(claim(f, 1));
    emit('STQ', t);
    return cell(t);
  }

  // The 704 has no compare that leaves a value: subtract, and load 1 if that left 0, else 0.
  function equal(l, r, f) {
    addOrSubtract('SUB', l, r, f);
    const toEqual = emit('TZE');
    emit('CLA', defConst(0));
    const toEnd = emit('TRA');
    patch(toEqual, code.length);
    emit('CLA', defConst(1));
    patch(toEnd, code.length);
    return inAC();
  }

  const ARITHMETIC = {
    '+': (l, r, f) => addOrSubtract('ADD', l, r, f),
    '-': (l, r, f) => addOrSubtract('SUB', l, r, f),
    '*': (l, r, f) => multiplyOrDivide('*', l, r, f),
    '/': (l, r, f) => multiplyOrDivide('/', l, r, f),
    '%': (l, r, f) => multiplyOrDivide('%', l, r, f),
    '=': equal,
  };

  // An IF's test, leaving the transfer to take when it is false. An = test subtracts: 0 means equal.
  function condition(e, f) {
    if (e.type === 'Equal') {
      addOrSubtract('SUB', value(e.left, f), value(e.right, f), f);
      return emit('TNZ');
    }
    load(value(e, f), f);
    return emit('TZE');
  }

  // The AC does not survive a call, so a value in it is stored first. The callee's frame starts at the caller's
  // first free slot, [ret, link, args], and its arguments are worked out straight into it. Then C moves to the new
  // frame, and TSX leaves the call's own address in B and jumps. The result comes back in the AC.
  function call(e, f) {
    const proc = procs.find((p) => p.name === e.name);
    if (!proc) throw new Error(`key not found: "${e.name}"`);
    spill(f);
    const base = claim(f, 2 + e.args.length);
    e.args.forEach((arg, i) => {
      load(value(arg, f), f);
      emit('STO', at(base + 2 + i));
      acHolds = null;
    });
    emit('SXD', at(base + 1), 0, C);
    emit('TXI', code.length + 1, base, C);
    emit('TSX', proc.entry, 0, B);
    emit('LXD', at(1), 0, C);
    f.top = base;
  }

  // Back to the instruction after the call: B = ret, then TRA 1,B.
  function returnFromCall() {
    emit('LXD', at(0), 0, B);
    emit('TRA', tagged(1, B));
  }

  function statements(nodes, f, exits) {
    for (const node of nodes) statement(node, f, exits);
  }

  function statement(node, f, exits) {
    line = node.line;
    // A statement's temporaries die with it, and so does the value in the AC.
    f.top = 2 + f.names.length;
    acHolds = null;
    STATEMENTS[node.type](node, f, exits);
  }

  function compileProcedure(node) {
    const skip = emit('TRA');
    // Registered before its body, so that the body can call it: Puck v4 registered it after, and could not recurse.
    const proc = { ...frame(node.var, node.val.params), entry: code.length };
    procs.push(proc);
    // The return address goes into the frame, as the body's own calls will reuse B.
    emit('SXD', at(0), 0, B);
    statements(node.val.body, proc, null);
    line = node.endLine;
    returnFromCall();
    patch(skip, code.length);
  }

  function compileAssignment(node, f) {
    const known = f.names.indexOf(node.var);
    // As in Puck, a new variable is named only after its value is worked out, so it cannot be read in it.
    const slot = known >= 0 ? 2 + known : claim(f, 1);
    load(value(node.val, f), f);
    emit('STO', at(slot));
    if (known < 0) f.names.push(node.var);
  }

  function compileCall(node, f) {
    call({ name: node.var, args: node.val }, f);
  }

  function compileIf(node, f, exits) {
    const toEnd = condition(node.val.condition, f);
    statements(node.val.body, f, exits);
    patch(toEnd, code.length);
  }

  function compileLoop(node, f) {
    const top = code.length;
    const ends = [];
    statements(node.val, f, ends);
    line = node.endLine;
    emit('TRA', top);
    for (const ip of ends) patch(ip, code.length);
  }

  function compileExit(node, f, exits) {
    if (!exits) throw new Error('EXIT outside LOOP');
    exits.push(emit('TRA'));
  }

  function compileReturn(node, f) {
    load(value(node.val, f), f);
    // The main program's RETURN ends it, as Puck's VM returns from running it.
    if (f === main) emit('HALT');
    else returnFromCall();
  }

  function compileSyscall(node, f) {
    emit('PRINT', at(slotOf(f, node.var)));
  }

  // Each statement's code, by its node type in Puck v4's tree.
  const STATEMENTS = {
    Procedure: compileProcedure,
    Assignment: compileAssignment,
    CallStatement: compileCall,
    If: compileIf,
    Loop: compileLoop,
    Exit: compileExit,
    Return: compileReturn,
    Syscall: compileSyscall,
  };

  emit('LXD', baseCell, 0, C);
  statements(ast, main, null);
  emit('HALT');
  // The stack starts where the data ends; main's frame there has ret and link 0, and link 0 ends the chain.
  initMem[baseCell] = nextMem;
  code.forEach((instr, ip) => { initMem[ip] = encode(instr); });
  return {
    code,
    codeLen: code.length,
    initMem,
    usedCells: nextMem,
    cellLines: refs,
    ipMap,
    events,
    regLoops: [],
    stackBase: nextMem,
    main: slotNames(main),
    procs: procs.map(slotNames),
  };
}
