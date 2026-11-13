import { compile } from './compiler.js';
import { CARD_ROWS, DRUM_WORD_CYCLES, GAP, ROW_CYCLES, RECORDS, RECORD_SPAN, RECORD_WORDS, SECTORS, SECTOR_WORDS, TAPE_WORD_CYCLES, TESTS, addrOf, createVM, decode, headAt, ioWait, tagOf } from './vm.js';

// One-address code takes about twice the instructions of v5's three-address code, so v6 has twice the memory.
export const MEM_SIZE = 256;

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

export const DEMOS = {
  factorial: {
    name: 'factorial.f',
    code: 'N = 5\nFACT = 1\nDO I = 1, N\n  FACT = FACT * I\nEND\nPRINT FACT',
  },
  swap: {
    name: 'swap.f',
    code: 'SUB SWAP(A, B)\n  TMP = A\n  A = B\n  B = TMP\nEND\nX = 10\nY = 99\nCALL SWAP(X, Y)\nPRINT X\nPRINT Y\nCALL SWAP(2, Y)\nPRINT 2',
  },
  saxpy: {
    name: 'saxpy.f',
    code: 'DIM A(3, 2)\nDIM Y(3)\nSUB SAXPY(N, ALPHA, X, OUT)\n  DO I = 0, N - 1\n    OUT[I] = ALPHA * X[I] + OUT[I]\n  END\nEND\nDO C = 0, 1\n  DO R = 0, 2\n    A[R, C] = (C + 1) * 10 + R\n  END\nEND\nCALL SAXPY(3, 2, A[0, 0], Y)\nCALL SAXPY(3, 1, A[0, 1], Y)\nDO I = 0, 2\n  PRINT Y[I]\nEND',
  },
  equiv: {
    name: 'equiv.f',
    code: 'DIM WORKSPACE(4)\nEQUIV VIEW_A(2, 2) = WORKSPACE\nVIEW_A[0, 0] = 11\nVIEW_A[1, 0] = 22\nVIEW_A[0, 1] = 33\nVIEW_A[1, 1] = 44\nDO I = 0, 3\n  PRINT WORKSPACE[I]\nEND',
  },
  drumSeq: {
    name: 'drum_in_order.f',
    code: 'DIM BUF(8)\nSKIP = 1\nSUM = 0\nDO K = 0, 15\n  READ DRUM MOD(K * SKIP, 32), BUF\n  DO I = 0, 7\n    SUM = SUM + BUF[I]\n  END\nEND\nPRINT SUM',
    drum: drumLayout(1),
  },
  drumSkip: {
    name: 'drum_interleaved.f',
    code: 'DIM BUF(8)\nSKIP = 5\nSUM = 0\nDO K = 0, 15\n  READ DRUM MOD(K * SKIP, 32), BUF\n  DO I = 0, 7\n    SUM = SUM + BUF[I]\n  END\nEND\nPRINT SUM',
    drum: drumLayout(5),
  },
  tape: {
    name: 'tape_rewind.f',
    code: 'DIM R(8)\nDO K = 1, 20\n  READ TAPE R\nEND\nPRINT R[0]\nREWIND\nREAD TAPE R\nPRINT R[0]',
    tape: TAPE_DATA,
  },
  squares: {
    name: 'squares_punch.f',
    code: 'DO I = 1, 6\n  PUNCH I, I * I\nEND',
  },
  arraySum: {
    name: 'array_sum_punch.f',
    code: 'DIM A(20)\nDO I = 0, 19\n  A[I] = I * 3\nEND\nSUM = 0\nDO I = 0, 19\n  SUM = SUM + A[I]\nEND\nPUNCH SUM',
  },
  formula: {
    name: 'formula.f',
    code: 'A = 2\nB = 3\nC = 7\nX = A + B * C\nPRINT X',
  },
  largest: {
    name: 'largest.f',
    code: 'X = 4\nY = 7\nIF X > Y THEN\n  PRINT X\nELSE\n  PRINT Y\nEND',
  },
};

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

const REG_OPS = new Set(['TSX', 'LXD', 'SXD', 'PXD', 'PAX', 'TXI', 'TXH']);
const NO_OPERAND = new Set(['HALT', 'PUNCH', 'REWIND']);
const operand = (x) => (tagOf(x) ? `${addrOf(x)},${'ABC'[tagOf(x) - 1]}` : String(x));

