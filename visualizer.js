// The visualizer every version uses. Each vN/visualizer.js passes its compiler, its VM, its memory size and the
// features it has covered so far; the page shows those parts and no others.
//
// Features: 'code' (the program is in memory, v1), 'drum' (v2), 'tape' (v3), 'cards' and 'index' (punched cards
// and index registers, v5), 'accumulator' (one-address 704 code with the AC and MQ, v6).
import { CARD_ROWS, COST, COST_704, DRUM_WORD_CYCLES, GAP, ROW_CYCLES, RECORDS, RECORD_SPAN, RECORD_WORDS, SECTORS, SECTOR_WORDS, TAPE_WORD_CYCLES, headAt, ioWait } from './machine.js';

// The 128-word array 1, 2, ... on the drum: 16 blocks of 8, block K stored in sector MOD(K * skip, 32).
export function drumLayout(skip) {
  const drum = new Int32Array(SECTORS * SECTOR_WORDS);
  for (let k = 0; k < 16; k++) {
    for (let w = 0; w < SECTOR_WORDS; w++) drum[((k * skip) % SECTORS) * SECTOR_WORDS + w] = k * SECTOR_WORDS + w + 1;
  }
  return drum;
}

// Record R of the tape holds 8R+1 .. 8R+8.
export const TAPE_DATA = Int32Array.from({ length: RECORDS * RECORD_WORDS }, (_, i) => i + 1);

const drumSum = (skip) => `DIM BUF(8)\nSKIP = ${skip}\nSUM = 0\nDO K = 0, 15\n  READ DRUM MOD(K * SKIP, 32), BUF\n  DO I = 0, 7\n    SUM = SUM + BUF[I]\n  END\nEND\nPRINT SUM`;

// Every demo, with the feature it needs. drumSkip: the interleave that suits the version's loop speed.
function demos(has, drumSkip) {
  const all = {
    factorial: { name: 'factorial.f', code: 'N = 5\nFACT = 1\nDO I = 1, N\n  FACT = FACT * I\nEND\nPRINT FACT' },
    swap: { name: 'swap.f', code: 'SUB SWAP(A, B)\n  TMP = A\n  A = B\n  B = TMP\nEND\nX = 10\nY = 99\nCALL SWAP(X, Y)\nPRINT X\nPRINT Y\nCALL SWAP(2, Y)\nPRINT 2' },
    saxpy: { name: 'saxpy.f', code: 'DIM A(3, 2)\nDIM Y(3)\nSUB SAXPY(N, ALPHA, X, OUT)\n  DO I = 0, N - 1\n    OUT[I] = ALPHA * X[I] + OUT[I]\n  END\nEND\nDO C = 0, 1\n  DO R = 0, 2\n    A[R, C] = (C + 1) * 10 + R\n  END\nEND\nCALL SAXPY(3, 2, A[0, 0], Y)\nCALL SAXPY(3, 1, A[0, 1], Y)\nDO I = 0, 2\n  PRINT Y[I]\nEND' },
    equiv: { name: 'equiv.f', code: 'DIM WORKSPACE(4)\nEQUIV VIEW_A(2, 2) = WORKSPACE\nVIEW_A[0, 0] = 11\nVIEW_A[1, 0] = 22\nVIEW_A[0, 1] = 33\nVIEW_A[1, 1] = 44\nDO I = 0, 3\n  PRINT WORKSPACE[I]\nEND' },
    drumSeq: { needs: 'drum', name: 'drum_in_order.f', code: drumSum(1), drum: drumLayout(1) },
    drumSkip: { needs: 'drum', name: 'drum_interleaved.f', code: drumSum(drumSkip), drum: drumLayout(drumSkip) },
    tape: { needs: 'tape', name: 'tape_rewind.f', code: 'DIM R(8)\nDO K = 1, 20\n  READ TAPE R\nEND\nPRINT R[0]\nREWIND\nREAD TAPE R\nPRINT R[0]', tape: TAPE_DATA },
    squares: { needs: 'cards', name: 'squares_punch.f', code: 'DO I = 1, 6\n  PUNCH I, I * I\nEND' },
    arraySum: { needs: 'cards', name: 'array_sum_punch.f', code: 'DIM A(20)\nDO I = 0, 19\n  A[I] = I * 3\nEND\nSUM = 0\nDO I = 0, 19\n  SUM = SUM + A[I]\nEND\nPUNCH SUM' },
    formula: { needs: 'accumulator', name: 'formula.f', code: 'A = 2\nB = 3\nC = 7\nX = A + B * C\nPRINT X' },
    largest: { needs: 'accumulator', name: 'largest.f', code: 'X = 4\nY = 7\nIF X > Y THEN\n  PRINT X\nELSE\n  PRINT Y\nEND' },
  };
  return Object.fromEntries(Object.entries(all).filter(([, d]) => !d.needs || has(d.needs)));
}

// The instruction (and its source line) executed last, and the one executed next.
export function marks(ipMap, state, focusIp = null) {
  const lastIp = focusIp ?? state.pc;
  const nextIp = state.halted ? null : state.ip;
  return {
    lastIp,
    nextIp,
    lastLine: lastIp === null ? null : ipMap[lastIp],
    nextLine: nextIp === null ? null : ipMap[nextIp],
  };
}

// The memory and instructions after the first k compile events, and what event k touched.
export function compileView(prog, k) {
  const view = { cells: 0, code: [], line: null, newCell: null, newIp: null };
  for (const ev of prog.events.slice(0, k)) {
    view.line = ev.line;
    if (ev.kind === 'alloc') {
      view.cells = ev.base + ev.size;
      view.newCell = ev.base;
      view.newIp = null;
    } else {
      view.code[ev.ip] = ev.instr;
      view.newIp = ev.ip;
      view.newCell = null;
    }
  }
  return view;
}

