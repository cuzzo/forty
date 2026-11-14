import { MEM_WORDS, tagged } from './vm.js';
import { PRINTED, interpreter } from './interpreter.js';

// Data memory, in order: NIL (a cell whose car and cdr are both NIL), named cells and constants; symbols, two words
// each, [name, global value]; cons cells, two words each, [car, cdr], the program's first and the rest on the free
// list; one mark word per cons cell, for the collector; and the stack.
export const SYM_BASE = 64;
export const CONS_BASE = 192;
export const CONS_END = 384;
export const MARK_BASE = 384;
export const STACK_BASE = 480;

// Symbols the interpreter uses: true, the special forms and the primitives, besides the ones print emits.
const PRIMITIVES = ['CAR', 'CDR', 'CONS', 'ATOM', 'EQ', '+', '-', '*', '<'];
const BUILT_IN = ['T', 'QUOTE', 'IF', 'LAMBDA', 'DEFINE', ...PRIMITIVES];

export function tokenize(source) {
  const tokens = [];
  const re = /\s+|;[^\n]*|[()']|[^\s()';]+/y;
  let line = 1;
  while (re.lastIndex < source.length) {
    const text = re.exec(source)[0];
    if (/^\s/.test(text)) line += text.split('\n').length - 1;
    else if (text[0] !== ';') tokens.push({ text, line });
  }
  return tokens;
}

// The program's expressions: a number, a symbol's name (upper case, as LISP 1.5 wrote them), or a list,
// { items, tail, line }, whose tail is NIL unless it is written dotted, (a . b). 'x reads as (QUOTE x).
export function read(tokens) {
  let pos = 0;

  function expression() {
    const token = tokens[pos++];
    if (!token) throw new SyntaxError('A ( is never closed');
    if (token.text === ')') throw new SyntaxError(`Unexpected ) on line ${token.line}`);
    if (token.text === "'") return { items: ['QUOTE', expression()], tail: 'NIL', line: token.line };
    if (token.text === '(') return readList(token.line);
    return /^-?\d+$/.test(token.text) ? Number(token.text) : token.text.toUpperCase();
  }

  // The rest of a list, after its (. A . before the last item makes that item its tail.
  function readList(line) {
    const items = [];
    let tail = 'NIL';
    while (tokens[pos]?.text !== ')') {
      if (tokens[pos]?.text === '.' && items.length) {
        pos++;
        tail = expression();
        if (tokens[pos]?.text !== ')') throw new SyntaxError(`Expected ) after the dotted tail on line ${line}`);
      } else {
        items.push(expression());
      }
    }
    pos++;
    return { items, tail, line };
  }

  const forms = [];
  while (pos < tokens.length) forms.push(expression());
  return forms;
}

// Routines assembled into v5 4-tuples. A routine's frame is [ret, link, its parameters, its locals], and index
// register C holds the running routine's frame, so each slot is the one operand k,C. Calls use Puck's sequence.
function assembler({ RET, TMP, ZERO, ONE }) {
  const C = 2;
  const code = [];
  const labels = {};
  const procs = [];
  let current = null;
  const local = (name) => ({ label: `${current.name}.${name}` });
  const op = (name, a = 0, b = 0, c = 0) => code.push([name, a, b, c]);

  return {
    op,
    routine(name, params, locals, body) {
      current = { name, entry: code.length, slots: ['ret', 'link', ...params, ...locals] };
      procs.push(current);
      labels[name] = code.length;
      body(Object.fromEntries(current.slots.map((slot, k) => [slot, tagged(k, C)])));
    },
    label: (name) => { labels[local(name).label] = code.length; },
    jmp: (name) => op('JMP', local(name)),
    ifZero: (x, name) => op('JZ', local(name), x),
    ifNonZero(x, name) {
      op('==', TMP, x, ZERO);
      op('JZ', local(name), TMP);
    },
    car: (dest, x) => op('LOAD_IND', dest, x),
    cdr(dest, x) {
      op('+', TMP, x, ONE);
      op('LOAD_IND', dest, TMP);
    },
    setCar: (x, value) => op('STORE_IND', x, value),
    setCdr(x, value) {
      op('+', TMP, x, ONE);
      op('STORE_IND', TMP, value);
    },
    // The callee's frame starts just above the caller's; the result comes back in RET.
    call(name, ...args) {
      const base = current.slots.length;
      args.forEach((arg, i) => op('MOV', tagged(base + 2 + i, C), arg));
      op('PXD', tagged(base + 1, C), C);
      op('TXI', code.length + 1, base, C);
      op('JAL', tagged(0, C), { label: name });
      op('LXD', C, tagged(1, C));
    },
    ret(value) {
      if (value !== undefined) op('MOV', RET, value);
      op('JMP_IND', tagged(0, C));
    },
    finish() {
      const resolve = (x) => {
        if (x?.label === undefined) return x;
        if (!(x.label in labels)) throw new Error(`No label ${x.label}`);
        return labels[x.label];
      };
      return { code: code.map((instr) => instr.map(resolve)), procs, labels };
    },
  };
}

