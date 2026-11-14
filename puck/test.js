import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, parse, tokenize } from './compiler.js';
import { MEM_WORDS, createVM } from './vm.js';
import { DEMOS, describe, effect, layout, stackLabels, stepper } from './visualizer.js';

const C = 2;

function run(source, record = false) {
  const prog = compile(source);
  const vm = createVM(prog.initMem, [], [], record);
  while (!vm.getState().halted) vm.step();
  return { prog, vm, state: vm.getState() };
}

// Runs to the first state where `until` holds.
function runTo(source, until) {
  const prog = layout(source);
  const vm = createVM(prog.initMem);
  while (!until(vm.getState(), prog)) vm.step();
  return { prog, vm, state: vm.getState() };
}

test('puck prints what Puck v4 prints (its Ruby VM, with procedures registered before their bodies)', () => {
  const golden = { fib: [55], factorial: [120], calls: [1, 2, 3, 6], fizzbuzz: [42] };
  for (const [k, demo] of Object.entries(DEMOS)) assert.deepEqual(run(demo.code).state.stdout, golden[k], demo.name);
  // No operator precedence: (2 + 3) * 4, then ((7 / 2) + 17) MOD 5. A procedure with no RETURN, a LOOP left by EXIT.
  const misc = 'r := 2 + 3 * 4;\nSYSCALL(1, r);\nq := 7 / 2 + 17 % 5;\nSYSCALL(1, q);\nPROCEDURE noisy(x);\n  SYSCALL(1, x);\nEND;\nnoisy(9);\nn := 0;\nLOOP\n  n := n + 1;\n  IF n = 3 THEN\n    EXIT;\n  END;\nEND;\nSYSCALL(1, n);';
  assert.deepEqual(run(misc).state.stdout, [20, 0, 9, 3]);
  assert.deepEqual(run('x := 4;\nRETURN x;\nSYSCALL(1, x);').state.stdout, []);
});

test('puck tokenizes and parses as Puck v4 does, keeping lines', () => {
  assert.deepEqual(tokenize('x := 1;\nfoo(x)').map((t) => [t.type, t.value, t.line]), [
    ['SYMBOL', 'x', 1], ['OPERATOR', ':=', 1], ['INTEGER', 1, 1], ['OPERATOR', ';', 1],
    ['SYMBOL', 'foo', 2], ['OPERATOR', '(', 2], ['SYMBOL', 'x', 2], ['OPERATOR', ')', 2],
  ]);
  const [proc] = parse(tokenize(DEMOS.factorial.code));
  assert.deepEqual([proc.type, proc.var, proc.val.params, proc.val.body.map((n) => n.type), proc.line, proc.endLine], ['Procedure', 'factorial', ['n'], ['If', 'Return'], 1, 6]);
  for (const [bad, message] of [
    ['x := 1 < 2;', /Unexpected character "<" at position 7/],
    ['x := 1', /Expected OPERATOR/],
    ['SYSCALL(1, 2);', /Expected SYMBOL/],
    ['x := ;', /Unexpected expression token/],
    ['THEN', /Unexpected token/],
    ['y := x;', /key not found: "x"/],
    ['x := x + 1;', /key not found: "x"/],
    ['r := f(1);\nPROCEDURE f(n);\nEND;', /key not found: "f"/],
    ['EXIT;', /EXIT outside LOOP/],
  ]) assert.throws(() => compile(bad), message, bad);
});

test('puck keeps each call\'s frame in core memory: [ret, link, n, ...], linked down to main\'s', () => {
  const { prog, state } = runTo(DEMOS.factorial.code, (s, p) => s.XR[C] > p.stackBase && s.MEM[s.XR[C] + 2] === 0 && s.MEM[s.XR[C]] !== 0);
  const frames = [];
  for (let c = state.XR[C]; c >= prog.stackBase; c = state.MEM[c + 1]) frames.unshift(Array.from(state.MEM.slice(c, c + 3)));
  assert.equal(frames.length, 7);
  assert.deepEqual(frames.slice(1).map(([, , n]) => n), [5, 4, 3, 2, 1, 0]);
  assert.deepEqual(frames[0].slice(0, 2), [0, 0]);
  const names = stackLabels(prog, state);
  assert.deepEqual([names[prog.stackBase], names[state.XR[C]], names[state.XR[C] + 2]], ['main.ret', 'factorial.ret', 'factorial.n']);
});

test('puck names a frame from the moment C moves to it, and the effect line names slots, not cells', () => {
  const { prog, state } = runTo(DEMOS.factorial.code, (s, p) => p.code[s.ip][0] === 'JAL' && s.XR[C] > p.stackBase);
  assert.equal(stackLabels(prog, state)[state.XR[C] + 2], 'factorial.n');
  assert.match(effect(prog, state), /^call \d+, return to \d+ -> factorial\.ret \[via C\]$/);
  const jmpInd = prog.code.find(([op]) => op === 'JMP_IND');
  assert.equal(describe(jmpInd, prog.cells), 'JMP_IND (jump indirect): go to the instruction whose number is in M[0 + C] (return from SUB)');
  const back = runTo(DEMOS.factorial.code, (s, p) => p.code[s.ip][0] === 'JMP_IND' && s.XR[C] > p.stackBase).state;
  assert.match(effect(prog, back), /^return to \d+ \(from factorial\.ret \[via C\]\)$/);
  assert.deepEqual(stackLabels(prog, createVM(prog.initMem).getState()), []);
});

test('puck fits fib(10) in 128 words, stops on a stack that does not, and undoes every step', () => {
  const { prog, vm, state } = run(DEMOS.fib.code, true);
  assert.equal(MEM_WORDS, 128);
  assert.ok(state.steps > 1000);
  const nav = stepper(vm, () => 0);
  vm.reset();
  let deepest = 0;
  while (!vm.getState().halted) { nav.advance(); deepest = Math.max(deepest, vm.getState().XR[C]); }
  assert.ok(deepest + prog.procs[0].slots.length <= MEM_WORDS, `${deepest}`);
  while (vm.getState().steps) nav.back();
  assert.deepEqual([vm.getState().ip, vm.getState().XR[C]], [0, 0]);
  assert.throws(() => run(DEMOS.fib.code.replace('fib(10)', 'fib(40)')), /Memory address out of bounds: 128/);
  const huge = `PROCEDURE big(${Array.from({ length: 130 }, (_, i) => `a${i}`).join(', ')});\nEND;\nbig(${Array(130).fill(0).join(', ')});`;
  assert.throws(() => compile(huge), /does not fit in an operand's 7 address bits/);
});
