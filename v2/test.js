import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from './compiler.js';
import { SECTOR_WORDS, createVM, decode, encode, waitCycles } from './vm.js';
import { DEMOS, MEM_SIZE, compileView, describe, drumLayout, effect, layout, marks } from './visualizer.js';

function run(source) {
  const vm = createVM(layout(source, MEM_SIZE).initMem);
  while (!vm.getState().halted) vm.step();
  return vm;
}

test('v2 runs Demos 1-4 from memory, records ipMap, and supports stepBack/reset', () => {
  const fact = layout(DEMOS.factorial.code, MEM_SIZE);
  assert.equal(fact.ipMap.length, fact.code.length);
  assert.equal(fact.ipMap[0], 1);
  assert.equal(fact.ipMap[fact.ipMap.length - 1], 6);

  assert.deepEqual(run(DEMOS.factorial.code).getState().stdout, [120]);
  assert.deepEqual(run(DEMOS.swap.code).getState().stdout, [99, 10, 10]);
  assert.deepEqual(run(DEMOS.saxpy.code).getState().stdout, [40, 43, 46]);
  assert.deepEqual(run(DEMOS.equiv.code).getState().stdout, [11, 22, 33, 44]);

  const stepVm = createVM(fact.initMem);
  assert.equal(stepVm.getState().pc, null);
  assert.equal(stepVm.getState().ip, 0);
  stepVm.step();
  assert.equal(stepVm.getState().pc, 0);
  assert.equal(stepVm.getState().ip, 1);

  const vm = run(DEMOS.factorial.code);
  assert.equal(vm.stepBack(), true);
  assert.deepEqual(vm.getState().stdout, [120]);
  assert.equal(vm.stepBack(), true);
  assert.deepEqual(vm.getState().stdout, []);
  vm.reset();
  assert.equal(vm.getState().pc, null);
  assert.equal(vm.getState().ip, 0);
});

