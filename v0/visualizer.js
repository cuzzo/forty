import { compile } from './compiler.js';
import { ALU, createVM } from './vm.js';

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

// What the next instruction will do, in the names of the cells it touches.
export function effect(prog, state) {
  if (state.halted) return 'halted';
  const [op, a, b, c] = prog.code[state.ip];
  const M = state.MEM;
  const name = (i) => prog.cells[i]?.label || `M[${i}]`;
  const val = (i) => `${name(i)} (${M[i]})`;
  const via = (i) => `*${name(i)} = ${name(M[i])} [${M[i]}]`;
  if (op === 'MOV') return `${val(b)} -> ${name(a)}`;
  if (op === 'LOAD_IND') return `${via(b)} (${M[M[b]]}) -> ${name(a)}`;
  if (op === 'STORE_IND') return `${val(b)} -> ${via(a)}`;
  if (op === 'PRINT') return `print ${val(a)}`;
  if (op === 'JMP') return `jump to ${a}`;
  if (op === 'JAL') return `call ${b}, return to ${state.ip + 1} -> ${name(a)}`;
  if (op === 'JMP_IND') return `return to ${M[a]} (from ${name(a)})`;
  if (op === 'JZ') return M[b] === 0 ? `${val(b)} is 0: jump to ${a}` : `${val(b)} is not 0: next`;
  return `${val(b)} ${op} ${val(c)} = ${ALU[op](M[b], M[c])} -> ${name(a)}`;
}

// Hover text for one instruction: the opcode's name and what it does with these operands.
export function describe([op, a, b, c], cells) {
  const m = (i) => `M[${i}] ${cells[i]?.label ?? ''}`.trim();
  if (op === 'MOV') return `MOV (move): copy ${m(b)} into ${m(a)}`;
  if (op === 'LOAD_IND') return `LOAD_IND (load indirect): ${m(b)} holds an address; copy the cell at that address into ${m(a)}`;
  if (op === 'STORE_IND') return `STORE_IND (store indirect): ${m(a)} holds an address; copy ${m(b)} into the cell at that address`;
  if (op === 'PRINT') return `PRINT: print ${m(a)}`;
  if (op === 'JMP') return `JMP (jump): go to instruction ${a}`;
  if (op === 'JAL') return `JAL (jump and link): save the return address in ${m(a)}, go to instruction ${b}`;
  if (op === 'JMP_IND') return `JMP_IND (jump indirect): go to the instruction whose number is in ${m(a)} (return from SUB)`;
  if (op === 'JZ') return `JZ (jump if zero): if ${m(b)} is 0, go to instruction ${a}; else go to the next one`;
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
  const board = document.getElementById('board');
  const arrowSvg = document.getElementById('arrow');

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

  function render(focusIp = null) {
    if (!prog) {
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
      : `pc: ${s.pc ?? '-'} | next: ${nextIp ?? '-'} | steps: ${s.steps}${s.halted ? ' | HALTED' : ''}`;
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

    ramBox.replaceChildren();
    for (let i = 0; i < (view ? view.cells : prog.usedCells); i++) {
      const cell = prog.cells[i];
      const fresh = view && view.newCell !== null && i >= view.newCell;
      const flash = writes.has(i) || fresh ? ' write' : (reads.has(i) ? ' read' : '');
      ramBox.append(el('div', {
        class: `cell ${cell.role}${flash}`,
        onMouseenter: () => [...linesBox.children].forEach((row, idx) => row.classList.toggle('hover', prog.cellLines[i].has(idx + 1))),
        onMouseleave: () => [...linesBox.children].forEach((row) => row.classList.remove('hover')),
      },
        el('small', { text: `[${i}] ${cell.label}` }),
        el('strong', { text: String(view ? prog.initMem[i] : s.MEM[i]) }),
      ));
    }

    codeBox.replaceChildren();
    (view ? view.code : prog.code).forEach((instr, i) => {
      const active = i === activeIp;
      const isNext = i === nextIp;
      const row = el('div', {
        class: `line${active ? ' active' : ''}`,
        title: describe(instr, prog.cells),
        onClick: () => render(i),
      },
      el('span', { text: `${isNext ? '>' : ' '} ${String(i).padStart(2, '0')}: ${instr.join(' ')}` }),
      );
      codeBox.append(row);
      if (isNext || (nextIp === null && active)) row.scrollIntoView({ block: 'nearest' });
    });

    requestAnimationFrame(drawArrow);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function load(walk) {
    prog = compile(srcBox.value, 64);
    vm = createVM(prog.code, prog.initMem);
    last = { reads: [], writes: [] };
    building = walk ? 0 : null;
  }

  function unload() {
    stop();
    prog = null;
    vm = null;
    building = null;
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
  document.getElementById('compile').addEventListener('click', () => { stop(); load(true); render(); });
  document.getElementById('step').addEventListener('click', () => { stop(); advance(); render(); });
  document.getElementById('back').addEventListener('click', () => {
    stop();
    if (building !== null) building = Math.max(0, building - 1);
    else if (vm) { vm.stepBack(); last = { reads: [], writes: [] }; }
    render();
  });
  document.getElementById('reset').addEventListener('click', () => { unload(); render(); });
  document.getElementById('run').addEventListener('click', () => {
    if (timer) { stop(); render(); return; }
    if (vm && building === null && vm.getState().halted) vm.reset();
    timer = setInterval(() => {
      if (!advance()) stop();
      render();
    }, 80);
  });
  srcBox.addEventListener('scroll', () => { linesBox.scrollTop = srcBox.scrollTop; drawArrow(); });
  codeBox.addEventListener('scroll', drawArrow);
  window.addEventListener('resize', drawArrow);

  srcBox.value = DEMOS.factorial.code;
  render();
}

if (typeof document !== 'undefined' && document.getElementById('demo')) mount();
