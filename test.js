import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, emitRiscv } from './compiler.js';
import { createVM, createRiscvVM } from './vm.js';
import { DEMOS } from './visualizer.js';

function runBoth(source, compileOpts = {}, vmOpts = {}) {
  const compiled = compile(source, compileOpts);
  const fullVmOpts = {
    debug: compiled.debug,
    enableRuntimeStackHeap: compiled.debug.enableRuntimeStackHeap,
    heapMode: compiled.debug.heapMode,
    ...vmOpts,
  };

  const vm = createVM(compiled.code, compiled.initMem, fullVmOpts);
  vm.runSlice(10000);
  const vmState = vm.getState();

  const asm = emitRiscv(compiled.code, compiled.initMem, compiled.usedCells);
  const rv = createRiscvVM(asm, compiled.initMem, fullVmOpts);
  rv.runSlice(50000);
  const rvState = rv.getState();

  return { compiled, vm, vmState, rv, rvState, asm };
}

test('Demo 1: Factorial produces 120 in 7 cells and matches Appendix B RISC-V', () => {
  const { compiled, vmState, rvState, asm } = runBoth(DEMOS.factorial.code, { memSize: 64 });
  assert.equal(compiled.usedCells, 7);
  assert.deepEqual(vmState.stdout, [120]);
  assert.deepEqual(rvState.stdout, [120]);
  assert.match(asm, /^MEM: \.word 0, 5, 0, 1, 0, 0, 0$/m);
  assert.equal(vmState.trap, null);
  assert.equal(rvState.trap, null);
});

test('Demo 2: SWAP mutates .rodata when unprotected and traps when MMU is enabled', () => {
  const unprotected = runBoth(DEMOS.swap.code, { memSize: 64 }, { protectRodata: false });
  assert.deepEqual(unprotected.vmState.stdout, [99, 10, 10]);
  assert.deepEqual(unprotected.rvState.stdout, [99, 10, 10]);

  const protectedRun = runBoth(DEMOS.swap.code, { memSize: 64 }, { protectRodata: true });
  assert.equal(protectedRun.vmState.trap?.code, 'TRAP_RODATA_WRITE_FAULT');
  assert.equal(protectedRun.rvState.trap?.code, 'TRAP_RODATA_WRITE_FAULT');
  assert.deepEqual(protectedRun.vmState.stdout, [99, 10]);
  assert.deepEqual(protectedRun.rvState.stdout, [99, 10]);
});

test('Demo 3: 2D Matrix SAXPY column slicing and deref telemetry', () => {
  const compiled = compile(DEMOS.saxpy.code, { memSize: 64 });
  const vm = createVM(compiled.code, compiled.initMem, { debug: compiled.debug });
  const derefs = [];
  while (!vm.getState().halted) {
    const res = vm.step();
    if (res.event?.deref) derefs.push(res.event.deref);
  }
  assert.deepEqual(vm.getState().stdout, [40, 43, 46]);
  assert.ok(derefs.some((d) => d.access === 'read' && d.ptrCell != null));
  assert.ok(derefs.some((d) => d.access === 'write' && d.ptrCell != null));

  const { rvState } = runBoth(DEMOS.saxpy.code, { memSize: 64 });
  assert.deepEqual(rvState.stdout, [40, 43, 46]);
});

test('Demo 4: EQUIV overlays memory with zero extra cells', () => {
  const { compiled, vmState, rvState } = runBoth(DEMOS.equiv.code, { memSize: 64 });
  assert.equal(compiled.debug.symbols.WORKSPACE.addr, 0);
  assert.equal(compiled.debug.symbols.VIEW_A.addr, 0);
  assert.deepEqual(compiled.debug.cells[0].aliases, ['VIEW_A[0,0]']);
  assert.deepEqual(compiled.debug.cells[2].aliases, ['VIEW_A[0,1]']);
  assert.deepEqual(vmState.stdout, [11, 22, 33, 44]);
  assert.deepEqual(rvState.stdout, [11, 22, 33, 44]);
});