// One instruction as 704 assembly writes it: address, then tag (index register), then decrement.
export function asm([op, a, b, c]) {
  if (NO_OPERAND.has(op)) return op;
  if (REG_OPS.has(op)) return `${op} ${a},${'ABC'[c]}${op === 'TXI' || op === 'TXH' ? `,${operand(b)}` : ''}`;
  return `${op} ${operand(a)}${op === 'DRUM_READ' ? ` ${operand(b)}` : ''}`;
}

// The compiler's output plus each memory cell's role and label, built from its allocations.
export function layout(source, memSize, registers) {
  const prog = compile(source, memSize, registers);
  const cells = Array.from({ length: prog.initMem.length }, (_, i) => (i < prog.codeLen ? { role: 'code', label: asm(prog.code[i]) } : { role: 'unused', label: '' }));
  for (const { kind, base, size, role, label } of prog.events) {
    if (kind !== 'alloc') continue;
    for (let i = 0; i < size; i++) cells[base + i] = { role, label: size > 1 ? `${label}[${i}]` : (label || `tmp_${base + i}`) };
  }
  return { ...prog, cells };
}

// What the next instruction will do, in the names of the cells it touches.
export function effect(prog, state) {
  if (state.halted) return 'halted';
  const [op, a, b, c] = decode(state.MEM[state.ip]);
  const M = state.MEM;
  const XR = state.XR;
  const reg = (r) => 'ABC'[r];
  // An indexed operand names the cell its address plus its register picks.
  const ea = (i) => (addrOf(i)) + (tagOf(i) ? XR[tagOf(i) - 1] : 0);
  const label = (i) => prog.cells[i]?.label || `M[${i}]`;
  const name = (i) => (tagOf(i) ? `${label(ea(i))} [via ${reg(tagOf(i) - 1)}]` : label(i));
  const cyc = (n) => `${n} cycle${n === 1 ? '' : 's'}`;
  const record = Math.floor(state.tapePos / RECORD_SPAN);
  if (state.io) {
    const { kind, sector, addr, done } = state.io;
    const wait = ioWait(state);
    if (kind === 'punch') return `punching a card: row ${PUNCH_ORDER[done]} in ${cyc(wait + 1)}`;
    if (kind === 'rewind') return `rewinding: ${cyc(wait)} left`;
    if (kind === 'tape') {
      if (wait) return done ? `reading tape record ${record + 1}: next word in ${cyc(wait)}` : `tape starting: ${cyc(wait)} left`;
      return `tape record ${record + 1} word ${done} (${state.TAPE[record * RECORD_WORDS + done]}) -> ${name(addr + done)}`;
    }
    if (wait) return done ? `reading drum sector ${sector}: next word in ${cyc(wait)}` : `waiting for drum sector ${sector}: ${cyc(wait)} left`;
    return `drum sector ${sector} word ${done} (${state.DRUM[sector * SECTOR_WORDS + done]}) -> ${name(addr + done)}`;
  }
  const val = (i) => `${name(i)} (${M[ea(i)]})`;
  const xr = (r) => `index register ${reg(r)} (${XR[r]})`;
  const ac = `AC (${state.AC})`;
  const mq = `MQ (${state.MQ})`;
  if (op === 'HALT') return 'halt';
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
  if (op === 'PRINT') return `print ${val(a)}`;
  if (op === 'CARD') return `put ${val(a)} in field ${state.pending.length + 1} of the card`;
  if (op === 'PUNCH') return `punch the card (${state.pending.join(', ')}), taking ${cyc(CARD_ROWS * ROW_CYCLES)}`;
  if (op === 'DRUM_READ') {
    const wait = ioWait({ io: { kind: 'drum', sector: M[b], done: 0 }, cycles: state.cycles + 2 });
    return `read drum sector ${val(b)} -> ${name(M[a])}..${name(M[a] + SECTOR_WORDS - 1)}, waiting ${cyc(wait)} first`;
  }
  if (op === 'TAPE_READ') {
    const wait = ioWait({ io: { kind: 'tape' }, tapePos: state.tapePos });
    return `read tape record ${record + 1} -> ${name(M[a])}..${name(M[a] + RECORD_WORDS - 1)}, waiting ${cyc(wait)} first`;
  }
  if (op === 'REWIND') {
    return state.tapePos ? `rewind the tape from record ${record + 1}: ${cyc(ioWait({ io: { kind: 'rewind' }, tapePos: state.tapePos }))}` : 'rewind: tape already at the start';
  }
  return `unknown opcode ${op}`;
}

