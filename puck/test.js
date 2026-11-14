import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, parse, tokenize } from './compiler.js';
import { MEM_WORDS, createVM, tagOf } from './vm.js';
import { DEMOS, describe, effect, layout, stackLabels, stepper } from './visualizer.js';

const C = 2;
const B = 1;

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
  while (!vm.getState().halted && !until(vm.getState(), prog)) vm.step();
  return { prog, vm, state: vm.getState() };
}

test('puck prints what Puck v4 prints (its Ruby VM, with procedures registered before their bodies)', () => {
  const golden = { fib: [55], factorial: [120], calls: [1, 2, 3, 6], fizzbuzz: [42] };
  for (const [k, demo] of Object.entries(DEMOS)) assert.deepEqual(run(demo.code).state.stdout, golden[k], demo.name);
  // No operator precedence: (2 + 3) * 4, then ((7 / 2) + 17) MOD 5. A procedure with no RETURN, a LOOP left by EXIT.
  const misc = `r := 2 + 3 * 4;
SYSCALL(1, r);
q := 7 / 2 + 17 % 5;
SYSCALL(1, q);
PROCEDURE noisy(x);
  SYSCALL(1, x);
END;
noisy(9);
n := 0;
LOOP
  n := n + 1;
  IF n = 3 THEN
    EXIT;
  END;
END;
SYSCALL(1, n);`;
  assert.deepEqual(run(misc).state.stdout, [20, 0, 9, 3]);
  // The main program's RETURN ends it.
  const early = `x := 4;
RETURN x;
SYSCALL(1, x);`;
  assert.deepEqual(run(early).state.stdout, []);
});

test('puck tokenizes and parses as Puck v4 does, keeping lines', () => {
  assert.deepEqual(tokenize('x := 1;\nfoo(x)').map((t) => [t.type, t.value, t.line]), [
    ['SYMBOL', 'x', 1], ['OPERATOR', ':=', 1], ['INTEGER', 1, 1], ['OPERATOR', ';', 1],
    ['SYMBOL', 'foo', 2], ['OPERATOR', '(', 2], ['SYMBOL', 'x', 2], ['OPERATOR', ')', 2],
  ]);
  const [proc] = parse(tokenize(DEMOS.factorial.code));
  assert.deepEqual([proc.type, proc.var, proc.val.params], ['Procedure', 'factorial', ['n']]);
  assert.deepEqual([proc.val.body.map((n) => n.type), proc.line, proc.endLine], [['If', 'Return'], 1, 6]);
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
  // The deepest call, factorial(0), once its return address is written.
  const deepest = (s, p) => s.XR[C] > p.stackBase && s.MEM[s.XR[C] + 2] === 0 && s.MEM[s.XR[C]] !== 0;
  const { prog, state } = runTo(DEMOS.factorial.code, deepest);
  const frames = [];
  for (let c = state.XR[C]; c >= prog.stackBase; c = state.MEM[c + 1]) {
    frames.unshift(Array.from(state.MEM.slice(c, c + 3)));
  }
  assert.equal(frames.length, 7);
  assert.deepEqual(frames.slice(1).map(([, , n]) => n), [5, 4, 3, 2, 1, 0]);
  assert.deepEqual(frames[0].slice(0, 2), [0, 0]);
  const names = stackLabels(prog, state);
  const top = state.XR[C];
  assert.deepEqual([names[prog.stackBase], names[top], names[top + 2]], ['main.ret', 'factorial.ret', 'factorial.n']);
});

test('puck names a frame from the moment C moves to it, and the effect line names slots, not cells', () => {
  const calling = runTo(DEMOS.factorial.code, (s, p) => p.code[s.ip][0] === 'TSX' && s.XR[C] > p.stackBase);
  assert.equal(stackLabels(calling.prog, calling.state)[calling.state.XR[C] + 2], 'factorial.n');
  assert.match(effect(calling.prog, calling.state), /^call \d+: \d+ \(this instruction\) -> index register B$/);
  // The callee's first instruction saves the return address TSX left in B into the frame.
  const entered = runTo(DEMOS.factorial.code, (s, p) => s.ip === p.procs[0].entry);
  assert.equal(stackLabels(entered.prog, entered.state)[entered.state.XR[C]], 'factorial.ret');
  assert.match(effect(entered.prog, entered.state), /^index register B \(\d+\) -> factorial\.ret \[via C\]$/);
  const { prog } = calling;
  const returning = prog.code.find((instr) => instr[0] === 'TRA' && tagOf(instr[1]) === B + 1);
  const returns = 'TRA (transfer): go to instruction 1 + index register B (return from SUB)';
  assert.equal(describe(returning, prog.cells), returns);
  const isReturn = (instr) => instr[0] === 'TRA' && tagOf(instr[1]);
  const back = runTo(DEMOS.factorial.code, (s, p) => isReturn(p.code[s.ip]) && s.XR[C] > p.stackBase).state;
  assert.match(effect(prog, back), /^return to \d+ \(B \+ 1\)$/);
  assert.deepEqual(stackLabels(prog, createVM(prog.initMem).getState()), []);
});

test('puck works expressions out in the AC and MQ, and stores the AC before a call, which does not keep it', () => {
  const fib = layout(DEMOS.fib.code);
  const ops = fib.code.map(([op]) => op);
  const firstCall = ops.indexOf('TSX');
  // After the first call, fib(n - 1)'s result is stored in the frame before fib(n - 2) is worked out.
  assert.deepEqual(ops.slice(firstCall, firstCall + 3), ['TSX', 'LXD', 'STO']);
  assert.ok(tagOf(fib.code[firstCall + 2][1]) === C + 1);
  const factorial = layout(DEMOS.factorial.code).code.map(([op]) => op);
  assert.ok(['LDQ', 'MPY', 'STQ'].every((op) => factorial.includes(op)));
  const equal = 'r := 3 = 3;\nSYSCALL(1, r);\nq := 3 = 4;\nSYSCALL(1, q);\nd := 7 / 2;\nSYSCALL(1, d);';
  assert.deepEqual(run(equal).state.stdout, [1, 0, 3]);
  // A test that is not a comparison is false when it is 0 (in Puck's Ruby VM, only false is false).
  const truth = 'x := 0;\nIF x THEN\n  SYSCALL(1, x);\nEND;\ny := 2;\nIF y THEN\n  SYSCALL(1, y);\nEND;';
  assert.deepEqual(run(truth).state.stdout, [2]);
});

test('puck fits fib(10) in 256 words, stops on a stack that does not, and undoes every step', () => {
  const { prog, vm, state } = run(DEMOS.fib.code, true);
  assert.equal(MEM_WORDS, 256);
  assert.ok(state.steps > 1000);
  const nav = stepper(vm, () => 0);
  vm.reset();
  let deepest = 0;
  while (!vm.getState().halted) { nav.advance(); deepest = Math.max(deepest, vm.getState().XR[C]); }
  assert.ok(deepest + prog.procs[0].slots.length <= MEM_WORDS, `${deepest}`);
  while (vm.getState().steps) nav.back();
  assert.deepEqual([vm.getState().ip, vm.getState().XR[C]], [0, 0]);
  const tooDeep = DEMOS.fib.code.replace('fib(10)', 'fib(80)');
  assert.throws(() => run(tooDeep), /Memory address out of bounds: 2[5-9]\d/);
  const params = Array.from({ length: 260 }, (_, i) => `a${i}`).join(', ');
  const huge = `PROCEDURE big(${params});\nEND;\nbig(${Array(260).fill(0).join(', ')});`;
  assert.throws(() => compile(huge), /does not fit in an address's 8 bits/);
});