test('Demo 5: Multi-tape stream filter, rewind, and EOF trap', () => {
  const { vmState, rvState } = runBoth(DEMOS.tapeFilter.code, { memSize: 64 }, { initTape: [3, -1, 7, 0, 5] });
  assert.deepEqual(vmState.stdout, [6, 14, 10]);
  assert.deepEqual(rvState.stdout, [6, 14, 10]);

  const eofProg = 'READ X\nPRINT X';
  const eofRun = runBoth(eofProg, { memSize: 16 }, { initTape: [] });
  assert.equal(eofRun.vmState.trap?.code, 'TRAP_TAPE_EOF');
});

test('Demo 6: Rotating drum DMA read/write and rotational latency', () => {
  const drumSeed = new Int32Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const { vmState, rvState } = runBoth(DEMOS.drum.code, { memSize: 64 }, { initDrum: drumSeed });
  assert.deepEqual(vmState.stdout, [108]);
  assert.deepEqual(rvState.stdout, [108]);
  const sec2Offset = 2 * 8;
  assert.deepEqual(Array.from(vmState.drum.subarray(sec2Offset, sec2Offset + 8)), [101, 102, 103, 104, 105, 106, 107, 108]);
  assert.deepEqual(Array.from(rvState.drum.subarray(sec2Offset, sec2Offset + 8)), [101, 102, 103, 104, 105, 106, 107, 108]);
});

test('Demo 7: Dangling stack pointer vs NEW heap persistence and collision trap', () => {
  const stackRun = runBoth(DEMOS.danglingStack.code, { memSize: 128, enableRuntimeStackHeap: true });
  assert.deepEqual(stackRun.vmState.stdout, [500, 900]);
  assert.deepEqual(stackRun.rvState.stdout, [500, 900]);
  assert.equal(stackRun.vmState.MEM[1], 128);

  const heapSrc = DEMOS.danglingStack.code.replace('STACK(3)', 'NEW(3)');
  const heapRun = runBoth(heapSrc, { memSize: 128, enableRuntimeStackHeap: true });
  assert.deepEqual(heapRun.vmState.stdout, [500, 500]);
  assert.deepEqual(heapRun.rvState.stdout, [500, 500]);

  const collideSrc = 'P = STACK(60)\nP[0] = 1';
  const collide = runBoth(collideSrc, { memSize: 64, enableRuntimeStackHeap: true });
  assert.equal(collide.vmState.trap?.code, 'TRAP_STACK_HEAP_COLLISION');
});

test('Heap allocators: firstFit, coalesceSplit, and semiSpaceGC with time-travel', () => {
  const src = [
    'PTR A = NEW(4)',
    'A[0] = 10',
    'PTR B = NEW(4)',
    'B[0] = 20',
    'FREE(A)',
    'FREE(B)',
    'PTR C = NEW(6)',
    'C[0] = 30',
    'PRINT C[0]',
  ].join('\n');

  const firstFitFail = runBoth(src, { memSize: 32, enableRuntimeStackHeap: true, heapMode: 'firstFit' });
  assert.equal(firstFitFail.vmState.trap?.code, 'TRAP_OOM');

  const coalesced = runBoth(src, { memSize: 32, enableRuntimeStackHeap: true, heapMode: 'coalesceSplit' });
  assert.deepEqual(coalesced.vmState.stdout, [30]);
  assert.deepEqual(coalesced.rvState.stdout, [30]);

  const gcSrc = [
    'PTR KEEP = NEW(3)',
    'KEEP[0] = 42',
    'TEMP = NEW(8)',
    'TEMP[0] = 99',
    'PTR NEXT = NEW(4)',
    'NEXT[0] = 77',
    'PRINT KEEP[0]',
    'PRINT NEXT[0]',
  ].join('\n');
  const compiled = compile(gcSrc, { memSize: 64, enableRuntimeStackHeap: true, heapMode: 'semiSpaceGC' });
  const vm = createVM(compiled.code, compiled.initMem, { debug: compiled.debug });
  const gcEvents = [];
  while (!vm.getState().halted) {
    const res = vm.step();
    if (res.event?.gcTrace) gcEvents.push(...res.event.gcTrace);
  }
  assert.deepEqual(vm.getState().stdout, [42, 77]);
  assert.ok(gcEvents.some((e) => e.kind === 'flip_semispace'));
  assert.ok(gcEvents.some((e) => e.kind === 'copy_block'));

  const totalSteps = vm.getState().steps;
  vm.seek(2);
  assert.equal(vm.getState().stdout.length, 0);
  vm.seek(totalSteps);
  assert.deepEqual(vm.getState().stdout, [42, 77]);
});