// Once halted, the line after the program's last line: the program has run off its end.
export const haltLine = (source) => source.trimEnd().split('\n').length + 1;

// A card's 12 rows from its top edge. Each number is punched right-justified in its own 10-column field, Hollerith
// style: each digit in its own row, '-' in row 11.
const CARD_ROWS_TOP = [12, 11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
// A punch takes the card 9-edge first, so row 9 is punched first and row 12 last.
export const PUNCH_ORDER = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12];

const fields = (values) => values.map((v) => String(v).padStart(10)).join('');

export function cardPunches(values) {
  return [...fields(values)].flatMap((ch, col) => (ch === ' ' ? [] : [{ col, row: ch === '-' ? 11 : Number(ch) }]));
}

const cyc = (n) => `${n} cycle${n === 1 ? '' : 's'}`;
const reg = (r) => 'ABC'[r];

// A device still working: a drum or tape read, a rewind, or a card being punched.
function deviceEffect(state, name) {
  const { kind, sector, addr, done } = state.io;
  const wait = ioWait(state);
  const record = Math.floor(state.tapePos / RECORD_SPAN);
  if (kind === 'punch') return `punching a card: row ${PUNCH_ORDER[done]} in ${cyc(wait + 1)}`;
  if (kind === 'rewind') return `rewinding: ${cyc(wait)} left`;
  if (kind === 'tape') {
    if (done === state.io.count) return `moving past the rest of tape record ${record + 1}: ${cyc(wait + 1)} left`;
    if (wait) return done ? `reading tape record ${record + 1}: next word in ${cyc(wait)}` : `tape starting: ${cyc(wait)} left`;
    return `tape record ${record + 1} word ${done} (${state.TAPE[record * RECORD_WORDS + done]}) -> ${name(addr + done)}`;
  }
  if (wait) return done ? `reading drum sector ${sector}: next word in ${cyc(wait)}` : `waiting for drum sector ${sector}: ${cyc(wait)} left`;
  const k = (sector * SECTOR_WORDS + done) % state.DRUM.length;
  return `drum sector ${Math.floor(k / SECTOR_WORDS)} word ${k % SECTOR_WORDS} (${state.DRUM[k]}) -> ${name(addr + done)}`;
}

// The input and output instructions, which both instruction sets share; undefined for any other.
function ioEffect([op, a, b, c], state, { name, val }, readCost) {
  const M = state.MEM;
  const record = Math.floor(state.tapePos / RECORD_SPAN);
  if (op === 'HALT') return 'halt';
  if (op === 'PRINT') return `print ${val(a)}`;
  if (op === 'CARD') return `put ${val(a)} in field ${state.pending.length + 1} of the card`;
  if (op === 'PUNCH') return `punch the card (${state.pending.join(', ')}), taking ${cyc(CARD_ROWS * ROW_CYCLES)}`;
  if (op === 'DRUM_READ') {
    const wait = ioWait({ io: { kind: 'drum', sector: M[b], done: 0 }, cycles: state.cycles + readCost });
    return `read drum sector ${val(b)} -> ${name(M[a])}..${name(M[a] + c - 1)}, waiting ${cyc(wait)} first`;
  }
  if (op === 'TAPE_READ') {
    const wait = ioWait({ io: { kind: 'tape', done: 0, count: c }, tapePos: state.tapePos });
    return `read tape record ${record + 1} -> ${name(M[a])}..${name(M[a] + c - 1)}, waiting ${cyc(wait)} first`;
  }
  if (op === 'REWIND') {
    return state.tapePos ? `rewind the tape from record ${record + 1}: ${cyc(ioWait({ io: { kind: 'rewind' }, tapePos: state.tapePos }))}` : 'rewind: tape already at the start';
  }
  return undefined;
}

const IO_TEXT = {
  HALT: () => 'HALT: stop the program',
  PRINT: (m, a) => `PRINT: print ${m(a)}`,
  CARD: (m, a) => `CARD: put ${m(a)} in the next 10-column field of the card being made up`,
  PUNCH: () => 'PUNCH: punch the card made up so far (the IBM 721 did 100 cards a minute)',
  TAPE_READ: (m, a, b, c) => `TAPE_READ (read tape): start the tape, then copy the first ${c} words of the next record into the cells from the address in ${m(a)}`,
  REWIND: () => 'REWIND: wind the tape back to the start',
  DRUM_READ: (m, a, b, c) => `DRUM_READ (read drum): wait for drum sector ${m(b)} to reach the head, then copy ${c} words from there on into the cells from the address in ${m(a)}`,
};

// v0-v5's 4-tuples: [op, a, b, c], memory to memory.
function tupleEffect([op, a, b, c], state, { ea, label, name, val }, ALU) {
  const M = state.MEM;
  const XR = state.XR;
  const via = (i) => `*${name(i)} = ${label(M[ea(i)])} [${M[ea(i)]}]`;
  if (op === 'MOV') return `${val(b)} -> ${name(a)}`;
  if (op === 'LOAD_IND') return `${via(b)} (${M[M[ea(b)]]}) -> ${name(a)}`;
  if (op === 'STORE_IND') return `${val(b)} -> ${via(a)}`;
  if (op === 'LXD') return `${val(b)} -> index register ${reg(a)}`;
  if (op === 'PXD') return `index register ${reg(b)} (${XR[b]}) -> ${name(a)}`;
  if (op === 'TXH') return XR[c] > M[ea(b)] ? `${reg(c)} (${XR[c]}) > ${val(b)}: leave the loop, go to ${a}` : `${reg(c)} (${XR[c]}) <= ${val(b)}: next`;
  if (op === 'TXI') return `${reg(c)} = ${XR[c]} + ${b} = ${XR[c] + b}, go to ${a}`;
  if (op === 'JMP') return `jump to ${a}`;
  if (op === 'JAL') return `call ${b}, return to ${state.ip + 1} -> ${name(a)}`;
  if (op === 'JMP_IND') return `return to ${M[a]} (from ${name(a)})`;
  if (op === 'JZ') return M[ea(b)] === 0 ? `${val(b)} is 0: jump to ${a}` : `${val(b)} is not 0: next`;
  if (!(op in ALU)) return `unknown opcode ${op}`;
  return `${val(b)} ${op} ${val(c)} = ${ALU[op](M[ea(b)], M[ea(c)])} -> ${name(a)}`;
}