export function compile(source) {
  const forms = read(tokenize(source));
  const initMem = new Int32Array(MEM_WORDS);
  const refs = Array.from({ length: MEM_WORDS }, () => new Set());
  const lines = [];
  const events = [];
  const symbols = new Map();
  const consts = new Map();
  let nextNamed = 2;
  let nextSymbol = SYM_BASE;
  let nextCons = CONS_BASE;

  const alloc = (base, role, label, line = 0) => events.push({ kind: 'alloc', base, size: 1, line, role, label });

  function named(label, value = 0, role = 'scratch') {
    if (nextNamed === SYM_BASE) throw new Error('Too many named cells');
    initMem[nextNamed] = value;
    alloc(nextNamed, role, label);
    return nextNamed++;
  }

  function constant(value, label = `const(${value})`) {
    if (!consts.has(value)) consts.set(value, named(label, value, 'rodata'));
    return consts.get(value);
  }

  function symbol(name, line = 0) {
    if (!symbols.has(name)) {
      if (nextSymbol === CONS_BASE) throw new Error('Too many symbols');
      symbols.set(name, nextSymbol);
      alloc(nextSymbol, 'bss', name.trim());
      alloc(nextSymbol + 1, 'bss', `${name.trim()} value`);
      nextSymbol += 2;
    }
    refs[symbols.get(name)].add(line);
    return symbols.get(name);
  }

  function consCell(line) {
    if (nextCons === CONS_END) throw new Error('The program does not fit in its cons cells');
    const cell = nextCons;
    nextCons += 2;
    lines[cell] = line;
    refs[cell].add(line);
    refs[cell + 1].add(line);
    return cell;
  }

  // An expression as the machine holds it: NIL is 0, an integer n is 2n + 1, and a symbol or a list is the address of
  // its first cell. A list's cells are laid out in reading order.
  function place(x, line) {
    if (typeof x === 'number') return 2 * x + 1;
    if (typeof x === 'string') return x === 'NIL' ? 0 : symbol(x, line);
    const spine = x.items.map(() => consCell(x.line));
    x.items.forEach((item, i) => {
      initMem[spine[i]] = place(item, x.line);
      initMem[spine[i] + 1] = spine[i + 1] ?? place(x.tail, x.line);
    });
    return spine[0] ?? 0;
  }

  alloc(0, 'rodata', 'NIL car');
  alloc(1, 'rodata', 'NIL cdr');
  for (const name of [...BUILT_IN, ...Object.values(PRINTED)]) symbol(name);
  // True and the primitives evaluate to themselves.
  for (const name of ['T', ...PRIMITIVES]) initMem[symbols.get(name) + 1] = symbols.get(name);
  const program = place({ items: forms, tail: 'NIL', line: 1 });

  // The free list: every cons cell the program does not use, each one's cdr naming the next.
  for (let cell = nextCons; cell < CONS_END; cell += 2) initMem[cell + 1] = cell + 2 < CONS_END ? cell + 2 : 0;
  for (let cell = CONS_BASE; cell < CONS_END; cell++) alloc(cell, 'cons', cell % 2 ? 'cdr' : 'car', lines[cell - (cell % 2)]);
  for (let i = 0; i < (CONS_END - CONS_BASE) / 2; i++) alloc(MARK_BASE + i, 'mark', `mark ${CONS_BASE + 2 * i}`);

  const cells = {
    RET: named('RET', 0, 'linkage'),
    TMP: named('TMP'),
    FREE: named('FREE', nextCons < CONS_END ? nextCons : 0, 'linkage'),
    PROGRAM: named('PROGRAM', program, 'linkage'),
    ZERO: 0,
    NIL: 0,
    ONE: constant(1),
    TWO: constant(2),
    SYM_BASE: constant(SYM_BASE),
    SYM_END: constant(nextSymbol, 'symbols end'),
    CONS_BASE: constant(CONS_BASE),
    CONS_END: constant(CONS_END),
    CONS_LAST: constant(CONS_END - 2),
    MARK_BASE: constant(MARK_BASE),
    STACK_BASE: constant(STACK_BASE),
    sym: (name) => constant(symbols.get(name), `'${name.trim()}`),
  };
  const asm = assembler(cells);
  interpreter(asm, cells);
  const { code, procs, labels } = asm.finish();
  code.forEach((instr, ip) => events.push({ kind: 'emit', ip, instr, line: null }));

  return {
    code,
    initMem,
    usedCells: STACK_BASE,
    cellLines: refs,
    lines,
    ipMap: code.map(() => null),
    events,
    regLoops: [],
    stackBase: STACK_BASE,
    main: procs[0],
    procs: procs.slice(1),
    evalEntry: labels.eval,
    symbolNames: Object.fromEntries([...symbols].map(([name, addr]) => [addr, name])),
    consBase: CONS_BASE,
    newline: symbols.get(PRINTED.newline),
  };
}
