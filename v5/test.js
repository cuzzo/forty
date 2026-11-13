import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_ROWS, COST, DRUM_WORD_CYCLES, GAP, RECORD_SPAN, REWIND_SPEED, ROW_CYCLES, SECTORS, SECTOR_WORDS, TAPE_WORD_CYCLES, createVM, decode, encode, headAt, ioWait, tagOf } from './vm.js';
import { DEMOS, MEM_SIZE, PUNCH_ORDER, TAPE_DATA, cardPunches, compileView, describe, drumLayout, effect, layout, marks, saving } from './visualizer.js';

const TURN = SECTORS * SECTOR_WORDS * DRUM_WORD_CYCLES;
// v0-v3's memory-counter code, for the tests that pin it.
const bare = (source) => layout(source, MEM_SIZE, 0);
const ops = (prog) => prog.code.map(([op]) => op);

// Runs a program to the end; without history unless a test steps back.
function run(source, { registers = 3, drum = [], tape = [], record = false } = {}) {
  const prog = layout(source, MEM_SIZE, registers);
  const vm = createVM(prog.initMem, drum, tape, record);
  while (!vm.getState().halted) vm.step();
  return { prog, vm, state: vm.getState() };
}

test('v5 runs the demos from memory, records ipMap, and supports stepBack/reset', () => {
  const fact = layout(DEMOS.factorial.code, MEM_SIZE);
  assert.equal(fact.ipMap.length, fact.code.length);
  assert.deepEqual([fact.ipMap[0], fact.ipMap.at(-1)], [1, 6]);
  assert.deepEqual(run(DEMOS.factorial.code).state.stdout, [120]);
  assert.deepEqual(run(DEMOS.swap.code).state.stdout, [99, 10, 10]);
  assert.deepEqual(run(DEMOS.saxpy.code).state.stdout, [40, 43, 46]);
  assert.deepEqual(run(DEMOS.equiv.code).state.stdout, [11, 22, 33, 44]);
  const { vm } = run(DEMOS.factorial.code, { record: true });
  assert.equal(vm.stepBack(), true);
  assert.equal(vm.stepBack(), true);
  assert.deepEqual(vm.getState().stdout, []);
  vm.reset();
  assert.deepEqual([vm.getState().pc, vm.getState().ip, vm.getState().XR[0]], [null, 0, 0]);
});

test('v5 index registers change no demo\'s output and cut the instruction cycles of its loops', () => {
  for (const demo of Object.values(DEMOS)) {
    const [regs, none] = [3, 0].map((registers) => run(demo.code, { registers, drum: demo.drum, tape: demo.tape }).state);
    assert.deepEqual([regs.stdout, regs.cards], [none.stdout, none.cards], demo.name);
    assert.ok(regs.cycles - regs.waited <= none.cycles - none.waited, demo.name);
  }
  const cpu = (registers) => {
    const { state } = run(DEMOS.drumSkip.code, { registers, drum: DEMOS.drumSkip.drum });
    return [state.stdout[0], state.cycles - state.waited, state.waited];
  };
  assert.deepEqual(cpu(3), [8256, 2800, 4229]);
  assert.deepEqual(cpu(0).slice(0, 2), [8256, 6780]);
  // Using the counter as a number costs a PXD each time, so a loop that does that a lot can come out slower.
  const heavy = [3, 0].map((registers) => run('DO I = 1, 6\n  PUNCH I, I * I, I * I * I\nEND', { registers }).state).map((st) => st.cycles - st.waited);
  assert.ok(heavy[0] > heavy[1], heavy.join(' vs '));
});

test('v5 keeps a DO counter in an index register and indexes an array with it', () => {
  const src = 'DIM A(4)\nDO I = 0, 3\n  A[I] = I * 2\nEND\nPRINT A[3]';
  const prog = layout(src, MEM_SIZE);
  assert.deepEqual(ops(prog).slice(0, 6), ['LXD', 'TXH', 'PXD', '*', 'MOV', 'TXI']);
  assert.deepEqual([tagOf(prog.code[4][1]), prog.code[4][1] & 127], [1, prog.sym.A.addr]);
  assert.deepEqual(prog.regLoops, [{ reg: 0, name: 'I', from: 0, to: 6 }]);
  assert.deepEqual(run(src).state.stdout, [6]);
  assert.ok(!ops(bare(src)).includes('LXD'));
});

