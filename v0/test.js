import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from './compiler.js';
import { createVM } from './vm.js';
import { DEMOS, compileView, describe, effect, layout, haltLine, marks } from './visualizer.js';

function run(source) {
  const { code, initMem } = layout(source, 64);
  const vm = createVM(code, initMem);
  while (!vm.getState().halted) vm.step();
  return vm;
}

test('v0 runs Demos 1-4, records ipMap, and supports stepBack/reset', () => {
  const fact = layout(DEMOS.factorial.code, 64);
  assert.equal(fact.ipMap.length, fact.code.length);
  assert.equal(fact.ipMap[0], 1);
  assert.equal(fact.ipMap[fact.ipMap.length - 1], 6);

  assert.deepEqual(run(DEMOS.factorial.code).getState().stdout, [120]);
  assert.deepEqual(run(DEMOS.swap.code).getState().stdout, [99, 10, 10]);
  assert.deepEqual(run(DEMOS.saxpy.code).getState().stdout, [40, 43, 46]);
  assert.deepEqual(run(DEMOS.equiv.code).getState().stdout, [11, 22, 33, 44]);

  const { code, initMem } = layout(DEMOS.factorial.code, 64);
  const stepVm = createVM(code, initMem);
  assert.equal(stepVm.getState().pc, null);
  assert.equal(stepVm.getState().ip, 0);
  stepVm.step();
  assert.equal(stepVm.getState().pc, 0);
  assert.equal(stepVm.getState().ip, 1);

  const vm = run(DEMOS.factorial.code);
  assert.equal(vm.stepBack(), true);
  assert.deepEqual(vm.getState().stdout, []);
  vm.reset();
  assert.equal(vm.getState().pc, null);
  assert.equal(vm.getState().ip, 0);
});

test('v0 highlights the line executed last and points to the line executed next', () => {
  const { code, initMem, ipMap } = layout(DEMOS.factorial.code, 64);
  const vm = createVM(code, initMem);
  assert.deepEqual(marks(ipMap, vm.getState()), { lastIp: null, nextIp: 0, lastLine: null, nextLine: 1 });
  vm.step();
  const one = marks(ipMap, vm.getState());
  assert.equal(one.lastLine, 1);
  assert.equal(one.nextLine, ipMap[one.nextIp]);
  while (!vm.getState().halted) {
    const before = marks(ipMap, vm.getState());
    vm.step();
    assert.equal(marks(ipMap, vm.getState()).lastIp, before.nextIp);
  }
  const end = marks(ipMap, vm.getState());
  assert.equal(end.nextLine, null);
  assert.equal(end.lastLine, 6);
});

test('v0 says what the next instruction will do, in the names of its cells', () => {
  const prog = layout(DEMOS.swap.code, 64);
  const vm = createVM(prog.code, prog.initMem);
  const seen = [];
  while (!vm.getState().halted) {
    seen.push(effect(prog, vm.getState()));
    vm.step();
  }
  assert.equal(effect(prog, vm.getState()), 'halted');
  assert.ok(seen.some((line) => / -> \*SWAP\.A = const\(2\) \[\d+\]$/.test(line)), seen.join('\n'));
  assert.ok(seen.some((line) => line.startsWith('call ')));
  assert.ok(seen.some((line) => line.startsWith('return to ')));
  assert.ok(seen.some((line) => line.startsWith('print ')));
});

test('v0 names every opcode on hover', () => {
  const seen = new Set();
  for (const demo of Object.values(DEMOS)) {
    const prog = layout(demo.code, 64);
    for (const instr of prog.code) {
      const text = describe(instr, prog.cells);
      assert.ok(text.startsWith(`${instr[0]} `) || text.startsWith(`${instr[0]}:`), text);
      seen.add(instr[0]);
    }
  }
  for (const op of ['MOV', 'LOAD_IND', 'STORE_IND', 'PRINT', 'JMP', 'JAL', 'JMP_IND', 'JZ', '+', '<=']) assert.ok(seen.has(op), op);
  const fact = layout(DEMOS.factorial.code, 64);
  assert.equal(describe(['JZ', 9, 5, 0], fact.cells), 'JZ (jump if zero): if M[5] tmp_5 is 0, go to instruction 9; else go to the next one');
  assert.equal(describe(['<=', 5, 4, 0], fact.cells), '<=: M[5] tmp_5 = M[4] I <= M[0] N (1 if true, 0 if false)');
});