test('Signed 32-bit division truncates toward zero across VM and RISC-V', () => {
  const src = 'X = -7 / 2\nPRINT X\nY = -2147483648 / -1\nPRINT Y';
  const { vmState, rvState } = runBoth(src, { memSize: 32 });
  assert.deepEqual(vmState.stdout, [-3, -2147483648]);
  assert.deepEqual(rvState.stdout, [-3, -2147483648]);

  const divZero = runBoth('X = 10 / 0', { memSize: 16 });
  assert.equal(divZero.vmState.trap?.code, 'TRAP_DIV_ZERO');
  assert.equal(divZero.rvState.trap?.code, 'TRAP_DIV_ZERO');
});

test('Time-travel seek, stepBack, reset, and compile backpatching events', () => {
  const compiled = compile(DEMOS.factorial.code, { memSize: 64 });
  assert.ok(compiled.debug.compileEvents.some((e) => e.kind === 'patch'));

  const vm = createVM(compiled.code, compiled.initMem, { debug: compiled.debug });
  vm.runSlice(1000);
  const doneSteps = vm.getState().steps;
  assert.deepEqual(vm.getState().stdout, [120]);

  vm.seek(3);
  assert.equal(vm.getState().steps, 3);
  assert.deepEqual(vm.getState().stdout, []);

  assert.equal(vm.stepBack(), true);
  assert.equal(vm.getState().steps, 2);

  vm.seek(doneSteps);
  assert.deepEqual(vm.getState().stdout, [120]);

  vm.reset();
  assert.equal(vm.getState().steps, 0);
  assert.equal(vm.getState().ip, 0);
});

test('DEMOS.heapGc triggers semi-space GC and WHILE/trap edge cases work', () => {
  const compiled = compile(DEMOS.heapGc.code, {
    memSize: DEMOS.heapGc.memSize,
    enableRuntimeStackHeap: DEMOS.heapGc.stackHeap,
    heapMode: DEMOS.heapGc.heapMode,
  });
  const vm = createVM(compiled.code, compiled.initMem, { debug: compiled.debug });
  const traces = [];
  while (!vm.getState().halted) {
    const res = vm.step();
    if (res.event?.gcTrace) traces.push(...res.event.gcTrace);
  }
  assert.deepEqual(vm.getState().stdout, [42, 777]);
  assert.ok(traces.some((e) => e.kind === 'flip_semispace'));

  const whileRun = runBoth('X = 3\nS = 0\nWHILE X > 0\n  S = S + X\n  X = X - 1\nEND\nPRINT S', { memSize: 32 });
  assert.deepEqual(whileRun.vmState.stdout, [6]);
  assert.deepEqual(whileRun.rvState.stdout, [6]);

  const badDrum = runBoth('DIM B(8)\nDRUM_READ(9, 0, B)', { memSize: 32 });
  assert.equal(badDrum.vmState.trap?.code, 'TRAP_OOB_DRUM');
  assert.equal(badDrum.rvState.trap?.code, 'TRAP_OOB_DRUM');

  const badMem = runBoth('DIM A(2)\nA[500] = 1', { memSize: 32 });
  assert.equal(badMem.vmState.trap?.code, 'TRAP_OOB_MEM');
  assert.equal(badMem.rvState.trap?.code, 'TRAP_OOB_MEM');
});
