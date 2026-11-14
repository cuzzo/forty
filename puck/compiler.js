import { MEM_WORDS, encode } from './vm.js';

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

// Puck v4's parser, ported from examples/puck/v4/parser.rb. Nodes also keep their line, and a block's END line.
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
    const { type, line } = tokens[pos];
    if (type === 'PROCEDURE') return parseProcedure();
    if (type === 'IF') return parseIf();
    if (type === 'LOOP') return parseLoop();
    if (type === 'EXIT') {
      consume('EXIT');
      consume('OPERATOR'); // ;
      return { type: 'Exit', line };
    }
    if (type === 'RETURN') {
      consume('RETURN');
      const expression = parseExpression();
      consume('OPERATOR'); // ;
      return { type: 'Return', val: expression, line };
    }
    if (type === 'SYSCALL') {
      consume('SYSCALL');
      consume('OPERATOR'); // (
      const id = consume('INTEGER').value;
      consume('OPERATOR'); // ,
      const name = consume('SYMBOL').value;
      consume('OPERATOR'); // )
      consume('OPERATOR'); // ;
      return { type: 'Syscall', var: name, val: id, line };
    }
    if (type === 'SYMBOL') {
      const name = consume('SYMBOL').value;
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
    throw new SyntaxError(`Unexpected token ${JSON.stringify(tokens[pos])}`);
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
    while (tokens[pos]?.type === 'OPERATOR' && ['+', '-', '*', '/', '%', '='].includes(tokens[pos].value)) {
      const op = consume('OPERATOR').value;
      expression = { type: op === '=' ? 'Equal' : 'Math', value: op, left: expression, right: parseTerm() };
    }
    return expression;
  }

  function parseTerm() {
    if (tokens[pos].type === 'INTEGER') return { type: 'Integer', value: consume('INTEGER').value };
    if (tokens[pos].type === 'SYMBOL') {
      const name = consume('SYMBOL').value;
      if (tokens[pos]?.type === 'OPERATOR' && tokens[pos].value === '(') return { type: 'Call', name, args: parseCallArgs() };
      return { type: 'Variable', name };
    }
    throw new SyntaxError(`Unexpected expression token ${JSON.stringify(tokens[pos])}`);
  }

  return parseStatements();
}

// The code generator, in place of Puck's stack-machine compiler: v5 4-tuples with the call stack in core memory.
// Index register C holds the running procedure's frame, so slot k of a frame is the one operand k,C.
const C = 2;
const ALU_OP = { '+': '+', '-': '-', '*': '*', '/': '/', '%': '%', '=': '==' };

function at(slot) {
  if (slot > 127) throw new RangeError(`A frame of ${slot + 1} words does not fit in an operand's 7 address bits`);
  return slot | ((C + 1) << 7);
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
  const RET = alloc('linkage', 'RET');

  // A frame is [ret, link, the parameters and locals by name], with temporaries above them. top is its first free
  // slot; size, the most it has used.
  const frame = (name, params) => ({ name, names: [...params], top: 2 + params.length, size: 2 + params.length });

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

  // The operand holding an expression's value: a constant's cell, a variable's slot, or a temporary in the frame.
  function value(e, f) {
    if (e.type === 'Integer') return defConst(e.value);
    if (e.type === 'Variable') return at(slotOf(f, e.name));
    const t = at(claim(f, 1));
    into(e, t, f);
    return t;
  }

  function into(e, dest, f) {
    if (e.type === 'Math' || e.type === 'Equal') emit(ALU_OP[e.value], dest, value(e.left, f), value(e.right, f));
    else if (e.type === 'Call') {
      call(e, f);
      if (dest !== RET) emit('MOV', dest, RET);
    } else emit('MOV', dest, value(e, f));
  }

  // The callee's frame starts at the caller's first free slot. Its header and arguments are claimed before the
  // arguments are worked out, so a call inside an argument puts its own frame above them.
  function call(e, f) {
    const proc = procs.find((p) => p.name === e.name);
    if (!proc) throw new Error(`key not found: "${e.name}"`);
    const base = claim(f, 2 + e.args.length);
    e.args.forEach((arg, i) => into(arg, at(base + 2 + i), f));
    emit('PXD', at(base + 1), C);
    emit('TXI', code.length + 1, base, C);
    emit('JAL', at(0), proc.entry);
    emit('LXD', C, at(1));
    f.top = base;
  }

  function statements(nodes, f, exits) {
    for (const node of nodes) statement(node, f, exits);
  }

  function statement(node, f, exits) {
    line = node.line;
    // A statement's temporaries die with it.
    f.top = 2 + f.names.length;
    if (node.type === 'Procedure') {
      const skip = emit('JMP');
      // Registered before its body, so that the body can call it: Puck v4 registered it after, and could not recurse.
      const proc = { ...frame(node.var, node.val.params), entry: code.length };
      procs.push(proc);
      statements(node.val.body, proc, null);
      line = node.endLine;
      emit('JMP_IND', at(0));
      patch(skip, code.length);
    } else if (node.type === 'Assignment') {
      // As in Puck, a new variable is named only after its value is worked out, so it cannot be read in it.
      const known = f.names.indexOf(node.var);
      const slot = known < 0 ? claim(f, 1) : 2 + known;
      into(node.val, at(slot), f);
      if (known < 0) f.names.push(node.var);
    } else if (node.type === 'CallStatement') {
      call({ name: node.var, args: node.val }, f);
    } else if (node.type === 'If') {
      const toEnd = emit('JZ', 0, value(node.val.condition, f));
      statements(node.val.body, f, exits);
      patch(toEnd, code.length);
    } else if (node.type === 'Loop') {
      const top = code.length;
      const ends = [];
      statements(node.val, f, ends);
      line = node.endLine;
      emit('JMP', top);
      for (const ip of ends) patch(ip, code.length);
    } else if (node.type === 'Exit') {
      if (!exits) throw new Error('EXIT outside LOOP');
      exits.push(emit('JMP'));
    } else if (node.type === 'Return') {
      into(node.val, RET, f);
      // The main program's RETURN ends it, as Puck's VM returns from running it.
      if (f === main) emit('HALT');
      else emit('JMP_IND', at(0));
    } else if (node.type === 'Syscall') {
      emit('PRINT', at(slotOf(f, node.var)));
    }
  }

  const main = frame('main', []);
  emit('LXD', C, baseCell);
  statements(ast, main, null);
  emit('HALT');
  // The stack starts where the data ends; main's frame there has ret and link 0, and link 0 ends the chain.
  initMem[baseCell] = nextMem;
  code.forEach((instr, ip) => { initMem[ip] = encode(instr); });
  const named = ({ name, names, size, entry }) => ({ name, entry, slots: ['ret', 'link', ...names, ...Array(size - 2 - names.length).fill('tmp')] });
  return {
    code, codeLen: code.length, initMem, usedCells: nextMem, cellLines: refs, ipMap, events, regLoops: [],
    stackBase: nextMem, main: named(main), procs: procs.map(named),
  };
}
