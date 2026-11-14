import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_ROWS, COST_704, DRUM_WORD_CYCLES, RECORD_SPAN, ROW_CYCLES, SECTORS, SECTOR_WORDS, createVM, decode, encode, ioWait, tagOf, tagged } from './vm.js';
import { DEMOS, MEM_SIZE, TAPE_DATA, asm, compileView, describe, drumLayout, effect, layout, haltLine, marks } from './visualizer.js';

const TURN = SECTORS * SECTOR_WORDS * DRUM_WORD_CYCLES;
const ops = (prog) => prog.code.map(([op]) => op);

// Runs a program to the end; without history unless a test steps back.
function run(source, { registers = 2, drum = [], tape = [], record = false } = {}) {
  const prog = layout(source, registers);
  const vm = createVM(prog.initMem, drum, tape, record);
  while (!vm.getState().halted) vm.step();
  return { prog, vm, state: vm.getState() };
}

// Every demo's output, as v5 gives it.
const OUTPUT = {
  factorial: [120], swap: [99, 10, 10], saxpy: [40, 43, 46], equiv: [11, 22, 33, 44], drumSeq: [8256], drumSkip: [8256],
  tape: [153, 1], squares: [], arraySum: [], formula: [23], largest: [7],
};

test('v6 runs every demo with and without index registers, as v5 does', () => {
  for (const [k, demo] of Object.entries(DEMOS)) {
    for (const registers of [2, 0]) assert.deepEqual(run(demo.code, { registers, drum: demo.drum, tape: demo.tape }).state.stdout, OUTPUT[k], `${demo.name} ${registers}`);
  }
  assert.deepEqual(run(DEMOS.squares.code).state.cards, [1, 2, 3, 4, 5, 6].map((i) => [i, i * i]));
  assert.deepEqual(run(DEMOS.arraySum.code).state.cards, [[570]]);
});

test('v6 compiles an expression through the AC, and a product through the MQ', () => {
  const prog = layout('A = 2\nB = 3\nC = 7\nX = A + B * C');
  assert.deepEqual(prog.code.slice(6).map(asm), ['LDQ ' + prog.sym.B.addr, 'MPY ' + prog.sym.C.addr, `STQ ${prog.code[8][1]}`, `CLA ${prog.sym.A.addr}`, `ADD ${prog.code[8][1]}`, `STO ${prog.sym.X.addr}`, 'HALT']);
  // A + B is in the AC when C + D needs it, so it is stored to a temporary first.
  const spill = layout('A = 1\nB = 2\nC = 3\nD = 4\nX = (A + B) * (C + D)\nPRINT X');
  assert.deepEqual(ops(spill).slice(8, 15), ['CLA', 'ADD', 'STO', 'CLA', 'ADD', 'STO', 'LDQ']);
  assert.deepEqual(run('A = 1\nB = 2\nC = 3\nD = 4\nX = (A + B) * (C + D)\nPRINT X').state.stdout, [21]);
  assert.deepEqual(run('X = 17\nPRINT X / 5\nPRINT MOD(X, 5)\nPRINT -X + 20\nPRINT 0 - 7 / 2').state.stdout, [3, 2, 3, -3]);
  assert.ok(ops(layout('PRINT -X')).includes('CLS'));
  assert.throws(() => layout('X = 1 < 2'), /'<' is allowed only in an IF test/);
});

