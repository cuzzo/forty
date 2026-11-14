import test from 'node:test';
import assert from 'node:assert/strict';
import { CONS_BASE, CONS_END, STACK_BASE, compile, read, tokenize } from './compiler.js';
import { createVM } from './vm.js';
import {
  DEMOS, effect, layout, lispLine, lispStep, lispText, lispValue, printedLines, stackLabels, stepper,
} from './visualizer.js';

const C = 2;

// Runs a program to the end, returning what it printed and the deepest frame it reached.
function run(source) {
  const prog = compile(source);
  const vm = createVM(prog.code, prog.initMem, false);
  let deepest = 0;
  let collections = 0;
  const collect = prog.procs.find((p) => p.name === 'collect').entry;
  while (!vm.getState().halted) {
    vm.step();
    deepest = Math.max(deepest, vm.getState().XR[C]);
    if (vm.getState().ip === collect) collections++;
  }
  return { prog, state: vm.getState(), lines: printedLines(prog, vm.getState().stdout), deepest, collections };
}

// The same Lisp in JavaScript, with host objects for cons cells and environments, to check the machine against.
function reference(source) {
  const PRIMITIVES = {
    CAR: (a) => a?.car ?? null,
    CDR: (a) => a?.cdr ?? null,
    CONS: (a, b) => ({ car: a, cdr: b }),
    ATOM: (a) => (a === null || typeof a !== 'object' ? 'T' : null),
    EQ: (a, b) => (a === b ? 'T' : null),
    '+': (a, b) => a + b,
    '-': (a, b) => a - b,
    '*': (a, b) => a * b,
    '<': (a, b) => (a < b ? 'T' : null),
  };
  const globals = new Map([['T', 'T'], ...Object.keys(PRIMITIVES).map((name) => [name, name])]);
  const value = (x) => {
    if (typeof x === 'number') return x;
    if (typeof x === 'string') return x === 'NIL' ? null : x;
    return x.items.reduceRight((cdr, item) => ({ car: value(item), cdr }), value(x.tail));
  };
  const list = (v) => (v === null ? [] : [v.car, ...list(v.cdr)]);
  function lookup(name, env) {
    for (let e = env; e; e = e.next) if (e.name === name) return e.value;
    return globals.get(name) ?? null;
  }
  function evaluate(x, env) {
    if (x === null || typeof x === 'number') return x;
    if (typeof x === 'string') return lookup(x, env);
    const [op, a, b, c] = list(x);
    if (op === 'QUOTE') return a;
    if (op === 'IF') return evaluate(evaluate(a, env) !== null ? b : (c ?? null), env);
    if (op === 'LAMBDA') return { closure: x, env };
    if (op === 'DEFINE') return globals.set(a, evaluate(b, env)) && a;
    const f = evaluate(op, env);
    const args = list(x.cdr).map((arg) => evaluate(arg, env));
    if (typeof f === 'string') return PRIMITIVES[f]?.(...args) ?? null;
    const [, params, body] = list(f.closure);
    return evaluate(body, list(params).reduce((next, name, i) => ({ name, value: args[i] ?? null, next }), f.env));
  }
  function show(v) {
    if (v === null) return 'NIL';
    if (typeof v !== 'object') return String(v);
    const items = [];
    for (; v !== null && typeof v === 'object'; v = v.cdr) items.push(show(v.car));
    return `(${items.join(' ')}${v === null ? '' : ` . ${show(v)}`})`;
  }
  return read(tokenize(source)).map((form) => show(evaluate(value(form), null)));
}

const MAP = `(define map (lambda (f l) (if (eq l nil) nil (cons (f (car l)) (map f (cdr l))))))
(map (lambda (x) (* x x)) '(1 2 3 4))`;
const ATOMS = `(atom 'a) (atom '(a)) (atom 7) (eq 'a 'a) (< 3 2) (car nil) (if nil 1 2) (if 'x 1)
'(a . b) (cons 1 '(2 . 3)) (- 0 7) (* -3 4) ''x (cdr '(only))`;

test('lisp prints what a reference Lisp prints, for every demo and more', () => {
  for (const source of [...Object.values(DEMOS).map((demo) => demo.code), MAP, ATOMS]) {
    assert.deepEqual(run(source).lines, reference(source), source);
  }
  assert.deepEqual(run(DEMOS.factorial.code).lines, ['FACT', '120']);
  assert.deepEqual(run(DEMOS.closures.code).lines, ['ADDER', 'ADD3', '7', '15']);
});