test('v5 gives a loop a register only while one is free, for a local variable, outside a SUB', () => {
  const nested = 'DO P = 1, 1\n  DO Q = 1, 1\n    DO R = 1, 1\n      DO S = 1, 1\n        PRINT S\n      END\n    END\n  END\nEND';
  assert.deepEqual(layout(nested, MEM_SIZE).regLoops.map((l) => [l.name, l.reg]), [['R', 2], ['Q', 1], ['P', 0]]);
  assert.deepEqual(run(nested).state.stdout, [1]);
  assert.deepEqual(layout('SUB T(N)\n  DO I = 1, N\n    PRINT I\n  END\nEND\nCALL T(2)', MEM_SIZE).regLoops, []);
  assert.deepEqual(run('SUB T(K)\n  DO K = 1, 3\n  END\nEND\nOUT = 0\nCALL T(OUT)\nPRINT OUT').state.stdout, [4]);
  assert.deepEqual(layout('DO I = 1, 2\nEND\nDO J = 1, 2\nEND', MEM_SIZE).regLoops.map((l) => l.reg), [0, 0]);
});

test('v5 passes a register-indexed element by reference, and a register counter by value', () => {
  const src = 'DIM A(3)\nSUB BUMP(X)\n  X = X + 10\nEND\nDO I = 0, 2\n  A[I] = I\n  CALL BUMP(A[I])\n  CALL BUMP(I)\nEND\nPRINT A[0]\nPRINT A[2]';
  assert.deepEqual(run(src).state.stdout, [10, 12]);
});

test('v5 charges each instruction its IBM 704 cycles', () => {
  assert.deepEqual([COST.MOV, COST['+'], COST['*'], COST.LXD, COST.TXI, COST.TXH, COST.PXD], [4, 6, 24, 2, 2, 2, 4]);
  const { prog, state } = run('X = 6 * 7\nPRINT X');
  assert.equal(state.cycles, prog.code.reduce((sum, [op]) => sum + COST[op], 0));
  assert.deepEqual(state.stdout, [42]);
});

test('v5 PUNCH makes up 10-column fields, 7 to a card, and punches each card in 12 rows', () => {
  const prog = layout('N = 0 - 9\nPUNCH 1, 2, 3, 4, 5, 6, 7, 8, N', MEM_SIZE);
  assert.deepEqual(ops(prog).filter((op) => op === 'CARD' || op === 'PUNCH').join(' '), 'CARD CARD CARD CARD CARD CARD CARD PUNCH CARD CARD PUNCH');
  const vm = createVM(prog.initMem);
  while (!vm.getState().pending.length) vm.step();
  assert.equal(effect(prog, vm.getState()), 'put const(2) (2) in field 2 of the card');
  while (vm.getState().pending.length < 7) vm.step();
  assert.equal(effect(prog, vm.getState()), `punch the card (1, 2, 3, 4, 5, 6, 7), taking ${CARD_ROWS * ROW_CYCLES} cycles`);
  vm.step();
  assert.equal(effect(prog, vm.getState()), `punching a card: row 9 in ${ROW_CYCLES} cycles`);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual([vm.getState().cards, vm.getState().stdout], [[[1, 2, 3, 4, 5, 6, 7], [8, -9]], []]);
  assert.equal(vm.getState().waited, 2 * CARD_ROWS * ROW_CYCLES);
  assert.deepEqual(cardPunches([120, -5]), [{ col: 7, row: 1 }, { col: 8, row: 2 }, { col: 9, row: 0 }, { col: 18, row: 11 }, { col: 19, row: 5 }]);
  assert.deepEqual(PUNCH_ORDER.slice(0, 2), [9, 8]);
  assert.match(describe(prog.code.find(([op]) => op === 'CARD'), prog.cells), /^CARD: put M\[\d+\] const\(1\) in the next 10-column field/);
  assert.match(describe(prog.code.find(([op]) => op === 'PUNCH'), prog.cells), /^PUNCH: punch the card made up so far/);
});