test('v0 maps each memory cell to the source lines that use it', () => {
  const lines = (prog, label) => [...prog.cellLines[prog.cells.findIndex((c) => c.label === label)]].sort((a, b) => a - b);
  const fact = layout(DEMOS.factorial.code, 64);
  assert.deepEqual(lines(fact, 'N'), [1, 3]);
  assert.deepEqual(lines(fact, 'const(5)'), [1]);
  assert.deepEqual(lines(fact, 'FACT'), [2, 4, 6]);
  assert.deepEqual(lines(fact, 'I'), [3, 4]);
  const swap = layout(DEMOS.swap.code, 64);
  assert.deepEqual(lines(swap, 'SWAP.A'), [1, 2, 3, 8, 11]);
  assert.deepEqual(lines(swap, 'SWAP.ret'), [1, 8, 11]);
  const saxpy = layout(DEMOS.saxpy.code, 64);
  assert.deepEqual(lines(saxpy, 'A[4]'), [1, 10, 13, 14]);
  const equiv = layout(DEMOS.equiv.code, 64);
  assert.deepEqual(lines(equiv, 'WORKSPACE[3]'), [1, 2, 3, 4, 5, 6, 8]);
});

test('v0 replays compilation one memory cell or instruction at a time', () => {
  for (const demo of Object.values(DEMOS)) {
    const prog = layout(demo.code, 64);
    const done = compileView(prog, prog.events.length);
    assert.equal(done.cells, prog.usedCells);
    assert.deepEqual(done.code, prog.code);
    assert.deepEqual(compileView(prog, 0), { cells: 0, code: [], line: null, newCell: null, newIp: null });
  }
  const fact = layout(DEMOS.factorial.code, 64);
  const first = compileView(fact, 1);
  assert.deepEqual([first.cells, first.newCell, first.line], [1, 0, 1]);
  const k = fact.events.findIndex((ev) => ev.kind === 'patch');
  assert.deepEqual(compileView(fact, k).code[4], ['JZ', 0, 5, 0]);
  assert.deepEqual(compileView(fact, k + 1).code[4], ['JZ', 9, 5, 0]);
  assert.equal(compileView(fact, k + 1).newIp, 4);
});

test('v0 scopes SUB locals, indexes a 2D SUB argument, and rejects what does not parse', () => {
  const src = ['I = 77', 'DIM G(2, 2)', 'SUB FILL(M)', '  DIM M(2, 2)', '  DO I = 0, 1', '    M[I, 1] = (I + 1) * 10', '  END', 'END', 'CALL FILL(G)', 'PRINT I', 'PRINT G[1, 1]'].join('\n');
  assert.deepEqual(run(src).getState().stdout, [77, 20]);
  assert.deepEqual(run('SUB S(K)\n  DO K = 1, 3\n  END\nEND\nOUT = 0\nCALL S(OUT)\nPRINT OUT').getState().stdout, [4]);
  for (const [bad, message] of [
    ['X = 3.14', /Expected identifier, got '\.'/],
    ['X = 1\nEND\nPRINT X', /Expected 'end of input', got 'END'/],
    ['X = 1\nELSE\nX = 2', /Expected 'end of input', got 'ELSE'/],
    ['DIM A(2', /Unexpected end of input/],
    ['CALL NOPE()', /Cannot read properties of undefined/],
    ['X = 1\nY = X[0, 0]', /Cannot read properties of null/],
  ]) assert.throws(() => layout(bad, 64), message);
});

test('v0 undoes a step that faults, so stepping again faults again', () => {
  const vm = ((src) => { const p = layout(src, 64); return createVM(p.code, p.initMem); })('X = 0\nY = 5 / X\nPRINT 7');
  vm.step();
  const at = [vm.getState().ip, vm.getState().steps];
  assert.throws(() => vm.step(), /Division by zero/);
  assert.deepEqual([vm.getState().ip, vm.getState().steps], at);
  assert.throws(() => vm.step(), /Division by zero/);
  assert.throws(() => run('DIM A(2)\nA[200] = 1'), /Memory address out of bounds/);
  assert.throws(() => createVM([['JMP', -1, 0, 0]], new Int32Array(4)).step(), /Instruction pointer out of bounds/);
});

test('v0 points past the last line once the program halts', () => {
  assert.equal(haltLine(DEMOS.factorial.code), DEMOS.factorial.code.split('\n').length + 1);
  assert.equal(haltLine('X = 1\n\n# done?\n\n'), 4);
  assert.equal(haltLine('X = 1\n\n\n'), 2);
});