test('lisp reads programs into cons cells, which is where its eval finds them', () => {
  const tokens = tokenize("(car 'x) ; note\n7").map((t) => [t.text, t.line]);
  assert.deepEqual(tokens, [['(', 1], ['car', 1], ["'", 1], ['x', 1], [')', 1], ['7', 2]]);
  const [quoted] = read(tokenize("'(a . b)"));
  assert.deepEqual(quoted, { items: ['QUOTE', { items: ['A'], tail: 'B', line: 1 }], tail: 'NIL', line: 1 });
  const prog = layout("(car '(a b))");
  const program = prog.initMem[prog.cells.findIndex((cell) => cell.label === 'PROGRAM')];
  assert.equal(lispText(prog, prog.initMem, program), '((CAR (QUOTE (A B))))');
  assert.ok(program >= CONS_BASE && program < CONS_END);
  const values = [lispValue(prog, 0), lispValue(prog, 2 * -4 + 1), lispValue(prog, program)];
  assert.deepEqual(values, ['NIL', '-4', `@${program}`]);
  for (const [bad, message] of [
    ['(car x', /A \( is never closed/],
    [')', /Unexpected \) on line 1/],
    ['(a . b c)', /Expected \) after the dotted tail on line 1/],
    [Array.from({ length: 60 }, (_, i) => `s${i}`).join(' '), /Too many symbols/],
    [`'(${'(1) '.repeat(100)})`, /The program does not fit in its cons cells/],
  ]) assert.throws(() => compile(bad), message);
});

test('lisp collects garbage when the free list runs out, and runs tail calls in a flat stack', () => {
  const garbage = run(DEMOS.garbage.code);
  assert.deepEqual(garbage.lines, ['COUNT', 'DONE']);
  assert.ok(garbage.collections > 0);
  const deep = run(DEMOS.garbage.code.replace('(count 40)', '(count 300)'));
  assert.deepEqual([deep.lines, deep.deepest], [['COUNT', 'DONE'], garbage.deepest]);
  const kept = run('(define build (lambda (n done) (if (< n 1) done (build (- n 1) (cons n done)))))\n(build 200 nil)');
  assert.equal(kept.lines.at(-1), 'out of memory');
  // Too deep a recursion runs the stack past the end of memory.
  const tooDeep = DEMOS.factorial.code.replace('(fact 5)', '(fact 30)');
  assert.throws(() => run(tooDeep), /Memory address out of bounds: 7[6-9]\d/);
});

test('lisp steps one eval at a time, naming the expression, its line and the frames below it', () => {
  const prog = layout(DEMOS.factorial.code);
  const vm = createVM(prog.code, prog.initMem);
  const nav = stepper(vm, () => 0, lispStep(prog.evalEntry));
  nav.advance();
  assert.equal(vm.getState().ip, prog.evalEntry);
  assert.match(effect(prog, vm.getState()), /^eval \(DEFINE FACT \(LAMBDA \(N\)/);
  assert.equal(lispLine(prog, vm.getState()), 2);
  while (!effect(prog, vm.getState()).startsWith('eval (< N 1)')) nav.advance();
  assert.equal(lispLine(prog, vm.getState()), 4);
  const names = stackLabels(prog, vm.getState());
  assert.equal(names[STACK_BASE], 'main.ret');
  assert.equal(names[vm.getState().XR[C] + 2], 'eval.x');
  const steps = vm.getState().steps;
  nav.advance();
  nav.back();
  assert.equal(vm.getState().steps, steps);
  while (!vm.getState().halted) nav.advance();
  assert.deepEqual(printedLines(prog, vm.getState().stdout), ['FACT', '120']);
});

test('lisp runs on v5\'s instructions kept apart from data, and prints a circular list cut short', () => {
  const prog = layout('(car nil)');
  const vm = createVM(prog.code, prog.initMem);
  assert.equal(lispLine(prog, vm.getState()), null);
  vm.step();
  vm.reset();
  assert.deepEqual([vm.getState().ip, vm.getState().steps, vm.getState().XR[C]], [0, 0, 0]);
  assert.throws(() => createVM([['NOP', 0, 0, 0]], [0]).step(), /Unknown opcode: NOP/);
  assert.throws(() => createVM([['MOV', 0, 0, 0]], [0]).step(), /No instruction at 1/);
  const mem = Int32Array.from(prog.initMem);
  mem[CONS_BASE] = 2 * 1 + 1;
  mem[CONS_BASE + 1] = CONS_BASE;
  assert.match(lispText(prog, mem, CONS_BASE), /^\(1 1 1 .* \. \.\.\.\)$/);
});