test('v2 highlights the line executed last and points to the line executed next', () => {
  const { initMem, ipMap } = layout(DEMOS.factorial.code, MEM_SIZE);
  const vm = createVM(initMem);
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

test('v2 says what the next instruction will do, in the names of its cells', () => {
  const prog = layout(DEMOS.swap.code, MEM_SIZE);
  const vm = createVM(prog.initMem);
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
  assert.equal(seen.at(-1), 'halt');
});

test('v2 names every opcode on hover', () => {
  const seen = new Set();
  for (const demo of Object.values(DEMOS)) {
    const prog = layout(demo.code, MEM_SIZE);
    for (const instr of prog.code) {
      const text = describe(instr, prog.cells);
      assert.ok(text.startsWith(`${instr[0]} `) || text.startsWith(`${instr[0]}:`), text);
      seen.add(instr[0]);
    }
  }
  for (const op of ['HALT', 'MOV', 'LOAD_IND', 'STORE_IND', 'PRINT', 'JMP', 'JAL', 'JMP_IND', 'JZ', '+', '<=']) assert.ok(seen.has(op), op);
  const fact = layout(DEMOS.factorial.code, MEM_SIZE);
  assert.equal(describe(fact.code[4], fact.cells), 'JZ (jump if zero): if M[16] tmp_16 is 0, go to instruction 9; else go to the next one');
  assert.equal(describe(fact.code[3], fact.cells), '<=: M[16] tmp_16 = M[15] I <= M[11] N (1 if true, 0 if false)');
});

test('v2 maps each memory cell to the source lines that use it', () => {
  const lines = (prog, label) => [...prog.cellLines[prog.cells.findIndex((c) => c.label === label)]].sort((a, b) => a - b);
  const fact = layout(DEMOS.factorial.code, MEM_SIZE);
  assert.deepEqual(lines(fact, 'N'), [1, 3]);
  assert.deepEqual(lines(fact, 'const(5)'), [1]);
  assert.deepEqual(lines(fact, 'FACT'), [2, 4, 6]);
  assert.deepEqual(lines(fact, 'I'), [3, 4]);
  const swap = layout(DEMOS.swap.code, MEM_SIZE);
  assert.deepEqual(lines(swap, 'SWAP.A'), [1, 2, 3, 8, 11]);
  assert.deepEqual(lines(swap, 'SWAP.ret'), [1, 8, 11]);
  const saxpy = layout(DEMOS.saxpy.code, MEM_SIZE);
  assert.deepEqual(lines(saxpy, 'A[4]'), [1, 10, 13, 14]);
  const equiv = layout(DEMOS.equiv.code, MEM_SIZE);
  assert.deepEqual(lines(equiv, 'WORKSPACE[3]'), [1, 2, 3, 4, 5, 6, 8]);
});

test('v2 replays compilation one memory cell or instruction at a time', () => {
  for (const demo of Object.values(DEMOS)) {
    const prog = layout(demo.code, MEM_SIZE);
    const done = compileView(prog, prog.events.length);
    assert.equal(done.cells, prog.usedCells);
    assert.deepEqual(done.code, prog.code);
    assert.deepEqual(compileView(prog, 0), { cells: 0, code: [], line: null, newCell: null, newIp: null });
  }
  const fact = layout(DEMOS.factorial.code, MEM_SIZE);
  const first = compileView(fact, 1);
  assert.deepEqual([first.cells, first.newCell, first.line], [12, 11, 1]);
  const k = fact.events.findIndex((ev) => ev.kind === 'patch');
  assert.deepEqual(compileView(fact, k).code[4], ['JZ', 0, 16, 0]);
  assert.deepEqual(compileView(fact, k + 1).code[4], ['JZ', 9, 16, 0]);
  assert.equal(compileView(fact, k + 1).newIp, 4);
});

test('v2 stores the program in memory ahead of its data', () => {
  for (const demo of Object.values(DEMOS)) {
    const prog = layout(demo.code, MEM_SIZE);
    assert.deepEqual(prog.code.at(-1), ['HALT', 0, 0, 0]);
    prog.code.forEach((instr, ip) => {
      assert.deepEqual(decode(prog.initMem[ip]), instr);
      assert.equal(prog.cells[ip].role, 'code');
    });
    assert.ok(prog.cells.slice(prog.codeLen, prog.usedCells).every((cell) => cell.role !== 'code' && cell.role !== 'unused'));
    assert.ok(prog.cells.slice(prog.usedCells).every((cell) => cell.role === 'unused'));
  }
  assert.throws(() => layout(DEMOS.saxpy.code, 64), /Program does not fit in 64 cells of RAM/);
  assert.equal(decode(0)[0], 'HALT');
  assert.match(decode(31 << 27)[0], /^\?31$/);
});

test('v2 executes whatever is in memory, so overwriting code changes the program', () => {
  const prog = layout('X = 1\nPRINT X', MEM_SIZE);
  const vm = createVM(prog.initMem);
  vm.getState().MEM[1] = prog.initMem[2];
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, []);
  assert.equal(vm.step().halted, true);
  assert.throws(() => { const bad = createVM([31 << 27]); bad.step(); }, /Unknown opcode: \?31/);
});

function runDemo(demo) {
  const prog = layout(demo.code, MEM_SIZE);
  const vm = createVM(prog.initMem, demo.drum);
  while (!vm.getState().halted) vm.step();
  return { prog, state: vm.getState() };
}

test('v2 streams a 128-word drum array through an 8-word buffer, with far fewer stalls when interleaved', () => {
  const seq = runDemo(DEMOS.drumSeq);
  const skip = runDemo(DEMOS.drumSkip);
  assert.deepEqual(seq.state.stdout, [8256]);
  assert.deepEqual(skip.state.stdout, [8256]);
  assert.ok(seq.prog.usedCells + 128 > MEM_SIZE);
  assert.deepEqual([seq.state.waited, skip.state.waited], [930, 210]);
  assert.equal(drumLayout(11)[11 * SECTOR_WORDS], 9);
  assert.equal(drumLayout(1)[1 * SECTOR_WORDS], 9);
});

test('v2 DRUM_READ waits for its sector, copies one word per cycle, and steps back mid-transfer', () => {
  const prog = layout('DIM B(8)\nREAD DRUM 0, B\nPRINT B[7]', MEM_SIZE);
  const vm = createVM(prog.initMem, drumLayout(1));
  const b = prog.sym.B.addr;
  vm.step();
  assert.deepEqual([vm.getState().cycles, vm.getState().io], [1, { sector: 0, addr: b, done: 0 }]);
  assert.equal(waitCycles(vm.getState()), 127);
  assert.equal(effect(prog, vm.getState()), 'waiting for drum sector 0: 127 cycles left');
  vm.step();
  assert.equal(effect(prog, vm.getState()), 'waiting for drum sector 0: 126 cycles left');
  while (vm.getState().cycles < 127) vm.step();
  assert.equal(effect(prog, vm.getState()), 'waiting for drum sector 0: 1 cycle left');
  vm.step();
  assert.equal(vm.getState().waited, 127);
  assert.equal(waitCycles(vm.getState()), 0);
  assert.equal(effect(prog, vm.getState()), 'drum sector 0 word 0 (1) -> B[0]');
  assert.deepEqual(vm.step().writes, [b]);
  vm.step();
  assert.deepEqual([vm.getState().io.done, vm.getState().MEM[b + 1]], [2, 2]);
  vm.stepBack();
  assert.deepEqual([vm.getState().io.done, vm.getState().MEM[b + 1], vm.getState().cycles], [1, 0, 129]);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, [8]);
  assert.equal(vm.getState().cycles, 140);
  assert.equal(waitCycles({ io: { sector: 3, done: 0 }, cycles: 130 }), 22);
  assert.equal(waitCycles({ io: null, cycles: 5 }), 0);
  assert.throws(() => { const bad = createVM(layout('DIM B(8)\nREAD DRUM 16, B', MEM_SIZE).initMem); bad.step(); }, /No drum sector 16/);
});