// Hover text for one instruction: the opcode's 704 name and what it does with these operands.
export function describe([op, a, b, c], cells) {
  const reg = (r) => 'ABC'[r];
  const m = (i) => (tagOf(i) ? `M[${addrOf(i)} + ${reg(tagOf(i) - 1)}] ${cells[addrOf(i)]?.label ?? ''} onward` : `M[${i}] ${cells[i]?.label ?? ''}`).trim();
  const TEXT = {
    HALT: () => 'HALT: stop the program',
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
    PRINT: () => `PRINT: print ${m(a)}`,
    CARD: () => `CARD: put ${m(a)} in the next 10-column field of the card being made up`,
    PUNCH: () => 'PUNCH: punch the card made up so far (the IBM 721 did 100 cards a minute)',
    TAPE_READ: () => `TAPE_READ (read tape): start the tape, then copy the next record's ${RECORD_WORDS} words into the cells from the address in ${m(a)}`,
    REWIND: () => 'REWIND: wind the tape back to the start',
    DRUM_READ: () => `DRUM_READ (read drum): wait for drum sector ${m(b)} to reach the head, then copy its ${SECTOR_WORDS} words into the cells from the address in ${m(a)}`,
  };
  return TEXT[op]?.() ?? `${op}: unknown opcode`;
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

// A card's 12 rows from its top edge. Each number is punched right-justified in its own 10-column field, Hollerith
// style: each digit in its own row, '-' in row 11.
const CARD_ROWS_TOP = [12, 11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
// A punch takes the card 9-edge first, so row 9 is punched first and row 12 last.
export const PUNCH_ORDER = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12];

const fields = (values) => values.map((v) => String(v).padStart(10)).join('');

export function cardPunches(values) {
  return [...fields(values)].flatMap((ch, col) => (ch === ' ' ? [] : [{ col, row: ch === '-' ? 11 : Number(ch) }]));
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

export function mount() {
  const demoSel = document.getElementById('demo');
  const srcBox = document.getElementById('src');
  const linesBox = document.getElementById('lines');
  const ramBox = document.getElementById('ram');
  const codeBox = document.getElementById('code');
  const outBox = document.getElementById('out');
  const cardsBox = document.getElementById('cards');
  const regsBox = document.getElementById('regs');
  document.body.append(cardDigitPatterns());
  const statusBox = document.getElementById('status');
  const effectBox = document.getElementById('effect');
  const speedBox = document.getElementById('speed');
  const board = document.getElementById('board');
  const arrowSvg = document.getElementById('arrow');
  const drumHead = document.getElementById('drum-head');
  const drumBox = document.getElementById('drum');
  const tapeHead = document.getElementById('tape-head');
  const tapeBox = document.getElementById('tape');

  for (const [k, d] of Object.entries(DEMOS)) demoSel.append(el('option', { value: k, text: d.name }));

  let prog = null;
  let vm = null;
  let last = { reads: [], writes: [] };
  let timer = null;
  let building = null;
  // How many VM steps each advance() took, so Previous undoes the same amount.
  const batches = [];

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

    const b = board.getBoundingClientRect();
    const x1 = s.right - b.left;
    const y1 = s.top + s.height / 2 - b.top;
    const x2 = c.left - b.left - 4;
    const y2 = c.top + c.height / 2 - b.top;
    const mx = (x1 + x2) / 2;

    const ns = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(ns, 'defs');
    const marker = document.createElementNS(ns, 'marker');
    marker.setAttribute('id', 'tip');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto');
    const head = document.createElementNS(ns, 'path');
    head.setAttribute('d', 'M 0 1 L 10 5 L 0 9 z');
    head.setAttribute('fill', '#58a6ff');
    marker.append(head);
    defs.append(marker);

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#58a6ff');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('marker-end', 'url(#tip)');
    arrowSvg.append(defs, path);
  }

  // A reel: the sector under the head in the middle, the one just gone above, the next one below.
  function renderDrum(words, cycles, io) {
    const head = headAt(cycles);
    const sec2 = (sec) => `S${String(sec).padStart(2, '0')}`;
    drumHead.textContent = `DRUM${io?.kind === 'drum' ? `  reading ${sec2(io.sector)}` : ''}`;
    drumBox.replaceChildren(...[-1, 0, 1].map((d) => {
      const sec = (head.sector + d + SECTORS) % SECTORS;
      return el('div', { class: `sector ${['above', 'at-head', 'below'][d + 1]}${io?.sector === sec ? ' want' : ''}` },
        el('span', { class: 'mark', text: d === 0 ? 'HEAD' : '' }),
        el('span', { class: 'sec', text: sec2(sec) }),
        ...Array.from({ length: SECTOR_WORDS }, (_, w) => el('span', {
          class: `w${d === 0 && w === head.word ? ' under' : ''}${d === 0 && w < head.word ? ' passed' : ''}${io?.sector === sec && w < io.done ? ' copied' : ''}`,
          text: String(words[sec * SECTOR_WORDS + w]),
        })));
    }));
  }

  // The tape moving past a fixed head in the middle, one word's length of tape per cell: each record is its gap, then its words.
  function renderTape(words, pos, io) {
    const at = Math.floor(pos / RECORD_SPAN);
    tapeHead.textContent = `TAPE  record ${Math.min(at + 1, RECORDS)} of ${RECORDS}${io?.kind === 'rewind' ? '  rewinding' : ''}`;
    tapeBox.replaceChildren(...Array.from({ length: 41 }, (_, i) => {
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

  function render(focusIp = null) {
    if (!prog) {
      renderTape(DEMOS[demoSel.value].tape ?? TAPE_DATA, 0, null);
      renderDrum(DEMOS[demoSel.value].drum ?? drumLayout(1), 0, null);
      statusBox.textContent = 'not compiled';
      effectBox.textContent = '';
      outBox.textContent = '';
      cardsBox.replaceChildren();
      regsBox.replaceChildren();
      linesBox.replaceChildren(...srcBox.value.split('\n').map(() => el('div', { class: 'line', text: ' ' })));
      linesBox.scrollTop = srcBox.scrollTop;
      ramBox.replaceChildren();
      codeBox.replaceChildren();
      arrowSvg.replaceChildren();
      return;
    }
    const s = vm.getState();
    const view = building === null ? null : compileView(prog, building);
    const m = view ? { lastIp: view.newIp, nextIp: null, lastLine: view.line, nextLine: null } : marks(prog.ipMap, s, focusIp);
    const { lastIp: activeIp, nextIp, lastLine: activeLine, nextLine } = m;
    const reads = new Set(last.reads);
    const writes = new Set(last.writes);

    statusBox.textContent = view
      ? `compiling: ${building}/${prog.events.length}`
      : `pc ${s.pc ?? '-'} | next ${nextIp ?? '-'} | cycle ${s.cycles} | waited ${s.waited}${s.halted ? ' | HALTED' : ''}`;
    effectBox.textContent = view ? '' : effect(prog, s);
    outBox.textContent = s.stdout.join('\n');
    cardsBox.replaceChildren(...s.cards.map((values) => card(values)), ...(s.io?.kind === 'punch' ? [card(s.io.values, s.io.done)] : []));
    cardsBox.scrollTop = cardsBox.scrollHeight;
    regsBox.replaceChildren(el('div', { class: 'reg acc', text: `AC (${s.AC})` }), el('div', { class: 'reg acc', text: `MQ (${s.MQ})` }), ...[0, 1, 2].map((r) => {
      const holder = prog.regLoops.find((l) => l.reg === r && s.pc >= l.from && s.pc < l.to)?.name;
      return el('div', { class: `reg${holder ? ' live' : ''}`, text: `${'ABC'[r]}${holder ? ` = ${holder}` : ''} (${s.XR[r]})` });
    }));

    linesBox.replaceChildren();
    srcBox.value.split('\n').forEach((_, idx) => {
      const ln = idx + 1;
      linesBox.append(el('div', { class: `line${ln === activeLine ? ' active' : ''}`, text: ln === nextLine ? '>' : ' ' }));
    });
    const focusLine = nextLine ?? activeLine;
    if (focusLine) {
      const top = (focusLine - 1) * 18;
      if (top < srcBox.scrollTop || top + 34 > srcBox.scrollTop + srcBox.clientHeight) srcBox.scrollTop = Math.max(0, top - 36);
    }
    linesBox.scrollTop = srcBox.scrollTop;

    const code = view ? view.code : Array.from({ length: prog.codeLen }, (_, i) => decode(s.MEM[i]));
    const codeCells = [];
    const dataCells = [];
    // With 256 words, free cells would fill the screen, so they show only their address, as code cells do.
    const freeCells = [];
    for (let i = 0; i < prog.initMem.length; i++) {
      const isCode = i < prog.codeLen;
      const into = isCode ? codeCells : dataCells;
      const placed = isCode ? code[i] !== undefined : i < (view ? view.cells : prog.usedCells);
      if (!placed) {
        (isCode ? codeCells : freeCells).push(el('div', { class: 'cell code unused' }, el('small', { text: String(i).padStart(2, '0') })));
        continue;
      }
      const cell = prog.cells[i];
      const fresh = view && (view.newCell !== null ? i >= view.newCell : i === view.newIp);
      const flash = writes.has(i) || fresh ? ' write' : (reads.has(i) ? ' read' : '');
      into.push(el('div', {
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
      const row = el('div', {
        class: `line${active ? ' active' : ''}`,
        'data-ip': i,
        title: describe(instr, prog.cells),
        onClick: () => render(i),
      },
      el('span', { text: `${isNext ? '>' : ' '} ${String(i).padStart(2, '0')}: ${asm(instr)}` }),
      );
      codeBox.append(row);
      if (isNext || (nextIp === null && active)) row.scrollIntoView({ block: 'nearest' });
    });

    renderDrum(s.DRUM, s.cycles, s.io);
    renderTape(s.TAPE, s.tapePos, s.io);
    requestAnimationFrame(drawArrow);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function load(walk) {
    prog = layout(srcBox.value, MEM_SIZE);
    vm = createVM(prog.initMem, DEMOS[demoSel.value].drum ?? drumLayout(1), DEMOS[demoSel.value].tape ?? TAPE_DATA);
    last = { reads: [], writes: [] };
    building = walk ? 0 : null;
    batches.length = 0;
  }

  function unload() {
    stop();
    prog = null;
    vm = null;
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

  // Every cycle takes the same time, except that words coming off a device and card rows are slowed down to watch.
  function delay() {
    if (building !== null) return 80;
    const s = vm.getState();
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
    if (vm.getState().halted) return false;
    const done = vm.getState().io?.done;
    let n = 0;
    let io;
    do {
      last = vm.step();
      n++;
      io = vm.getState().io;
    } while (io && io.done === done && n < (io.kind === 'punch' ? ROW_CYCLES : SECTOR_WORDS * DRUM_WORD_CYCLES));
    batches.push(n);
    return !last.halted;
  }

  demoSel.addEventListener('change', () => { srcBox.value = DEMOS[demoSel.value].code; unload(); render(); });
  srcBox.addEventListener('input', () => { unload(); render(); });
  document.getElementById('compile').addEventListener('click', () => act(() => {
    load(true);
    play(() => advance() && building !== null);
  }));
  document.getElementById('stop').addEventListener('click', () => { stop(); render(); });
  document.getElementById('step').addEventListener('click', () => { stop(); act(advance); });
  document.getElementById('back').addEventListener('click', () => {
    stop();
    if (building !== null) building = Math.max(0, building - 1);
    else if (vm) {
      const n = batches.pop() ?? 1;
      for (let k = 0; k < n; k++) vm.stepBack();
      last = { reads: [], writes: [] };
    }
    render();
  });
  document.getElementById('run').addEventListener('click', () => {
    if (vm && building === null && vm.getState().halted) vm.reset();
    play(advance);
  });
  srcBox.addEventListener('scroll', () => { linesBox.scrollTop = srcBox.scrollTop; drawArrow(); });
  codeBox.addEventListener('scroll', drawArrow);
  window.addEventListener('resize', drawArrow);

  srcBox.value = DEMOS.factorial.code;
  render();
}

if (typeof document !== 'undefined' && document.getElementById('demo')) mount();
