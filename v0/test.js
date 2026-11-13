import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from './compiler.js';
import { createVM } from './vm.js';
import { DEMOS, compileView, describe, effect, marks } from './visualizer.js';

function run(source) {
  const { code, initMem } = compile(source, 64);
  const vm = createVM(code, initMem);
  while (!vm.getState().halted) vm.step();
  return vm;
}

test('v0 runs Demos 1-4, records ipMap, and supports stepBack/reset', () => {
  const fact = compile(DEMOS.factorial.code, 64);
  assert.equal(fact.ipMap.length, fact.code.length);
  assert.equal(fact.ipMap[0], 1);
  assert.equal(fact.ipMap[fact.ipMap.length - 1], 6);

  assert.deepEqual(run(DEMOS.factorial.code).getState().stdout, [120]);
  assert.deepEqual(run(DEMOS.swap.code).getState().stdout, [99, 10, 10]);
  assert.deepEqual(run(DEMOS.saxpy.code).getState().stdout, [40, 43, 46]);
  assert.deepEqual(run(DEMOS.equiv.code).getState().stdout, [11, 22, 33, 44]);

  const { code, initMem } = compile(DEMOS.factorial.code, 64);
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
  const { code, initMem, ipMap } = compile(DEMOS.factorial.code, 64);
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
  const prog = compile(DEMOS.swap.code, 64);
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
    const prog = compile(demo.code, 64);
    for (const instr of prog.code) {
      const text = describe(instr, prog.cells);
      assert.ok(text.startsWith(`${instr[0]} `) || text.startsWith(`${instr[0]}:`), text);
      seen.add(instr[0]);
    }
  }
  for (const op of ['MOV', 'LOAD_IND', 'STORE_IND', 'PRINT', 'JMP', 'JAL', 'JMP_IND', 'JZ', '+', '<=']) assert.ok(seen.has(op), op);
  const fact = compile(DEMOS.factorial.code, 64);
  assert.equal(describe(['JZ', 9, 5, 0], fact.cells), 'JZ (jump if zero): if M[5] tmp_5 is 0, go to instruction 9; else go to the next one');
  assert.equal(describe(['<=', 5, 4, 0], fact.cells), '<=: M[5] tmp_5 = M[4] I <= M[0] N (1 if true, 0 if false)');
});

test('v0 maps each memory cell to the source lines that use it', () => {
  const lines = (prog, label) => [...prog.cellLines[prog.cells.findIndex((c) => c.label === label)]].sort((a, b) => a - b);
  const fact = compile(DEMOS.factorial.code, 64);
  assert.deepEqual(lines(fact, 'N'), [1, 3]);
  assert.deepEqual(lines(fact, 'const(5)'), [1]);
  assert.deepEqual(lines(fact, 'FACT'), [2, 4, 6]);
  assert.deepEqual(lines(fact, 'I'), [3, 4]);
  const swap = compile(DEMOS.swap.code, 64);
  assert.deepEqual(lines(swap, 'SWAP.A'), [1, 2, 3, 8, 11]);
  assert.deepEqual(lines(swap, 'SWAP.ret'), [1, 8, 11]);
  const saxpy = compile(DEMOS.saxpy.code, 64);
  assert.deepEqual(lines(saxpy, 'A[4]'), [1, 10, 13, 14]);
  const equiv = compile(DEMOS.equiv.code, 64);
  assert.deepEqual(lines(equiv, 'WORKSPACE[3]'), [1, 2, 3, 4, 5, 6, 8]);
});

test('v0 replays compilation one memory cell or instruction at a time', () => {
  for (const demo of Object.values(DEMOS)) {
    const prog = compile(demo.code, 64);
    const done = compileView(prog, prog.events.length);
    assert.equal(done.cells, prog.usedCells);
    assert.deepEqual(done.code, prog.code);
    assert.deepEqual(compileView(prog, 0), { cells: 0, code: [], line: null, newCell: null, newIp: null });
  }
  const fact = compile(DEMOS.factorial.code, 64);
  const first = compileView(fact, 1);
  assert.deepEqual([first.cells, first.newCell, first.line], [1, 0, 1]);
  const k = fact.events.findIndex((ev) => ev.kind === 'patch');
  assert.deepEqual(compileView(fact, k).code[4], ['JZ', 0, 5, 0]);
  assert.deepEqual(compileView(fact, k + 1).code[4], ['JZ', 9, 5, 0]);
  assert.equal(compileView(fact, k + 1).newIp, 4);
});

test('v0 isolates SUB scope, supports 2D/DO ref params, extends EQUIV, and rejects invalid programs/faults', () => {
  const src = [
    'I = 77',
    'DIM G(2, 2)',
    'SUB FILL(M, K)',
    '  DIM M(2, 2)',
    '  DO I = 0, 1',
    '    M[I, 1] = (I + 1) * 10',
    '  END',
    '  DO K = 1, 3',
    '    M[0, 0] = M[0, 0] + K',
    '  END',
    'END',
    'OUT = 0',
    'CALL FILL(G, OUT)',
    'DIM SMALL(2)',
    'EQUIV BIG(5) = SMALL',
    'AFTER = 99',
    'BIG[4] = 42',
    'PRINT I',
    'PRINT G[0, 0]',
    'PRINT G[1, 1]',
    'PRINT OUT',
    'PRINT AFTER',
    'PRINT BIG[4]',
  ].join('\n');
  const prog = compile(src, 64);
  assert.equal(compileView(prog, prog.events.length).cells, prog.usedCells);
  assert.deepEqual(run(src).getState().stdout, [77, 6, 20, 4, 99, 42]);

  assert.throws(() => compile('X = 3.14', 16), /Unexpected character '\.'/);
  assert.throws(() => compile('X = 1\nEND\nPRINT X', 16), /Unexpected 'END'/);
  assert.throws(() => compile('CALL NOPE()', 16), /Undefined subroutine 'NOPE'/);
  assert.throws(() => compile('EQUIV A(2) = MISSING', 16), /Invalid EQUIV target 'MISSING'/);
  assert.throws(() => compile('X = 1\nY = X[0, 0]', 16), /2D index on non-2D variable 'X'/);
  assert.throws(() => run('X = 1 / 0'), /Division by zero/);
  assert.throws(() => run('DIM A(2)\nA[99] = 1'), /Memory address out of bounds/);
  assert.throws(() => { const bad = createVM([['JMP', -1, 0, 0]], new Int32Array(4)); bad.step(); }, /Instruction pointer out of bounds/);
});