test('v5 Back restores the index registers, the card being made up and the punched cards', () => {
  const prog = layout('DO I = 1, 2\n  PUNCH I\nEND', MEM_SIZE);
  const vm = createVM(prog.initMem);
  vm.step();
  assert.equal(vm.getState().XR[0], 1);
  vm.stepBack();
  assert.equal(vm.getState().XR[0], 0);
  while (!vm.getState().pending.length) vm.step();
  vm.stepBack();
  assert.deepEqual(vm.getState().pending, []);
  while (!vm.getState().cards.length) vm.step();
  vm.stepBack();
  assert.deepEqual([vm.getState().cards.length, vm.getState().io.done], [0, CARD_ROWS - 1]);
});

test('v5 explains the index register instructions and indexed operands', () => {
  const prog = layout('DIM A(4)\nDO I = 0, 3\n  A[I] = I * 2\nEND', MEM_SIZE);
  const vm = createVM(prog.initMem);
  const next = () => effect(prog, vm.getState());
  assert.equal(next(), 'const(0) (0) -> index register A');
  vm.step();
  assert.equal(next(), 'A (0) <= const(3) (3): next');
  vm.step();
  assert.match(next(), /^index register A \(0\) -> tmp_\d+$/);
  vm.step();
  vm.step();
  assert.match(next(), /-> A\[0\] \[via A\]$/);
  vm.step();
  assert.equal(next(), 'A = 0 + 1 = 1, go to 1');
  while (vm.getState().XR[0] < 4) vm.step();
  assert.equal(next(), 'A (4) > const(3) (3): leave the loop, go to 6');
  const text = prog.code.slice(0, 6).map((instr) => describe(instr, prog.cells));
  assert.match(text[0], /^LXD \(load index from decrement\): index register A = M\[\d+\] const\(0\)$/);
  assert.match(text[1], /^TXH \(transfer on index high\): if index register A > M\[\d+\] const\(3\), go to instruction 6$/);
  assert.match(text[2], /^PXD \(place index in decrement\): M\[\d+\] tmp_\d+ = index register A$/);
  assert.match(text[4], /^MOV \(move\): copy M\[\d+\] tmp_\d+ into M\[\d+ \+ A\] A\[0\] onward$/);
  assert.equal(text[5], 'TXI (transfer with index incremented): add 1 to index register A, go to instruction 1');
});

test('v5 DRUM_READ waits for its sector, then copies a word every DRUM_WORD_CYCLES', () => {
  const prog = layout('DIM B(8)\nREAD DRUM 0, B\nPRINT B[7]', MEM_SIZE);
  const vm = createVM(prog.initMem, drumLayout(1));
  const said = effect(prog, vm.getState());
  vm.step();
  assert.equal(vm.getState().cycles, COST.DRUM_READ);
  assert.match(said, new RegExp(`waiting ${ioWait(vm.getState())} cycles first$`));
  assert.equal(ioWait(vm.getState()), TURN - COST.DRUM_READ);
  while (!vm.getState().MEM[prog.sym.B.addr]) vm.step();
  assert.equal(vm.getState().cycles, TURN + 1);
  while (vm.getState().io) vm.step();
  assert.equal(vm.getState().cycles, TURN + 7 * DRUM_WORD_CYCLES + 1);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, [8]);
  assert.deepEqual(headAt(DRUM_WORD_CYCLES * SECTOR_WORDS * 3), { sector: 3, word: 0 });
  const demo = (d) => run(d.code, { drum: d.drum }).state.waited;
  assert.deepEqual([demo(DEMOS.drumSeq), demo(DEMOS.drumSkip)], [31109, 4229]);
});

