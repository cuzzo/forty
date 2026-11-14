import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, emitRiscv } from './compiler.js';
import { COST, DRUM_WORD_CYCLES, GAP, RECORD_SPAN, REWIND_SPEED, SECTORS, SECTOR_WORDS, TAPE_WORD_CYCLES, createVM, decode, encode, headAt, ioWait } from './vm.js';
import { DEMOS, MEM_SIZE, TAPE_DATA, compileView, describe, drumLayout, effect, layout, haltLine, marks } from './visualizer.js';

const TURN = SECTORS * SECTOR_WORDS * DRUM_WORD_CYCLES;

function run(source) {
  const vm = createVM(layout(source, MEM_SIZE).initMem);
  while (!vm.getState().halted) vm.step();
  return vm;
}

test('v4 runs Demos 1-4 from memory, records ipMap, and supports stepBack/reset', () => {
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

test('v4 highlights the line executed last and points to the line executed next', () => {
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

test('v4 says what the next instruction will do, in the names of its cells', () => {
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

test('v4 names every opcode on hover', () => {
  const seen = new Set();
  for (const demo of Object.values(DEMOS)) {
    const prog = layout(demo.code, MEM_SIZE);
    for (const instr of prog.code) {
      const text = describe(instr, prog.cells);
      assert.ok(text.startsWith(`${instr[0]} `) || text.startsWith(`${instr[0]}:`), text);
      seen.add(instr[0]);
    }
  }
  for (const op of ['TAPE_READ', 'REWIND', 'DRUM_READ', 'HALT', 'MOV', 'LOAD_IND', 'STORE_IND', 'PRINT', 'JMP', 'JAL', 'JMP_IND', 'JZ', '+', '<=']) assert.ok(seen.has(op), op);
  const fact = layout(DEMOS.factorial.code, MEM_SIZE);
  assert.equal(describe(fact.code[4], fact.cells), 'JZ (jump if zero): if M[16] tmp_16 is 0, go to instruction 9; else go to the next one');
  assert.equal(describe(fact.code[3], fact.cells), '<=: M[16] tmp_16 = M[15] I <= M[11] N (1 if true, 0 if false)');
});

test('v4 maps each memory cell to the source lines that use it', () => {
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

test('v4 replays compilation one memory cell or instruction at a time', () => {
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

test('v4 stores the program in memory ahead of its data', () => {
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

test('v4 executes whatever is in memory, so overwriting code changes the program', () => {
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

test('v4 streams a 128-word drum array through an 8-word buffer, with far fewer stalls when interleaved', () => {
  const seq = runDemo(DEMOS.drumSeq);
  const skip = runDemo(DEMOS.drumSkip);
  assert.deepEqual(seq.state.stdout, [8256]);
  assert.deepEqual(skip.state.stdout, [8256]);
  assert.ok(seq.prog.usedCells + 128 > MEM_SIZE);
  assert.deepEqual([seq.state.waited, skip.state.waited], [27381, 4341]);
  assert.equal(drumLayout(5)[5 * SECTOR_WORDS], 9);
  assert.equal(drumLayout(1)[1 * SECTOR_WORDS], 9);
});

test('v4 DRUM_READ waits for its sector, copies a word every DRUM_WORD_CYCLES, and steps back mid-transfer', () => {
  const prog = layout('DIM B(8)\nREAD DRUM 0, B\nPRINT B[7]', MEM_SIZE);
  const vm = createVM(prog.initMem, drumLayout(1));
  const b = prog.sym.B.addr;
  const left = (n) => `waiting for drum sector 0: ${n} cycle${n === 1 ? '' : 's'} left`;
  vm.step();
  assert.deepEqual([vm.getState().cycles, vm.getState().io], [COST.DRUM_READ, { kind: 'drum', sector: 0, addr: b, done: 0, count: 8 }]);
  assert.equal(ioWait(vm.getState()), TURN - COST.DRUM_READ);
  assert.equal(effect(prog, vm.getState()), left(TURN - COST.DRUM_READ));
  vm.step();
  assert.equal(effect(prog, vm.getState()), left(TURN - COST.DRUM_READ - 1));
  while (vm.getState().cycles < TURN - 1) vm.step();
  assert.equal(effect(prog, vm.getState()), left(1));
  vm.step();
  assert.equal(vm.getState().waited, TURN - COST.DRUM_READ);
  assert.equal(ioWait(vm.getState()), 0);
  assert.equal(effect(prog, vm.getState()), 'drum sector 0 word 0 (1) -> B[0]');
  assert.deepEqual(vm.step().writes, [b]);
  assert.equal(effect(prog, vm.getState()), `reading drum sector 0: next word in ${DRUM_WORD_CYCLES - 1} cycles`);
  for (let i = 0; i < DRUM_WORD_CYCLES; i++) vm.step();
  assert.deepEqual([vm.getState().io.done, vm.getState().MEM[b + 1], vm.getState().cycles], [2, 2, TURN + DRUM_WORD_CYCLES + 1]);
  vm.stepBack();
  assert.deepEqual([vm.getState().io.done, vm.getState().MEM[b + 1], vm.getState().cycles], [1, 0, TURN + DRUM_WORD_CYCLES]);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, [8]);
  assert.equal(vm.getState().cycles, TURN + 7 * DRUM_WORD_CYCLES + 1 + prog.code.slice(1).reduce((sum, [op]) => sum + COST[op], 0));
  assert.equal(ioWait({ io: { kind: 'drum', sector: 3, done: 0 }, cycles: 130 }), 3 * SECTOR_WORDS * DRUM_WORD_CYCLES - 130);
  assert.equal(ioWait({ io: null, cycles: 5 }), 0);
  assert.deepEqual(headAt(4 * SECTOR_WORDS * DRUM_WORD_CYCLES + 2), { sector: 4, word: 0 });
  assert.throws(() => { const bad = createVM(layout('DIM B(8)\nREAD DRUM 32, B', MEM_SIZE).initMem); bad.step(); }, /No drum sector 32/);
});

test('v4 explains drum reads and computes MOD', () => {
  const prog = layout('DIM B(8)\nS = 3\nREAD DRUM S, B\nPRINT MOD(17, 5)', MEM_SIZE);
  const vm = createVM(prog.initMem);
  vm.step();
  assert.equal(effect(prog, vm.getState()), `read drum sector S (3) -> B[0]..B[7], waiting ${3 * SECTOR_WORDS * DRUM_WORD_CYCLES - COST.MOV - COST.DRUM_READ} cycles first`);
  const read = prog.code.find((instr) => instr[0] === 'DRUM_READ');
  assert.match(describe(read, prog.cells), /^DRUM_READ \(read drum\): wait for drum sector M\[\d+\] S to reach the head, then copy 8 words from there on into the cells from the address in M\[\d+\] const\(\d+\)$/);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, [2]);
});

function runTape(source) {
  const prog = layout(source, MEM_SIZE);
  return { prog, vm: createVM(prog.initMem, [], TAPE_DATA) };
}

test('v4 reads the tape in order cheaply but pays a rewind to go back', () => {
  const { vm } = runTape(DEMOS.tape.code);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, [153, 1]);
  assert.equal(vm.getState().waited, 21 * RECORD_SPAN + (20 * RECORD_SPAN) / REWIND_SPEED);
  assert.ok((20 * RECORD_SPAN) / REWIND_SPEED > SECTORS * SECTOR_WORDS * DRUM_WORD_CYCLES);
});

test('v4 TAPE_READ starts the tape, copies a word every TAPE_WORD_CYCLES, and REWIND winds back', () => {
  const { prog, vm } = runTape('DIM R(8)\nREWIND\nREAD TAPE R\nREWIND\nPRINT R[7]');
  const step = (n = 1) => { for (let i = 0; i < n; i++) vm.step(); };
  const start = GAP + TAPE_WORD_CYCLES - 1;
  assert.equal(effect(prog, vm.getState()), 'rewind: tape already at the start');
  step();
  assert.equal(vm.getState().io, null);
  assert.equal(effect(prog, vm.getState()), `read tape record 1 -> R[0]..R[7], waiting ${start} cycles first`);
  step();
  assert.equal(effect(prog, vm.getState()), `tape starting: ${start} cycles left`);
  step(start - 1);
  assert.equal(effect(prog, vm.getState()), 'tape starting: 1 cycle left');
  step();
  assert.equal(effect(prog, vm.getState()), 'tape record 1 word 0 (1) -> R[0]');
  step();
  assert.equal(effect(prog, vm.getState()), `reading tape record 1: next word in ${TAPE_WORD_CYCLES - 1} cycles`);
  step(TAPE_WORD_CYCLES);
  assert.deepEqual([vm.getState().io.done, vm.getState().tapePos], [2, GAP + 2 * TAPE_WORD_CYCLES]);
  vm.stepBack();
  assert.deepEqual([vm.getState().io.done, vm.getState().tapePos], [1, GAP + 2 * TAPE_WORD_CYCLES - 1]);
  while (vm.getState().io) step();
  assert.equal(vm.getState().tapePos, RECORD_SPAN);
  assert.equal(effect(prog, vm.getState()), `rewind the tape from record 2: ${RECORD_SPAN / REWIND_SPEED} cycles`);
  step();
  assert.equal(effect(prog, vm.getState()), `rewinding: ${RECORD_SPAN / REWIND_SPEED} cycles left`);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual([vm.getState().stdout, vm.getState().tapePos], [[8], 0]);
  assert.match(describe(prog.code[1], prog.cells), /^TAPE_READ \(read tape\): start the tape, then copy the first 8 words of the next record into the cells from the address in M\[\d+\] const\(\d+\)$/);
  assert.equal(describe(prog.code[0], prog.cells), 'REWIND: wind the tape back to the start');
});

test('v4 stops at the end of the tape and rejects an unknown device', () => {
  const { vm } = runTape('DIM R(8)\nDO K = 1, 65\n  READ TAPE R\nEND');
  assert.throws(() => { while (!vm.getState().halted) vm.step(); }, /End of tape/);
  assert.throws(() => layout('DIM R(8)\nREAD DISK R', MEM_SIZE), /Expected DRUM or TAPE, got 'DISK'/);
});

test('v4 scopes SUB locals, indexes a 2D SUB argument, and rejects what does not parse', () => {
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
  ]) assert.throws(() => layout(bad, MEM_SIZE), message);
});

test('v4 undoes a step that faults, so stepping again faults again', () => {
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

test('v4 reads the drum into a SUB array argument, and stops at the end of RAM', () => {
  const prog = layout('DIM BIG(16)\nSUB LOAD(S, DST)\n  DIM DST(8)\n  READ DRUM S, DST\nEND\nCALL LOAD(1, BIG)\nPRINT BIG[0]\nPRINT BIG[7]', MEM_SIZE);
  const vm = createVM(prog.initMem, drumLayout(1));
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, [9, 16]);
  const mem = new Int32Array(MEM_SIZE);
  mem.set([encode(['DRUM_READ', 1, 2, 8]), MEM_SIZE - 3, 1]);
  const edge = createVM(mem, drumLayout(1));
  assert.throws(() => { for (;;) edge.step(); }, new RegExp(`Memory address out of bounds: ${MEM_SIZE}`));
  assert.equal(edge.getState().io.done, 3);
});

test('v4 reads the tape into a SUB array argument', () => {
  const prog = layout('DIM BIG(8)\nSUB PULL(DST)\n  DIM DST(8)\n  READ TAPE DST\nEND\nCALL PULL(BIG)\nPRINT BIG[7]', MEM_SIZE);
  const vm = createVM(prog.initMem, [], TAPE_DATA);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, [8]);
});

test('v4 points past the last line once the program halts', () => {
  assert.equal(haltLine(DEMOS.factorial.code), DEMOS.factorial.code.split('\n').length + 1);
  assert.equal(haltLine('X = 1\n\n# done?\n\n'), 4);
  assert.equal(haltLine('X = 1\n\n\n'), 2);
});

test('v4 reads as many drum words as the array holds, on through the next sector', () => {
  const read = (src) => {
    const vm = createVM(layout(src, MEM_SIZE).initMem, drumLayout(1), TAPE_DATA);
    while (!vm.getState().halted) vm.step();
    return vm.getState().stdout;
  };
  assert.deepEqual(read('DIM B(12)\nREAD DRUM 0, B\nPRINT B[11]'), [12]);
  assert.deepEqual(read('DIM B(4)\nX = 99\nREAD DRUM 0, B\nPRINT B[3]\nPRINT X'), [4, 99]);
});

test('v4 reads one tape record per READ, as many words as the array holds, and stops on a longer list', () => {
  const vm = createVM(layout('DIM R(3)\nX = 99\nREAD TAPE R\nREAD TAPE R\nPRINT R[0]\nPRINT X', MEM_SIZE).initMem, [], TAPE_DATA);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual([vm.getState().stdout, vm.getState().waited], [[9, 99], 2 * RECORD_SPAN]);
  const long = createVM(layout('DIM R(16)\nREAD TAPE R', MEM_SIZE).initMem, [], TAPE_DATA);
  assert.throws(() => long.step(), /Read-Write Check: a list of 16 words is longer than the 8-word record/);
});

// Enough of an RV32IM machine to run what emitRiscv writes: MEM at byte 0, code labels far above it.
function runRiscv(asm) {
  const lines = asm.split('\n').map((line) => line.trim());
  const mem = new Int32Array(1024);
  mem.set(lines.find((line) => line.startsWith('MEM:')).slice('MEM: .word '.length).split(', ').map(Number));
  const code = [];
  const labels = {};
  for (const line of lines.slice(lines.indexOf('.text') + 1)) {
    if (line.endsWith(':')) labels[line.slice(0, -1)] = code.length;
    else if (line && !line.startsWith('.')) code.push(line.split(/[\s,()]+/).filter(Boolean));
  }
  const CODE = 1 << 20;
  const r = {};
  const R = (name) => (name === 'zero' ? 0 : r[name] | 0);
  const out = [];
  let chars = '';
  for (let ip = labels.main, steps = 0; steps < 1e6; steps++) {
    const [op, x, y, z] = code[ip++];
    const word = (off, base) => (R(base) + Number(off)) >> 2;
    if (op === 'la') r[x] = y === 'MEM' ? 0 : CODE + labels[y];
    else if (op === 'li') r[x] = Number(y);
    else if (op === 'lw') r[x] = mem[word(y, z)];
    else if (op === 'sw') mem[word(y, z)] = R(x);
    else if (op === 'slli') r[x] = R(y) << Number(z);
    else if (op === 'xori') r[x] = R(y) ^ Number(z);
    else if (op === 'seqz') r[x] = +(R(y) === 0);
    else if (op === 'snez') r[x] = +(R(y) !== 0);
    else if (op === 'beqz') { if (R(x) === 0) ip = labels[y]; }
    else if (op === 'j') ip = labels[x];
    else if (op === 'jr') ip = R(x) - CODE;
    else if (op === 'ecall') {
      if (R('a7') === 10) return out;
      if (R('a7') === 1) chars += R('a0');
      if (R('a7') === 11) { out.push(Number(chars)); chars = ''; }
    } else {
      const ops = { add: (p, q) => p + q, sub: (p, q) => p - q, mul: Math.imul, div: (p, q) => (p / q) | 0, rem: (p, q) => p % q, slt: (p, q) => +(p < q) };
      r[x] = ops[op](R(y), R(z)) | 0;
    }
  }
  throw new Error('RISC-V program did not exit');
}

test('v4 emits RISC-V that prints what the VM prints', () => {
  for (const demo of [DEMOS.factorial, DEMOS.swap, DEMOS.saxpy, DEMOS.equiv]) {
    const prog = layout(demo.code, MEM_SIZE);
    assert.deepEqual(runRiscv(emitRiscv(prog)), run(demo.code).getState().stdout, demo.name);
  }
  const ops = 'X = 17\nPRINT X / 5\nPRINT MOD(X, 5)\nPRINT X - 20\nIF X >= 17 THEN\n  PRINT 1\nEND\nIF X <= 16 THEN\n  PRINT 2\nEND\nIF X != 17 THEN\n  PRINT 3\nEND\nPRINT X == 17\nPRINT X < 2';
  assert.deepEqual(runRiscv(emitRiscv(layout(ops, MEM_SIZE))), [3, 2, -3, 1, 1, 0]);
});

test('v4 lays memory out as one word array, with the code cells left 0', () => {
  const prog = layout(DEMOS.factorial.code, MEM_SIZE);
  const lines = emitRiscv(prog).split('\n');
  assert.deepEqual(lines.slice(2, 9), ['.text', '.globl main', 'main:', '    la s0, MEM', 'L_0:', `    lw t0, ${4 * prog.code[0][2]}(s0)`, `    sw t0, ${4 * prog.code[0][1]}(s0)`]);
  assert.deepEqual(lines[1].slice('MEM: .word '.length).split(', ').map(Number), Array.from(prog.initMem.subarray(0, prog.usedCells), (w, n) => (n < prog.codeLen ? 0 : w)));
  assert.throws(() => emitRiscv(layout(DEMOS.tape.code, MEM_SIZE)), /TAPE_READ has no RISC-V version/);
  assert.throws(() => emitRiscv(layout(DEMOS.drumSeq.code, MEM_SIZE)), /DRUM_READ has no RISC-V version/);
});