test('v2 explains drum reads and computes MOD', () => {
  const prog = layout('DIM B(8)\nS = 3\nREAD DRUM S, B\nPRINT MOD(17, 5)', MEM_SIZE);
  const vm = createVM(prog.initMem);
  vm.step();
  assert.equal(effect(prog, vm.getState()), 'read drum sector S (3) -> B[0]..B[7], waiting 22 cycles first');
  const read = prog.code.find((instr) => instr[0] === 'DRUM_READ');
  assert.match(describe(read, prog.cells), /^DRUM_READ \(read drum\): wait for drum sector M\[\d+\] S to reach the head, then copy its 8 words into the cells from the address in M\[\d+\] const\(\d+\)$/);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, [2]);
});

test('v2 scopes SUB locals, indexes a 2D SUB argument, and rejects what it cannot compile', () => {
  const src = ['I = 77', 'DIM G(2, 2)', 'SUB FILL(M)', '  DIM M(2, 2)', '  DO I = 0, 1', '    M[I, 1] = (I + 1) * 10', '  END', 'END', 'CALL FILL(G)', 'PRINT I', 'PRINT G[1, 1]'].join('\n');
  assert.deepEqual(run(src).getState().stdout, [77, 20]);
  assert.deepEqual(run('SUB S(K)\n  DO K = 1, 3\n  END\nEND\nOUT = 0\nCALL S(OUT)\nPRINT OUT').getState().stdout, [4]);
  for (const [bad, message] of [
    ['X = 3.14', /Unexpected character '\.'/],
    ['X = 1\nEND\nPRINT X', /Unexpected 'END'/],
    ['X = 1\nELSE\nX = 2', /Unexpected 'ELSE'/],
    ['CALL NOPE()', /Undefined subroutine 'NOPE'/],
    ['X = 1\nY = X[0, 0]', /2D index on non-2D variable 'X'/],
    ['DIM SMALL(2)\nEQUIV BIG(5) = SMALL', /EQUIV 'BIG' must fit inside 'SMALL'/],
    ['EQUIV A(2) = MISSING', /EQUIV 'A' must fit inside 'MISSING'/],
  ]) assert.throws(() => layout(bad, MEM_SIZE), message);
});

test('v2 undoes a step that faults, so stepping again faults again', () => {
  const vm = ((src) => createVM(layout(src, MEM_SIZE).initMem))('X = 0\nY = 5 / X\nPRINT 7');
  vm.step();
  const at = [vm.getState().ip, vm.getState().steps];
  assert.throws(() => vm.step(), /Division by zero/);
  assert.deepEqual([vm.getState().ip, vm.getState().steps], at);
  assert.throws(() => vm.step(), /Division by zero/);
  assert.throws(() => run('DIM A(2)\nA[200] = 1'), /Memory address out of bounds/);
  assert.throws(() => createVM([encode(['JMP_IND', 1, 0, 0]), -1]).step(), /Memory address out of bounds: -1/);
  assert.equal(effect(layout('X = 1', MEM_SIZE), createVM([31 << 27]).getState()), 'unknown opcode ?31');
});

test('v2 reads the drum into a SUB array argument, and stops at the end of RAM', () => {
  const prog = layout('DIM BIG(16)\nSUB LOAD(S, DST)\n  READ DRUM S, DST\nEND\nCALL LOAD(1, BIG)\nPRINT BIG[0]\nPRINT BIG[7]', MEM_SIZE);
  const vm = createVM(prog.initMem, drumLayout(1));
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, [9, 16]);
  const mem = new Int32Array(MEM_SIZE);
  mem.set([encode(['DRUM_READ', 1, 2, 0]), MEM_SIZE - 3, 1]);
  const edge = createVM(mem, drumLayout(1));
  assert.throws(() => { for (;;) edge.step(); }, new RegExp(`Memory address out of bounds: ${MEM_SIZE}`));
  assert.equal(edge.getState().io.done, 3);
});