test('v5 reads the tape at the IBM 727\'s speed and rewinds at that same speed', () => {
  const { state } = run(DEMOS.tape.code, { tape: TAPE_DATA });
  assert.deepEqual(state.stdout, [153, 1]);
  assert.equal(REWIND_SPEED, 1);
  assert.equal(state.waited, 21 * RECORD_SPAN + (20 * RECORD_SPAN) / REWIND_SPEED);
  assert.equal(ioWait({ io: { kind: 'tape' }, tapePos: 0 }), GAP + TAPE_WORD_CYCLES - 1);
  assert.throws(() => run('DIM R(8)\nDO K = 1, 65\n  READ TAPE R\nEND', { tape: TAPE_DATA }), /End of tape/);
});

test('v5 highlights the line executed last and points to the line executed next', () => {
  const { initMem, ipMap } = layout(DEMOS.factorial.code, MEM_SIZE);
  const vm = createVM(initMem);
  assert.deepEqual(marks(ipMap, vm.getState()), { lastIp: null, nextIp: 0, lastLine: null, nextLine: 1 });
  while (!vm.getState().halted) {
    const before = marks(ipMap, vm.getState());
    vm.step();
    assert.equal(marks(ipMap, vm.getState()).lastIp, before.nextIp);
  }
  assert.deepEqual([marks(ipMap, vm.getState()).nextLine, marks(ipMap, vm.getState()).lastLine], [null, 6]);
});

test('v5 says what each instruction will do, and names every opcode on hover', () => {
  const prog = layout(DEMOS.swap.code, MEM_SIZE);
  const vm = createVM(prog.initMem);
  const seen = [];
  while (!vm.getState().halted) {
    seen.push(effect(prog, vm.getState()));
    vm.step();
  }
  assert.equal(effect(prog, vm.getState()), 'halted');
  assert.ok(seen.some((line) => / -> \*SWAP\.A = const\(2\) \[\d+\]$/.test(line)), seen.join('\n'));
  assert.ok(['call ', 'return to ', 'print '].every((start) => seen.some((line) => line.startsWith(start))));
  const names = new Set();
  for (const demo of Object.values(DEMOS)) {
    const p = layout(demo.code, MEM_SIZE);
    for (const instr of p.code) {
      assert.match(describe(instr, p.cells), new RegExp(`^${instr[0].replace(/[*+]/g, '\\$&')}[ :]`));
      names.add(instr[0]);
    }
  }
  for (const op of ['LXD', 'PXD', 'TXH', 'TXI', 'CARD', 'PUNCH', 'TAPE_READ', 'REWIND', 'DRUM_READ', 'HALT', 'MOV', 'LOAD_IND', 'STORE_IND', 'PRINT', 'JMP', 'JAL', 'JMP_IND', 'JZ', '+', '<=']) assert.ok(names.has(op), op);
});

test('v5 maps cells to source lines and replays compilation, as v1-v3 do without registers', () => {
  const lines = (prog, label) => [...prog.cellLines[prog.cells.findIndex((c) => c.label === label)]].sort((a, b) => a - b);
  const fact = bare(DEMOS.factorial.code);
  assert.deepEqual([lines(fact, 'N'), lines(fact, 'FACT'), lines(fact, 'I')], [[1, 3], [2, 4, 6], [3, 4]]);
  assert.deepEqual(lines(bare(DEMOS.swap.code), 'SWAP.A'), [1, 2, 3, 8, 11]);
  assert.deepEqual(lines(bare(DEMOS.equiv.code), 'WORKSPACE[3]'), [1, 2, 3, 4, 5, 6, 8]);
  for (const demo of Object.values(DEMOS)) {
    const prog = layout(demo.code, MEM_SIZE);
    const done = compileView(prog, prog.events.length);
    assert.deepEqual([done.cells, done.code], [prog.usedCells, prog.code]);
    assert.deepEqual(prog.code.at(-1), ['HALT', 0, 0, 0]);
    prog.code.forEach((instr, ip) => assert.deepEqual(decode(prog.initMem[ip]), instr));
  }
  const k = fact.events.findIndex((ev) => ev.kind === 'patch');
  assert.deepEqual([compileView(fact, k).code[4], compileView(fact, k + 1).code[4]], [['JZ', 0, 16, 0], ['JZ', 9, 16, 0]]);
  assert.equal(describe(fact.code[4], fact.cells), 'JZ (jump if zero): if M[16] tmp_16 is 0, go to instruction 9; else go to the next one');
  assert.throws(() => layout(DEMOS.saxpy.code, 64), /Program does not fit in 64 cells of RAM/);
});