function tupleDescribe([op, a, b, c], m, ALU) {
  if (op === 'LXD') return `LXD (load index from decrement): index register ${reg(a)} = ${m(b)}`;
  if (op === 'PXD') return `PXD (place index in decrement): ${m(a)} = index register ${reg(b)}`;
  if (op === 'TXH') return `TXH (transfer on index high): if index register ${reg(c)} > ${m(b)}, go to instruction ${a}`;
  if (op === 'TXI') return `TXI (transfer with index incremented): add ${b} to index register ${reg(c)}, go to instruction ${a}`;
  if (op === 'MOV') return `MOV (move): copy ${m(b)} into ${m(a)}`;
  if (op === 'LOAD_IND') return `LOAD_IND (load indirect): ${m(b)} holds an address; copy the cell at that address into ${m(a)}`;
  if (op === 'STORE_IND') return `STORE_IND (store indirect): ${m(a)} holds an address; copy ${m(b)} into the cell at that address`;
  if (op === 'JMP') return `JMP (jump): go to instruction ${a}`;
  if (op === 'JAL') return `JAL (jump and link): save the return address in ${m(a)}, go to instruction ${b}`;
  if (op === 'JMP_IND') return `JMP_IND (jump indirect): go to the instruction whose number is in ${m(a)} (return from SUB)`;
  if (op === 'JZ') return `JZ (jump if zero): if ${m(b)} is 0, go to instruction ${a}; else go to the next one`;
  return `${op}: ${m(a)} = ${m(b)} ${op} ${m(c)}${ALU[op] && /[<>=!]/.test(op) ? ' (1 if true, 0 if false)' : ''}`;
}

// Cycles an instruction saves each time it runs, against the same program compiled without index registers
// (negative when it costs more). TXH replaces a compare and a JZ, TXI an add and a JMP, LXD a MOV; PXD is extra;
// an indexed operand replaces the add and LOAD_IND that work out a read's address, or the add and STORE_IND
// (in place of MOV) of a write. Control flow is the same either way, so these add up to the whole-run difference.
const READ_OPERANDS = { MOV: [2], LOAD_IND: [2], STORE_IND: [1, 2], PRINT: [1], JZ: [2], CARD: [1], LXD: [2], TXH: [2], DRUM_READ: [1, 2] };
const ARITH = new Set(['+', '-', '*', '/', '%', '==', '!=', '<', '>', '<=', '>=']);
const indexTag = (operand) => operand >> 7;

export function saving(instr) {
  const [op, a] = instr;
  const reads = READ_OPERANDS[op] ?? (ARITH.has(op) ? [2, 3] : []);
  const fixed = { TXH: 10, TXI: 6, LXD: 2, PXD: -4 }[op] ?? 0;
  return fixed + reads.filter((k) => indexTag(instr[k])).length * 12 + (op === 'MOV' && indexTag(a) ? 8 : 0);
}

// v6's 704 instructions: one address (with its tag), a decrement, and an index register or a READ's word count.
const REG_OPS = new Set(['TSX', 'LXD', 'SXD', 'PXD', 'PAX', 'TXI', 'TXH']);
const NO_OPERAND = new Set(['HALT', 'PUNCH', 'REWIND']);

function effect704([op, a, b, c], state, { ea, name, val }, { TESTS, tagOf, addrOf }) {
  const M = state.MEM;
  const XR = state.XR;
  const xr = (r) => `index register ${reg(r)} (${XR[r]})`;
  const ac = `AC (${state.AC})`;
  const mq = `MQ (${state.MQ})`;
  if (op === 'CLA') return `${val(a)} -> AC`;
  if (op === 'CLS') return `-${val(a)} = ${-M[ea(a)] | 0} -> AC`;
  if (op === 'ADD') return `${ac} + ${val(a)} = ${(state.AC + M[ea(a)]) | 0} -> AC`;
  if (op === 'SUB') return `${ac} - ${val(a)} = ${(state.AC - M[ea(a)]) | 0} -> AC`;
  if (op === 'STO') return `${ac} -> ${name(a)}`;
  if (op === 'LDQ') return `${val(a)} -> MQ`;
  if (op === 'STQ') return `${mq} -> ${name(a)}`;
  if (op === 'MPY') return `${mq} * ${val(a)} = ${Math.imul(state.MQ, M[ea(a)])} -> MQ`;
  if (op === 'DVP') return M[ea(a)] ? `${mq} / ${val(a)} = ${(state.MQ / M[ea(a)]) | 0} -> MQ, remainder ${state.MQ % M[ea(a)] | 0} -> AC` : `${mq} / ${val(a)}: division by zero`;
  if (op === 'TRA') return tagOf(a) ? `return to ${ea(a)} (C + ${addrOf(a)})` : `go to ${a}`;
  if (op in TESTS) {
    const [yes, no] = { TZE: ['is 0', 'is not 0'], TNZ: ['is not 0', 'is 0'], TMI: ['< 0', '>= 0'], TPL: ['>= 0', '< 0'] }[op];
    return TESTS[op](state.AC) ? `${ac} ${yes}: go to ${a}` : `${ac} ${no}: next`;
  }
  if (op === 'TSX') return `call ${a}: ${state.ip} (this instruction) -> index register ${reg(c)}`;
  if (op === 'LXD') return `${val(a)} -> index register ${reg(c)}`;
  if (op === 'SXD') return `${xr(c)} -> ${name(a)}`;
  if (op === 'PXD') return `${xr(c)} -> AC`;
  if (op === 'PAX') return `${ac} -> index register ${reg(c)}`;
  if (op === 'TXH') return XR[c] > M[ea(b)] ? `${reg(c)} (${XR[c]}) > ${val(b)}: leave the loop, go to ${a}` : `${reg(c)} (${XR[c]}) <= ${val(b)}: next`;
  if (op === 'TXI') return `${reg(c)} = ${XR[c]} + ${b} = ${XR[c] + b}, go to ${a}`;
  return `unknown opcode ${op}`;
}

