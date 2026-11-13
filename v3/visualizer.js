import { compile } from './compiler.js';
import { ALU, GAP, RECORDS, RECORD_SPAN, RECORD_WORDS, SECTORS, SECTOR_WORDS, createVM, decode, headAt, ioWait } from './vm.js';

export const MEM_SIZE = 128;

// The 128-word array 1, 2, ... on the drum, block K stored in sector MOD(K * skip, 16).
export function drumLayout(skip) {
  const drum = new Int32Array(SECTORS * SECTOR_WORDS);
  for (let k = 0; k < SECTORS; k++) {
    for (let w = 0; w < SECTOR_WORDS; w++) drum[((k * skip) % SECTORS) * SECTOR_WORDS + w] = k * SECTOR_WORDS + w + 1;
  }
  return drum;
}

// Record R of the tape holds 8R+1 .. 8R+8.
export const TAPE_DATA = Int32Array.from({ length: RECORDS * RECORD_WORDS }, (_, i) => i + 1);

export const DEMOS = {
  factorial: {
    name: '1. Factorial',
    code: 'N = 5\nFACT = 1\nDO I = 1, N\n  FACT = FACT * I\nEND\nPRINT FACT',
  },
  swap: {
    name: '2. SWAP + Constant Bug',
    code: 'SUB SWAP(A, B)\n  TMP = A\n  A = B\n  B = TMP\nEND\nX = 10\nY = 99\nCALL SWAP(X, Y)\nPRINT X\nPRINT Y\nCALL SWAP(2, Y)\nPRINT 2',
  },
  saxpy: {
    name: '3. 2D Matrix SAXPY',
    code: 'DIM A(3, 2)\nDIM Y(3)\nSUB SAXPY(N, ALPHA, X, OUT)\n  DO I = 0, N - 1\n    OUT[I] = ALPHA * X[I] + OUT[I]\n  END\nEND\nDO C = 0, 1\n  DO R = 0, 2\n    A[R, C] = (C + 1) * 10 + R\n  END\nEND\nCALL SAXPY(3, 2, A[0, 0], Y)\nCALL SAXPY(3, 1, A[0, 1], Y)\nDO I = 0, 2\n  PRINT Y[I]\nEND',
  },
  equiv: {
    name: '4. EQUIV Overlay',
    code: 'DIM WORKSPACE(4)\nEQUIV VIEW_A(2, 2) = WORKSPACE\nVIEW_A[0, 0] = 11\nVIEW_A[1, 0] = 22\nVIEW_A[0, 1] = 33\nVIEW_A[1, 1] = 44\nDO I = 0, 3\n  PRINT WORKSPACE[I]\nEND',
  },
  drumSeq: {
    name: '5. Drum, blocks in order',
    code: 'DIM BUF(8)\nSKIP = 1\nSUM = 0\nDO K = 0, 15\n  READ DRUM MOD(K * SKIP, 16), BUF\n  DO I = 0, 7\n    SUM = SUM + BUF[I]\n  END\nEND\nPRINT SUM',
    drum: drumLayout(1),
  },
  drumSkip: {
    name: '6. Drum, blocks interleaved',
    code: 'DIM BUF(8)\nSKIP = 11\nSUM = 0\nDO K = 0, 15\n  READ DRUM MOD(K * SKIP, 16), BUF\n  DO I = 0, 7\n    SUM = SUM + BUF[I]\n  END\nEND\nPRINT SUM',
    drum: drumLayout(11),
  },
  tape: {
    name: '7. Tape and rewind',
    code: 'DIM R(8)\nDO K = 1, 20\n  READ TAPE R\nEND\nPRINT R[0]\nREWIND\nREAD TAPE R\nPRINT R[0]',
    tape: TAPE_DATA,
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

// The compiler's output plus each memory cell's role and label, built from its allocations.
export function layout(source, memSize) {
  const prog = compile(source, memSize);
  const cells = Array.from({ length: prog.initMem.length }, (_, i) => (i < prog.codeLen ? { role: 'code', label: prog.code[i].join(' ') } : { role: 'unused', label: '' }));
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
  const name = (i) => prog.cells[i]?.label || `M[${i}]`;
  const cyc = (n) => `${n} cycle${n === 1 ? '' : 's'}`;
  const record = Math.floor(state.tapePos / RECORD_SPAN);
  if (state.io) {
    const { kind, sector, addr, done } = state.io;
    const wait = ioWait(state);
    if (kind === 'rewind') return `rewinding: ${cyc(wait)} left`;
    if (kind === 'tape') {
      if (wait) return `tape starting: ${cyc(wait)} left`;
      return `tape record ${record + 1} word ${done} (${state.TAPE[record * RECORD_WORDS + done]}) -> ${name(addr + done)}`;
    }
    if (wait) return `waiting for drum sector ${sector}: ${cyc(wait)} left`;
    return `drum sector ${sector} word ${done} (${state.DRUM[sector * SECTOR_WORDS + done]}) -> ${name(addr + done)}`;
  }
  const val = (i) => `${name(i)} (${M[i]})`;
  const via = (i) => `*${name(i)} = ${name(M[i])} [${M[i]}]`;
  if (op === 'HALT') return 'halt';
  if (op === 'MOV') return `${val(b)} -> ${name(a)}`;
  if (op === 'LOAD_IND') return `${via(b)} (${M[M[b]]}) -> ${name(a)}`;
  if (op === 'STORE_IND') return `${val(b)} -> ${via(a)}`;
  if (op === 'PRINT') return `print ${val(a)}`;
  if (op === 'JMP') return `jump to ${a}`;
  if (op === 'JAL') return `call ${b}, return to ${state.ip + 1} -> ${name(a)}`;
  if (op === 'JMP_IND') return `return to ${M[a]} (from ${name(a)})`;
  if (op === 'JZ') return M[b] === 0 ? `${val(b)} is 0: jump to ${a}` : `${val(b)} is not 0: next`;
  if (op === 'DRUM_READ') {
    const wait = ioWait({ io: { kind: 'drum', sector: M[b], done: 0 }, cycles: state.cycles + 1 });
    return `read drum sector ${val(b)} -> ${name(M[a])}..${name(M[a] + SECTOR_WORDS - 1)}, waiting ${cyc(wait)} first`;
  }
  if (op === 'TAPE_READ') {
    const wait = ioWait({ io: { kind: 'tape' }, tapePos: state.tapePos });
    return `read tape record ${record + 1} -> ${name(M[a])}..${name(M[a] + RECORD_WORDS - 1)}, waiting ${cyc(wait)} first`;
  }
  if (op === 'REWIND') {
    return state.tapePos ? `rewind the tape from record ${record + 1}: ${cyc(ioWait({ io: { kind: 'rewind' }, tapePos: state.tapePos }))}` : 'rewind: tape already at the start';
  }
  if (!(op in ALU)) return `unknown opcode ${op}`;
  return `${val(b)} ${op} ${val(c)} = ${ALU[op](M[b], M[c])} -> ${name(a)}`;
}

// Hover text for one instruction: the opcode's name and what it does with these operands.
export function describe([op, a, b, c], cells) {
  const m = (i) => `M[${i}] ${cells[i]?.label ?? ''}`.trim();
  if (op === 'HALT') return 'HALT: stop the program';
  if (op === 'MOV') return `MOV (move): copy ${m(b)} into ${m(a)}`;
  if (op === 'LOAD_IND') return `LOAD_IND (load indirect): ${m(b)} holds an address; copy the cell at that address into ${m(a)}`;
  if (op === 'STORE_IND') return `STORE_IND (store indirect): ${m(a)} holds an address; copy ${m(b)} into the cell at that address`;
  if (op === 'PRINT') return `PRINT: print ${m(a)}`;
  if (op === 'JMP') return `JMP (jump): go to instruction ${a}`;
  if (op === 'JAL') return `JAL (jump and link): save the return address in ${m(a)}, go to instruction ${b}`;
  if (op === 'JMP_IND') return `JMP_IND (jump indirect): go to the instruction whose number is in ${m(a)} (return from SUB)`;
  if (op === 'JZ') return `JZ (jump if zero): if ${m(b)} is 0, go to instruction ${a}; else go to the next one`;
  if (op === 'TAPE_READ') return `TAPE_READ (read tape): start the tape, then copy the next record's ${RECORD_WORDS} words into the cells from the address in ${m(a)}`;
  if (op === 'REWIND') return 'REWIND: wind the tape back to the start';
  if (op === 'DRUM_READ') return `DRUM_READ (read drum): wait for drum sector ${m(b)} to reach the head, then copy its ${SECTOR_WORDS} words into the cells from the address in ${m(a)}`;
  return `${op}: ${m(a)} = ${m(b)} ${op} ${m(c)}${ALU[op] && /[<>=!]/.test(op) ? ' (1 if true, 0 if false)' : ''}`;
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

  // The tape moving past a fixed head in the middle: each record is its start-up gap, then its words.
  function renderTape(words, pos, io) {
    const at = Math.floor(pos / RECORD_SPAN);
    tapeHead.textContent = `TAPE  record ${Math.min(at + 1, RECORDS)} of ${RECORDS}${io?.kind === 'rewind' ? '  rewinding' : ''}`;
    tapeBox.replaceChildren(...Array.from({ length: 13 }, (_, i) => {
      const u = pos - 6 + i;
      if (u < 0 || u >= RECORDS * RECORD_SPAN) return el('span', { class: 'tu off' });
      const rec = Math.floor(u / RECORD_SPAN);
      const w = (u % RECORD_SPAN) - GAP;
      const under = u === pos ? ' under' : '';
      if (w < 0) return el('span', { class: `tu gap${w === -GAP ? ' label' : ''}${under}`, text: w === -GAP ? `#${rec + 1}` : '' });
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
    for (let i = 0; i < prog.initMem.length; i++) {
      const isCode = i < prog.codeLen;
      const into = isCode ? codeCells : dataCells;
      const placed = isCode ? code[i] !== undefined : i < (view ? view.cells : prog.usedCells);
      if (!placed) {
        into.push(isCode
          ? el('div', { class: 'cell code unused' }, el('small', { text: String(i).padStart(2, '0') }))
          : el('div', { class: 'cell unused' }, el('small', { text: `[${i}]` }), el('strong', { text: ' ' })));
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
    ramBox.replaceChildren(el('div', { class: 'code-strip' }, ...codeCells), el('div', { class: 'data-grid' }, ...dataCells));

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
      el('span', { text: `${isNext ? '>' : ' '} ${String(i).padStart(2, '0')}: ${instr.join(' ')}` }),
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

  // Every cycle takes the same time, except that a word coming off the drum is slowed down to watch.
  function delay() {
    if (building !== null) return 80;
    const s = vm.getState();
    return s.io && s.io.kind !== 'rewind' && !ioWait(s) ? 120 : 12;
  }

  // The speed slider scales every delay; its middle position runs at half the original speed.
  const pace = (ms) => ms * 2 ** (6 - Number(speedBox.value));

  // Advance on a timer, at the slider's speed, until more() says there is nothing left to do.
  function play(more) {
    stop();
    const tick = () => act(() => {
      if (!more()) return stop();
      timer = setTimeout(tick, pace(delay()));
    });
    timer = setTimeout(tick, 0);
  }

  // One compile event while walking the compile, else one instruction; false once halted.
  function advance() {
    if (building !== null) {
      building++;
      if (building >= prog.events.length) building = null;
      return true;
    }
    if (!prog) load(false);
    if (vm.getState().halted) return false;
    last = vm.step();
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
    else if (vm) { vm.stepBack(); last = { reads: [], writes: [] }; }
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