test('v6 tests a condition with a subtract and a transfer on the AC\'s sign', () => {
  const cases = [['==', 3, 3], ['==', 3, 4], ['!=', 3, 4], ['!=', 4, 4], ['<', 3, 4], ['<', 4, 4], ['>', 5, 4], ['>', 4, 4], ['<=', 4, 4], ['<=', 5, 4], ['>=', 4, 4], ['>=', 3, 4]];
  for (const [op, x, y] of cases) {
    const want = { '==': x === y, '!=': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[op] ? 1 : 0;
    assert.deepEqual(run(`X = ${x}\nY = ${y}\nIF X ${op} Y THEN\n  PRINT 1\nELSE\n  PRINT 0\nEND`).state.stdout, [want], `${x} ${op} ${y}`);
  }
  assert.deepEqual(run('X = 0\nIF X THEN\n  PRINT 1\nEND\nIF X + 2 THEN\n  PRINT 2\nEND').state.stdout, [2]);
  const prog = layout(DEMOS.largest.code);
  assert.deepEqual(ops(prog).slice(4, 7), ['CLA', 'SUB', 'TPL']);
});

test('v6 counts a DO loop in A or B, and in memory without them', () => {
  const src = 'DIM A(4)\nDO I = 0, 3\n  A[I] = I * 2\nEND\nPRINT A[3]';
  const prog = layout(src);
  assert.deepEqual(prog.code.slice(0, 3).map(asm), [`LXD ${prog.code[0][1]},A`, `TXH 10,A,${prog.code[1][2]}`, 'PXD 0,A']);
  assert.equal(asm(prog.code[8]), `STO ${prog.sym.A.addr},A`);
  assert.deepEqual(run(src).state.stdout, [6]);
  const nested = 'DO P = 1, 1\n  DO Q = 1, 1\n    DO R = 1, 1\n      PRINT R\n    END\n  END\nEND';
  assert.deepEqual(layout(nested).regLoops.map((l) => [l.name, l.reg]), [['Q', 1], ['P', 0]]);
  assert.deepEqual(run(nested).state.stdout, [1]);
  assert.deepEqual(ops(layout(src, 0)).slice(0, 5), ['CLA', 'STO', 'CLA', 'SUB', 'TMI']);
  const cpu = (registers) => run(DEMOS.drumSkip.code, { registers, drum: DEMOS.drumSkip.drum }).state;
  assert.ok(cpu(2).cycles - cpu(2).waited < cpu(0).cycles - cpu(0).waited);
});

test('v6 calls a SUB with TSX through index register C, and reaches arguments through C', () => {
  const prog = layout(DEMOS.swap.code);
  const entry = prog.subs.SWAP.entryIp;
  assert.equal(asm(prog.code[entry]), `SXD ${prog.cells.findIndex((c) => c.label === 'SWAP.ret')},C`);
  assert.deepEqual(prog.code.slice(entry + 1, entry + 3).map(asm), [`LXD ${prog.subs.SWAP.params[0]},C`, 'CLA 0,C']);
  assert.ok(prog.code.some((instr) => asm(instr) === `TSX ${entry},C`));
  assert.ok(prog.code.some((instr) => asm(instr) === 'TRA 1,C'));
  const src = 'DIM A(3)\nSUB BUMP(X)\n  X = X + 10\nEND\nDO I = 0, 2\n  A[I] = I\n  CALL BUMP(A[I])\n  CALL BUMP(I)\nEND\nPRINT A[0]\nPRINT A[2]';
  assert.deepEqual(run(src).state.stdout, [10, 12]);
  assert.deepEqual(run('SUB T(K)\n  DO K = 1, 3\n  END\nEND\nOUT = 0\nCALL T(OUT)\nPRINT OUT').state.stdout, [4]);
  const scoped = ['I = 77', 'DIM G(2, 2)', 'SUB FILL(M)', '  DIM M(2, 2)', '  DO I = 0, 1', '    M[I, 1] = (I + 1) * 10', '  END', 'END', 'CALL FILL(G)', 'PRINT I', 'PRINT G[1, 1]'].join('\n');
  assert.deepEqual(run(scoped).state.stdout, [77, 20]);
});

test('v6 charges 2 cycles an instruction, 20 for MPY and DVP', () => {
  const { prog, state } = run('X = 6 * 7\nY = X / 2\nPRINT Y');
  assert.equal(state.cycles, prog.code.reduce((sum, [op]) => sum + (COST_704[op] ?? 2), 0));
  assert.deepEqual([COST_704.MPY, COST_704.DVP, state.stdout], [20, 20, [21]]);
});

test('v6 Back restores the AC, the MQ and the index registers', () => {
  const vm = createVM(layout('X = 6 * 7').initMem);
  vm.step();
  vm.step();
  assert.deepEqual([vm.getState().MQ, vm.getState().AC], [42, 0]);
  vm.stepBack();
  assert.deepEqual([vm.getState().MQ], [6]);
  vm.reset();
  assert.deepEqual([vm.getState().AC, vm.getState().MQ, vm.getState().ip], [0, 0, 0]);
});

test('v6 says what each instruction will do, and names every opcode on hover', () => {
  const prog = layout('X = 7\nY = 0 - X\nIF X > Y THEN\n  PRINT X * 2\nEND');
  const vm = createVM(prog.initMem);
  const seen = [];
  while (!vm.getState().halted) {
    seen.push(effect(prog, vm.getState()));
    vm.step();
  }
  assert.equal(effect(prog, vm.getState()), 'halted');
  assert.deepEqual(seen.slice(0, 2), ['const(7) (7) -> AC', 'AC (7) -> X']);
  assert.ok(seen.includes('AC (0) - X (7) = -7 -> AC'), seen.join('\n'));
  assert.ok(seen.includes('AC (-14) < 0: next'), seen.join('\n'));
  assert.ok(seen.includes('MQ (7) * const(2) (2) = 14 -> MQ'), seen.join('\n'));
  const calls = createVM(layout(DEMOS.swap.code).initMem);
  const swap = layout(DEMOS.swap.code);
  const said = [];
  while (!calls.getState().halted) {
    said.push(effect(swap, calls.getState()));
    calls.step();
  }
  assert.ok(said.some((line) => /^call 1: \d+ \(this instruction\) -> index register C$/.test(line)), said.join('\n'));
  assert.ok(said.some((line) => /^return to \d+ \(C \+ 1\)$/.test(line)), said.join('\n'));
  const names = new Set();
  for (const demo of Object.values(DEMOS)) {
    const p = layout(demo.code);
    for (const instr of p.code) {
      assert.match(describe(instr, p.cells), new RegExp(`^${instr[0]}[ :]`));
      names.add(instr[0]);
    }
  }
  for (const op of ['CLA', 'ADD', 'SUB', 'STO', 'LDQ', 'STQ', 'MPY', 'DVP', 'TRA', 'TPL', 'TMI', 'TSX', 'LXD', 'SXD', 'PXD', 'TXH', 'TXI', 'CARD', 'PUNCH', 'DRUM_READ', 'TAPE_READ', 'REWIND', 'PRINT', 'HALT']) assert.ok(names.has(op), op);
  assert.match(describe(['TRA', tagged(1, 2), 0, 0], prog.cells), /^TRA \(transfer\): go to instruction 1 \+ index register C/);
  assert.equal(describe(['?7', 0, 0, 0], prog.cells), '?7: unknown opcode');
});

test('v6 keeps v5\'s devices, cards, marks and compile walk', () => {
  const vm = createVM(layout('DIM B(8)\nREAD DRUM 0, B\nPRINT B[7]').initMem, drumLayout(1));
  vm.step();
  assert.equal(ioWait(vm.getState()), TURN - 2);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual(vm.getState().stdout, [8]);
  const { state } = run(DEMOS.tape.code, { tape: TAPE_DATA });
  assert.equal(state.waited, 21 * RECORD_SPAN + 20 * RECORD_SPAN);
  const cards = run('PUNCH 1, 2, 3, 4, 5, 6, 7, 8').state;
  assert.deepEqual([cards.cards, cards.waited], [[[1, 2, 3, 4, 5, 6, 7], [8]], 2 * CARD_ROWS * ROW_CYCLES]);
  const fact = layout(DEMOS.factorial.code);
  const m = createVM(fact.initMem);
  assert.deepEqual(marks(fact.ipMap, m.getState()), { lastIp: null, nextIp: 0, lastLine: null, nextLine: 1 });
  for (const demo of Object.values(DEMOS)) {
    const prog = layout(demo.code);
    const done = compileView(prog, prog.events.length);
    assert.deepEqual([done.cells, done.code], [prog.usedCells, prog.code]);
    prog.code.forEach((instr, ip) => assert.deepEqual(decode(prog.initMem[ip]), instr));
  }
  assert.throws(() => run('X = 0\nY = 5 / X'), /Division by zero/);
  assert.throws(() => run('DIM A(2)\nA[400] = 1'), /Memory address out of bounds/);
  assert.throws(() => layout('X = 3.14'), /Expected identifier, got '\.'/);
  assert.throws(() => layout('DIM A(0)'), /Expected an array size, got '0'/);
  assert.throws(() => layout('DIM A(N)'), /Expected an array size, got 'N'/);
  assert.equal(effect(layout('X = 1'), createVM([31 << 27]).getState()), 'unknown opcode ?31');
  assert.deepEqual(decode(encode(['TXH', tagged(255, 1), 200, 300])), ['TXH', tagged(255, 1), 200, 300]);
  assert.equal(tagOf(tagged(5, 1)), 2);
});

test('v6 points past the last line once the program halts', () => {
  assert.equal(haltLine(DEMOS.factorial.code), DEMOS.factorial.code.split('\n').length + 1);
  assert.equal(haltLine('X = 1\n\n# done?\n\n'), 4);
  assert.equal(haltLine('X = 1\n\n\n'), 2);
});

test('v6 reads as many drum words as the array holds, on through the next sector', () => {
  const read = (src) => {
    const vm = createVM(layout(src).initMem, drumLayout(1), TAPE_DATA);
    while (!vm.getState().halted) vm.step();
    return vm.getState().stdout;
  };
  assert.deepEqual(read('DIM B(12)\nREAD DRUM 0, B\nPRINT B[11]'), [12]);
  assert.deepEqual(read('DIM B(4)\nX = 99\nREAD DRUM 0, B\nPRINT B[3]\nPRINT X'), [4, 99]);
});

test('v6 reads one tape record per READ, as many words as the array holds, and stops on a longer list', () => {
  const vm = createVM(layout('DIM R(3)\nX = 99\nREAD TAPE R\nREAD TAPE R\nPRINT R[0]\nPRINT X').initMem, [], TAPE_DATA);
  while (!vm.getState().halted) vm.step();
  assert.deepEqual([vm.getState().stdout, vm.getState().waited], [[9, 99], 2 * RECORD_SPAN]);
  const long = createVM(layout('DIM R(16)\nREAD TAPE R').initMem, [], TAPE_DATA);
  assert.throws(() => long.step(), /Read-Write Check: a list of 16 words is longer than the 8-word record/);
});

test('v6 takes a comparison wherever an IF test can be written, and nowhere else', () => {
  assert.deepEqual(run('X = 4\nY = 7\nIF (X < Y) THEN\n  PRINT 1\nEND\nIF (X + 1) * 2 > Y THEN\n  PRINT 2\nEND').state.stdout, [1, 2]);
  assert.throws(() => layout('X = (1 < 2)'), /'<' is allowed only in an IF test/);
  assert.throws(() => layout('IF 1 < 2 < 3 THEN\nEND'), /'<' is allowed only in an IF test/);
});

test('v6 indexes only an address: a DO bound or start, or a drum sector, read through a register goes to a plain cell first', () => {
  const src = 'DIM B(3)\nB[0] = 1\nDO I = 0, 2\n  DO J = B[I], 2\n    PRINT J\n  END\nEND';
  const regOps = layout(src).code.filter(([op]) => ['LXD', 'TXH'].includes(op));
  assert.ok(regOps.every(([op, a, b]) => tagOf(a) === 0 && tagOf(b) === 0), regOps.map(asm).join(' '));
  assert.deepEqual(run(src).state.stdout, [1, 2, 0, 1, 2, 0, 1, 2]);
  const bound = 'DIM A(3)\nA[0] = 2\nA[1] = 3\nA[2] = 1\nS = 0\nDO I = 0, 2\n  DO J = 1, A[I]\n    S = S + J\n  END\nEND\nPRINT S';
  assert.deepEqual([run(bound).state.stdout, run(bound, { registers: 0 }).state.stdout], [[10], [10]]);
  const sector = layout('DIM S(2)\nDIM BUF(8)\nS[1] = 1\nDO I = 1, 1\n  READ DRUM S[I], BUF\nEND').code.find(([op]) => op === 'DRUM_READ');
  assert.equal(tagOf(sector[2]), 0);
});

test('v6 reads a READ list of any length that fits in memory, and names no code cell on hover', () => {
  const drum = Int32Array.from({ length: SECTORS * SECTOR_WORDS }, (_, i) => i + 1);
  assert.deepEqual(run('DIM BUF(200)\nREAD DRUM 0, BUF\nPRINT BUF[199]', { drum }).state.stdout, [200]);
  const swap = layout(DEMOS.swap.code);
  assert.equal(describe(swap.code.find((instr) => asm(instr) === 'CLA 0,C'), swap.cells), 'CLA (clear and add): AC = M[0 + C]');
  assert.throws(() => layout('DIM BIG(300)'), new RegExp(`Program does not fit in ${MEM_SIZE} cells of RAM`));
});