function describe704([op, a, b, c], m, { tagOf, addrOf }) {
  const TEXT = {
    CLA: () => `CLA (clear and add): AC = ${m(a)}`,
    CLS: () => `CLS (clear and subtract): AC = -${m(a)}`,
    ADD: () => `ADD: AC = AC + ${m(a)}`,
    SUB: () => `SUB (subtract): AC = AC - ${m(a)}`,
    STO: () => `STO (store): ${m(a)} = AC`,
    LDQ: () => `LDQ (load MQ): MQ = ${m(a)}`,
    STQ: () => `STQ (store MQ): ${m(a)} = MQ`,
    MPY: () => `MPY (multiply): MQ = MQ * ${m(a)}, 20 cycles`,
    DVP: () => `DVP (divide or proceed): MQ = MQ / ${m(a)}, the remainder in AC, 20 cycles`,
    TRA: () => (tagOf(a) ? `TRA (transfer): go to instruction ${addrOf(a)} + index register ${reg(tagOf(a) - 1)} (return from SUB)` : `TRA (transfer): go to instruction ${a}`),
    TZE: () => `TZE (transfer on zero): if AC is 0, go to instruction ${a}`,
    TNZ: () => `TNZ (transfer on no zero): if AC is not 0, go to instruction ${a}`,
    TMI: () => `TMI (transfer on minus): if AC < 0, go to instruction ${a}`,
    TPL: () => `TPL (transfer on plus): if AC >= 0, go to instruction ${a}`,
    TSX: () => `TSX (transfer and set index): index register ${reg(c)} = this instruction's location, go to instruction ${a} (call)`,
    LXD: () => `LXD (load index from decrement): index register ${reg(c)} = ${m(a)}`,
    SXD: () => `SXD (store index in decrement): ${m(a)} = index register ${reg(c)}`,
    PXD: () => `PXD (place index in decrement): AC = index register ${reg(c)}`,
    PAX: () => `PAX (place address in index): index register ${reg(c)} = AC`,
    TXH: () => `TXH (transfer on index high): if index register ${reg(c)} > ${m(b)}, go to instruction ${a}`,
    TXI: () => `TXI (transfer with index incremented): add ${b} to index register ${reg(c)}, go to instruction ${a}`,
  };
  return TEXT[op]?.() ?? `${op}: unknown opcode`;
}

export function visualizer({ compiler, vm, memSize, features, drumSkip = 9 }) {
  const has = (feature) => features.includes(feature);
  const ibm704 = has('accumulator');
  const tagOf = vm.tagOf ?? (() => 0);
  const addrOf = vm.addrOf ?? ((x) => x & 127);
  const DEMOS = demos(has, drumSkip);
  const operand = (x) => (tagOf(x) ? `${addrOf(x)},${reg(tagOf(x) - 1)}` : String(x));

  // One instruction as the bytecode lists it; v6 writes it as 704 assembly does: address, then tag, then decrement.
  function asm(instr) {
    const [op, a, b, c] = instr;
    if (!ibm704) return instr.map((x, k) => (k ? operand(x) : x)).join(' ');
    if (NO_OPERAND.has(op)) return op;
    if (REG_OPS.has(op)) return `${op} ${a},${reg(c)}${op === 'TXI' || op === 'TXH' ? `,${operand(b)}` : ''}`;
    return `${op} ${operand(a)}${op === 'DRUM_READ' ? ` ${operand(b)}` : ''}`;
  }

  // The compiler's output plus each memory cell's role and label, built from its allocations.
  function layout(source, size = memSize, registers = undefined) {
    const prog = compiler.compile(source, size, registers);
    const cells = Array.from({ length: prog.initMem.length }, (_, i) => (i < prog.codeLen ? { role: 'code', label: asm(prog.code[i]) } : { role: 'unused', label: '' }));
    for (const { kind, base, size: n, role, label } of prog.events) {
      if (kind !== 'alloc') continue;
      for (let i = 0; i < n; i++) cells[base + i] = { role, label: n > 1 ? `${label}[${i}]` : (label || `tmp_${base + i}`) };
    }
    return { ...prog, cells };
  }

  // v0 keeps its program apart from memory; from v1 on, the instructions are memory words.
  const instruction = (prog, mem, ip) => (has('code') ? vm.decode(mem[ip]) : prog.code[ip]);

  // What the next instruction will do, in the names of the cells it touches.
  function effect(prog, state) {
    if (state.halted) return 'halted';
    const M = state.MEM;
    // An indexed operand names the cell its address plus its register picks.
    const ea = (i) => addrOf(i) + (tagOf(i) ? state.XR[tagOf(i) - 1] : 0);
    const label = (i) => prog.cells[i]?.label || `M[${i}]`;
    const name = (i) => (tagOf(i) ? `${label(ea(i))} [via ${reg(tagOf(i) - 1)}]` : label(i));
    const names = { ea, label, name, val: (i) => `${name(i)} (${M[ea(i)]})` };
    if (state.io) return deviceEffect(state, name);
    const instr = instruction(prog, M, state.ip);
    return ioEffect(instr, state, names, ibm704 ? COST_704.DRUM_READ ?? 2 : COST.DRUM_READ)
      ?? (ibm704 ? effect704(instr, state, names, { TESTS: vm.TESTS, tagOf, addrOf }) : tupleEffect(instr, state, names, vm.ALU));
  }

  // Hover text for one instruction: the opcode's name and what it does with these operands.
  function describe(instr, cells) {
    const m = (i) => (tagOf(i) ? `M[${addrOf(i)} + ${reg(tagOf(i) - 1)}] ${cells[addrOf(i)]?.label ?? ''} onward` : `M[${i}] ${cells[i]?.label ?? ''}`).trim();
    return IO_TEXT[instr[0]]?.(m, ...instr.slice(1)) ?? (ibm704 ? describe704(instr, m, { tagOf, addrOf }) : tupleDescribe(instr, m, vm.ALU));
  }

  const mount = () => mountPage({ has, vm, memSize, DEMOS, layout, effect, describe, asm, instruction });
  return { MEM_SIZE: memSize, DEMOS, layout, effect, describe, asm, saving, mount };
}

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  node.append(...kids);
  return node;
}