test('v5 scopes SUB locals, reads devices into SUB arrays, and rejects what does not parse or run', () => {
  const src = ['I = 77', 'DIM G(2, 2)', 'SUB FILL(M)', '  DIM M(2, 2)', '  DO I = 0, 1', '    M[I, 1] = (I + 1) * 10', '  END', 'END', 'CALL FILL(G)', 'PRINT I', 'PRINT G[1, 1]'].join('\n');
  assert.deepEqual(run(src).state.stdout, [77, 20]);
  assert.deepEqual(run('DIM BIG(16)\nSUB LOAD(S, DST)\n  READ DRUM S, DST\nEND\nCALL LOAD(1, BIG)\nPRINT BIG[0]\nPRINT BIG[7]', { drum: drumLayout(1) }).state.stdout, [9, 16]);
  assert.deepEqual(run('DIM BIG(8)\nSUB PULL(DST)\n  READ TAPE DST\nEND\nCALL PULL(BIG)\nPRINT BIG[7]', { tape: TAPE_DATA }).state.stdout, [8]);
  for (const [bad, message] of [
    ['X = 3.14', /Expected identifier, got '\.'/],
    ['X = 1\nEND\nPRINT X', /Expected 'end of input', got 'END'/],
    ['DIM R(8)\nREAD DISK R', /Expected DRUM or TAPE, got 'DISK'/],
  ]) assert.throws(() => layout(bad, MEM_SIZE), message);
  const vm = createVM(layout('X = 0\nY = 5 / X\nPRINT 7', MEM_SIZE).initMem);
  vm.step();
  const at = [vm.getState().ip, vm.getState().steps];
  assert.throws(() => vm.step(), /Division by zero/);
  assert.deepEqual([vm.getState().ip, vm.getState().steps], at);
  assert.throws(() => run('DIM A(2)\nA[200] = 1'), /Memory address out of bounds/);
  assert.equal(effect(layout('X = 1', MEM_SIZE), createVM([31 << 27]).getState()), 'unknown opcode ?31');
  assert.equal(decode(encode(['MOV', 5 | (2 << 7), 6, 0]))[1] >> 7, 2);
});

test('v5 credits each instruction\'s saving as it runs, adding up to the whole-run difference', () => {
  const live = (source, demo) => {
    const prog = layout(source, MEM_SIZE);
    const vm = createVM(prog.initMem, demo.drum, demo.tape, false);
    let total = 0;
    while (!vm.getState().halted) {
      const s = vm.getState();
      if (!s.io) total += saving(decode(s.MEM[s.ip]));
      vm.step();
    }
    return total;
  };
  const cpu = (source, registers, demo) => {
    const { state } = run(source, { registers, drum: demo.drum, tape: demo.tape });
    return state.cycles - state.waited;
  };
  const heavy = { code: 'DO I = 1, 6\n  PUNCH I, I * I, I * I * I\nEND' };
  for (const demo of [...Object.values(DEMOS), heavy]) assert.equal(live(demo.code, demo), cpu(demo.code, 0, demo) - cpu(demo.code, 3, demo), demo.name);
  assert.deepEqual(['TXH', 'TXI', 'LXD', 'PXD'].map((op) => saving([op, 0, 0, 0])), [10, 6, 2, -4]);
  assert.deepEqual([saving(['MOV', 5 | (1 << 7), 6, 0]), saving(['+', 7, 5 | (1 << 7), 6]), saving(['MOV', 5, 6, 0])], [8, 12, 0]);
  assert.equal(live(heavy.code, heavy), -36);
});