function svg(tag, attrs, ...kids) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

// One pattern per digit row, so every card can print 0-9 down all 80 columns, as IBM's cards were printed.
function cardDigitPatterns() {
  return svg('svg', { width: 0, height: 0, style: 'position: absolute' }, svg('defs', {},
    ...Array.from({ length: 10 }, (_, d) => svg('pattern', { id: `card-row-${d}`, width: 1, height: 2.5, patternUnits: 'userSpaceOnUse' },
      svg('text', { x: 0.5, y: 1.9, class: 'printed' }, String(d))))));
}

// An 80-column card with the first `rows` rows of PUNCH_ORDER punched, and its numbers printed along its top edge.
function card(values, rows = PUNCH_ORDER.length) {
  const punched = new Set(PUNCH_ORDER.slice(0, rows));
  const rowY = (row) => 5 + CARD_ROWS_TOP.indexOf(row) * 2.5;
  return svg('svg', { class: 'card', viewBox: '0 0 84 37' },
    svg('polygon', { points: '3,0 84,0 84,37 0,37 0,3', class: 'stock' }),
    ...Array.from({ length: 10 }, (_, d) => svg('rect', { x: 2, y: rowY(d), width: 80, height: 2.5, fill: `url(#card-row-${d})` })),
    ...[...fields(values)].map((ch, col) => svg('text', { x: 2.5 + col, y: 3.4 }, ch)),
    ...(rows < PUNCH_ORDER.length ? [svg('rect', { x: 2, y: rowY(PUNCH_ORDER[rows]), width: 80, height: 2.5, class: 'punching' })] : []),
    ...cardPunches(values).filter(({ row }) => punched.has(row)).map(({ col, row }) => svg('rect', { x: 2.05 + col, y: rowY(row) + 0.3, width: 0.9, height: 1.9, class: 'hole' })));
}

// The printer's paper, one long fan-folded sheet: every line printed so far, numbered, then the line it prints next.
// Blank paper above line 1 lets the first lines sit in the window's flat part. A new line scrolls the newest into view.
const PAPER_ABOVE = 4;

function renderPaper(box, lines) {
  const rows = [...Array(PAPER_ABOVE).fill(null), ...lines, ''];
  const grew = box.childElementCount !== rows.length;
  box.replaceChildren(...rows.map((text, i) => el('div', { class: `pline${i === rows.length - 1 ? ' next' : ''}` },
    el('span', { class: 'ln', text: i < PAPER_ABOVE ? '' : String(i - PAPER_ABOVE + 1) }),
    el('span', { text: String(text ?? '') }))));
  if (grew) box.scrollTop = box.scrollHeight;
}

const LEGEND = [['#6e7681', 'code'], ['#3b82f6', 'constant'], ['#22c55e', 'variable'], ['#a855f7', 'SUB arg / return'], ['#f59e0b', 'temp']];

function page(has) {
  const legend = LEGEND.filter(([, name]) => name !== 'code' || has('code')).map(([color, name]) => `<span><i style="background:${color}"></i>${name}</span>`).join('');
  const regs = has('index') || has('accumulator') ? `<div class="head" id="regs-head">${has('index') ? 'INDEX REGISTERS' : 'REGISTERS'}</div><div id="regs"></div>` : '';
  return `
  <div class="bar">
    <button id="compile">Compile</button>
    <button id="run">Run</button>
    <button id="stop">Stop</button>
    <button id="step">Next</button>
    <button id="back">Previous</button>
    <label class="speed">Speed <input type="range" id="speed" min="1" max="9" value="5"></label>
    <span id="status"></span>
    <span class="legend">${legend}
      <span><i class="box" style="outline:2px solid #22d3ee"></i>read</span>
      <span><i class="box" style="outline:2px solid #fb923c"></i>written</span>
    </span>
  </div>
  <div class="row" id="board">
    <svg id="arrow"></svg>
    <div>
      <div class="head">FORTRAN <label class="file"><select id="demo" title="Program to run"></select></label></div>
      <div class="codebox"><div class="editor"><div id="lines"></div><textarea id="src" spellcheck="false" wrap="off"></textarea></div></div>
      <div class="head">EFFECT</div><div id="effect"></div>
      <div class="head">PRINTER</div><div id="out" title="Scroll back one line at a time"></div>
      ${has('cards') ? '<div class="head">CARDS</div><div id="cards"></div>' : ''}
    </div>
    <div>
      <div class="head">BYTECODE</div><div id="code"></div>
      ${has('drum') ? '<div class="head" id="drum-head">DRUM</div><div id="drum"></div>' : ''}
      ${has('tape') ? '<div class="head" id="tape-head">TAPE</div><div id="tape"></div>' : ''}
    </div>
    <div>${regs}<div class="head">MEMORY</div><div id="ram"></div></div>
  </div>`;
}

function mountPage({ has, vm, memSize, DEMOS, layout, effect, describe, asm, instruction }) {
  document.body.innerHTML = page(has);
  const $ = (id) => document.getElementById(id);
  const demoSel = $('demo');
  const srcBox = $('src');
  const linesBox = $('lines');
  const ramBox = $('ram');
  const codeBox = $('code');
  const outBox = $('out');
  const statusBox = $('status');
  const effectBox = $('effect');
  const speedBox = $('speed');
  const arrowSvg = $('arrow');
  if (has('cards')) document.body.append(cardDigitPatterns());

  for (const [k, d] of Object.entries(DEMOS)) demoSel.append(el('option', { value: k, text: d.name }));

  let prog = null;
  let machine = null;
  let last = { reads: [], writes: [] };
  let timer = null;
  let building = null;
  // How many VM steps each advance() took, and what the index registers saved in it, so Previous undoes the same.
  const batches = [];
  // v5: cycles the index registers have saved so far this run, and the whole run's instruction cycles with and
  // without them.
  let saved = 0;
  let runWith = '?';
  let runWithout = '?';

  const demo = () => DEMOS[demoSel.value];

  function drawArrow() {
    arrowSvg.replaceChildren();
    const srcRow = linesBox.querySelector('.line.active');
    const codeRow = codeBox.querySelector('.line.active');
    if (!srcRow || !codeRow) return;
    const lb = linesBox.getBoundingClientRect();
    const cb = codeBox.getBoundingClientRect();
    const s = srcRow.getBoundingClientRect();
    const c = codeRow.getBoundingClientRect();
    if (s.bottom < lb.top || s.top > lb.bottom || c.bottom < cb.top || c.top > cb.bottom) return;
    const b = $('board').getBoundingClientRect();
    const x1 = s.right - b.left;
    const y1 = s.top + s.height / 2 - b.top;
    const x2 = c.left - b.left - 4;
    const y2 = c.top + c.height / 2 - b.top;
    const mx = (x1 + x2) / 2;
    arrowSvg.append(
      svg('defs', {}, svg('marker', { id: 'tip', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' },
        svg('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: '#58a6ff' }))),
      svg('path', { d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, fill: 'none', stroke: '#58a6ff', 'stroke-width': 2, 'marker-end': 'url(#tip)' }));
  }

  // A reel: the sector under the head in the middle, the one just gone above, the next one below.
  function renderDrum(words, cycles, io) {
    const head = headAt(cycles);
    // A read starts at its sector and runs on through the following ones.
    const drumIo = io?.sector === undefined ? null : io;
    const fromStart = (sec, w) => (sec * SECTOR_WORDS + w - (drumIo?.sector ?? 0) * SECTOR_WORDS + words.length) % words.length;
    const sec2 = (sec) => `S${String(sec).padStart(2, '0')}`;
    $('drum-head').textContent = `DRUM${drumIo ? `  reading ${sec2(io.sector)}` : ''}`;
    $('drum').replaceChildren(...[-1, 0, 1].map((d) => {
      const sec = (head.sector + d + SECTORS) % SECTORS;
      return el('div', { class: `sector ${['above', 'at-head', 'below'][d + 1]}${drumIo && fromStart(sec, 0) < drumIo.count ? ' want' : ''}` },
        el('span', { class: 'mark', text: d === 0 ? 'HEAD' : '' }),
        el('span', { class: 'sec', text: sec2(sec) }),
        ...Array.from({ length: SECTOR_WORDS }, (_, w) => el('span', {
          class: `w${d === 0 && w === head.word ? ' under' : ''}${d === 0 && w < head.word ? ' passed' : ''}${drumIo && fromStart(sec, w) < drumIo.done ? ' copied' : ''}`,
          text: String(words[sec * SECTOR_WORDS + w]),
        })));
    }));
  }

  // The tape moving past a fixed head in the middle, one word's length of tape per cell: each record is its gap, then its words.
  function renderTape(words, pos, io) {
    const at = Math.floor(pos / RECORD_SPAN);
    $('tape-head').textContent = `TAPE  record ${Math.min(at + 1, RECORDS)} of ${RECORDS}${io?.kind === 'rewind' ? '  rewinding' : ''}`;
    $('tape').replaceChildren(...Array.from({ length: 41 }, (_, i) => {
      const u = pos + (i - 20) * TAPE_WORD_CYCLES;
      if (u < 0 || u >= RECORDS * RECORD_SPAN) return el('span', { class: 'tu off' });
      const rec = Math.floor(u / RECORD_SPAN);
      const w = Math.floor(((u % RECORD_SPAN) - GAP) / TAPE_WORD_CYCLES);
      const under = i === 20 ? ' under' : '';
      const first = u % RECORD_SPAN < TAPE_WORD_CYCLES;
      if (w < 0) return el('span', { class: `tu gap${first ? ' label' : ''}${under}`, text: first ? `#${rec + 1}` : '' });
      const copied = io?.kind === 'tape' && rec === at && w < io.done ? ' copied' : '';
      return el('span', { class: `tu w${under}${copied}`, text: String(words[rec * RECORD_WORDS + w]) });
    }));
  }

  function renderRegisters(s) {
    if (has('index')) $('regs-head').textContent = `INDEX REGISTERS  saved ${saved} of ${runWithout - runWith} cycles so far (whole run: ${runWith} instruction cycles, ${runWithout} without them)`;
    const acc = has('accumulator') ? [el('div', { class: 'reg acc', text: `AC (${s.AC})` }), el('div', { class: 'reg acc', text: `MQ (${s.MQ})` })] : [];
    $('regs').replaceChildren(...acc, ...[0, 1, 2].map((r) => {
      const holder = prog.regLoops.find((l) => l.reg === r && s.pc >= l.from && s.pc < l.to)?.name;
      return el('div', { class: `reg${holder ? ' live' : ''}`, text: `${reg(r)}${holder ? ` = ${holder}` : ''} (${s.XR[r]})` });
    }));
  }

  const badge = (n) => el('span', { class: `gain${n < 0 ? ' cost' : ''}`, text: n > 0 ? `+${n}` : `−${-n}` });
  const savingNote = (n) => (n > 0 ? ` (saves ${n} cycles)` : n < 0 ? ` (costs ${-n} cycles)` : '');
  const gainOf = (instr) => (has('index') ? saving(instr) : 0);

  function render(focusIp = null) {
    if (!prog) {
      if (has('drum')) renderDrum(demo().drum ?? drumLayout(1), 0, null);
      if (has('tape')) renderTape(demo().tape ?? TAPE_DATA, 0, null);
      statusBox.textContent = 'not compiled';
      effectBox.textContent = '';
      renderPaper(outBox, []);
      if (has('cards')) $('cards').replaceChildren();
      if ($('regs')) $('regs').replaceChildren();
      linesBox.replaceChildren(...srcBox.value.split('\n').map(() => el('div', { class: 'line', text: ' ' })));
      linesBox.scrollTop = srcBox.scrollTop;
      ramBox.replaceChildren();
      codeBox.replaceChildren();
      arrowSvg.replaceChildren();
      return;
    }
    const s = machine.getState();
    const view = building === null ? null : compileView(prog, building);
    const m = view ? { lastIp: view.newIp, nextIp: null, lastLine: view.line, nextLine: null } : marks(prog.ipMap, s, focusIp);
    if (!view && s.halted && focusIp === null) m.lastLine = haltLine(srcBox.value);
    const { lastIp: activeIp, nextIp, lastLine: activeLine, nextLine } = m;
    const reads = new Set(last.reads);
    const writes = new Set(last.writes);
    const code = view ? view.code : prog.code.map((_, i) => instruction(prog, s.MEM, i));

    const clock = 'cycles' in s ? `cycle ${s.cycles} | waited ${s.waited}` : `steps ${s.steps}`;
    statusBox.textContent = view ? `compiling: ${building}/${prog.events.length}` : `pc ${s.pc ?? '-'} | next ${nextIp ?? '-'} | ${clock}${s.halted ? ' | HALTED' : ''}`;
    effectBox.textContent = view ? '' : effect(prog, s) + (s.io || s.halted ? '' : savingNote(gainOf(code[s.ip])));
    renderPaper(outBox, s.stdout);
    if (has('cards')) {
      $('cards').replaceChildren(...s.cards.map((values) => card(values)), ...(s.io?.kind === 'punch' ? [card(s.io.values, s.io.done)] : []));
      $('cards').scrollTop = $('cards').scrollHeight;
    }
    if ($('regs')) renderRegisters(s);

    linesBox.replaceChildren(...Array.from({ length: Math.max(srcBox.value.split('\n').length, activeLine ?? 0) }, (_, idx) => {
      const ln = idx + 1;
      return el('div', { class: `line${ln === activeLine ? ' active' : ''}`, text: ln === nextLine ? '>' : ' ' });
    }));
    const focusLine = nextLine ?? activeLine;
    if (focusLine) {
      const top = (focusLine - 1) * 18;
      if (top < srcBox.scrollTop || top + 34 > srcBox.scrollTop + srcBox.clientHeight) srcBox.scrollTop = Math.max(0, top - 36);
    }
    linesBox.scrollTop = srcBox.scrollTop;

    // Code cells and free cells show only their address, so the cells in use get the room.
    const codeLen = has('code') ? prog.codeLen : 0;
    const codeCells = [];
    const dataCells = [];
    const freeCells = [];
    for (let i = 0; i < prog.initMem.length; i++) {
      const isCode = i < codeLen;
      const placed = isCode ? code[i] !== undefined : i < (view ? view.cells : prog.usedCells);
      if (!placed) {
        (isCode ? codeCells : freeCells).push(el('div', { class: 'cell code unused' }, el('small', { text: String(i).padStart(2, '0') })));
        continue;
      }
      const cell = prog.cells[i];
      const fresh = view && (view.newCell !== null ? i >= view.newCell : i === view.newIp);
      const flash = writes.has(i) || fresh ? ' write' : (reads.has(i) ? ' read' : '');
      (isCode ? codeCells : dataCells).push(el('div', {
        class: `cell ${cell.role}${flash}${isCode && i === activeIp ? ' pc' : ''}`,
        title: isCode ? describe(code[i], prog.cells) : '',
        onMouseenter: () => (isCode
          ? codeBox.querySelector(`[data-ip="${i}"]`)?.classList.add('hover')
          : [...linesBox.children].forEach((row, idx) => row.classList.toggle('hover', prog.cellLines[i].has(idx + 1)))),
        onMouseleave: () => [...linesBox.children, ...codeBox.children].forEach((row) => row.classList.remove('hover')),
      },
        ...(isCode
          ? [el('small', { text: `${i === nextIp ? '> ' : ''}${String(i).padStart(2, '0')}` })]
          : [el('small', { text: `[${i}] ${cell.label}` }), el('strong', { text: String(view ? prog.initMem[i] : s.MEM[i]) })]),
      ));
    }
    ramBox.replaceChildren(el('div', { class: 'code-strip' }, ...codeCells), el('div', { class: 'data-grid' }, ...dataCells), el('div', { class: 'code-strip free' }, ...freeCells));

    codeBox.replaceChildren();
    code.forEach((instr, i) => {
      const active = i === activeIp;
      const isNext = i === nextIp;
      const row = el('div', { class: `line${active ? ' active' : ''}`, 'data-ip': i, title: describe(instr, prog.cells), onClick: () => render(i) },
        el('span', { text: `${isNext ? '>' : ' '} ${String(i).padStart(2, '0')}: ${asm(instr)}` }),
        ...(gainOf(instr) ? [badge(gainOf(instr))] : []));
      codeBox.append(row);
      if (isNext || (nextIp === null && active)) row.scrollIntoView({ block: 'nearest' });
    });

    if (has('drum')) renderDrum(s.DRUM, s.cycles, s.io);
    if (has('tape')) renderTape(s.TAPE, s.tapePos, s.io);
    requestAnimationFrame(drawArrow);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  const devices = () => [demo().drum ?? drumLayout(1), demo().tape ?? TAPE_DATA];
  const start = (p, ...rest) => (has('code') ? vm.createVM(p.initMem, ...devices(), ...rest) : vm.createVM(p.code, p.initMem));

  // The cycles a whole run spends on instructions (not waiting on devices) with this many index registers; run
  // without history, giving up on a long or endless program.
  function instructionCycles(registers) {
    const bare = start(layout(srcBox.value, memSize, registers), false);
    for (let n = 0; n < 2e6 && !bare.getState().halted; n++) bare.step();
    const s = bare.getState();
    return s.halted ? s.cycles - s.waited : '?';
  }

  function load(walk) {
    prog = layout(srcBox.value, memSize);
    machine = start(prog);
    last = { reads: [], writes: [] };
    building = walk ? 0 : null;
    batches.length = 0;
    saved = 0;
    if (has('index')) {
      runWith = instructionCycles(3);
      runWithout = instructionCycles(0);
    }
  }

  function unload() {
    stop();
    prog = null;
    machine = null;
    building = null;
  }

  // Show what went wrong in place of the status and effect, until the next action redraws them.
  function act(fn) {
    try {
      fn();
      render();
    } catch (e) {
      stop();
      render();
      statusBox.textContent = 'error';
      effectBox.textContent = e.message;
    }
  }

  // Every step takes the same time, except that words coming off a device and card rows are slowed down to watch.
  function delay() {
    if (building !== null) return 80;
    const s = machine.getState();
    if (s.io?.kind === 'punch') return 40;
    return s.io?.done ? 120 : 12;
  }

  // The speed slider scales every delay; each step doubles or halves it, and the middle is a fifth of the original speed.
  const pace = (ms) => ms * 5 * 2 ** (5 - Number(speedBox.value));

  // Advance on a timer, at the slider's speed, until more() says there is nothing left to do.
  function play(more) {
    stop();
    const tick = () => act(() => {
      if (!more()) return stop();
      timer = setTimeout(tick, pace(delay()));
    });
    timer = setTimeout(tick, 0);
  }

  // One compile event while walking the compile, else one instruction, one word read, one card row punched, or up
  // to one sector of a device wait; false once halted.
  function advance() {
    if (building !== null) {
      building++;
      if (building >= prog.events.length) building = null;
      return true;
    }
    if (!prog) load(false);
    const s = machine.getState();
    if (s.halted) return false;
    const gain = s.io ? 0 : gainOf(instruction(prog, s.MEM, s.ip));
    const done = s.io?.done;
    let n = 0;
    let io;
    do {
      last = machine.step();
      n++;
      io = machine.getState().io;
    } while (io && io.done === done && n < (io.kind === 'punch' ? ROW_CYCLES : SECTOR_WORDS * DRUM_WORD_CYCLES));
    batches.push({ n, gain });
    saved += gain;
    return !last.halted;
  }

  demoSel.addEventListener('change', () => { srcBox.value = demo().code; unload(); render(); });
  srcBox.addEventListener('input', () => { unload(); render(); });
  $('compile').addEventListener('click', () => act(() => {
    load(true);
    play(() => advance() && building !== null);
  }));
  $('stop').addEventListener('click', () => { stop(); render(); });
  $('step').addEventListener('click', () => { stop(); act(advance); });
  $('back').addEventListener('click', () => {
    stop();
    if (building !== null) building = Math.max(0, building - 1);
    else if (machine) {
      const { n, gain } = batches.pop() ?? { n: 1, gain: 0 };
      for (let k = 0; k < n; k++) machine.stepBack();
      saved -= gain;
      last = { reads: [], writes: [] };
    }
    render();
  });
  $('run').addEventListener('click', () => {
    if (machine && building === null && machine.getState().halted) machine.reset();
    play(advance);
  });
  srcBox.addEventListener('scroll', () => { linesBox.scrollTop = srcBox.scrollTop; drawArrow(); });
  outBox.addEventListener('wheel', (e) => { e.preventDefault(); outBox.scrollTop += Math.sign(e.deltaY) * 18; }, { passive: false });
  codeBox.addEventListener('scroll', drawArrow);
  window.addEventListener('resize', drawArrow);

  srcBox.value = DEMOS.factorial.code;
  render();
}
