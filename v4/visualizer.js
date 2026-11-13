import { compile, emitRiscv } from './compiler.js';
import { createVM, createRiscvVM } from './vm.js';

export const DEMOS = {
  factorial: {
    name: '1. Iterative Factorial (DO + Backpatching)',
    memSize: 64,
    tape: [],
    code: [
      'N = 5',
      'FACT = 1',
      'DO I = 1, N',
      '  FACT = FACT * I',
      'END',
      'PRINT FACT',
    ].join('\n'),
  },
  swap: {
    name: '2. Swap & Constant-Mutation Bug (.rodata MMU)',
    memSize: 64,
    tape: [],
    code: [
      'SUB SWAP(A, B)',
      '  TMP = A',
      '  A = B',
      '  B = TMP',
      'END',
      '',
      'X = 10',
      'Y = 99',
      'CALL SWAP(X, Y)',
      'PRINT X',
      'PRINT Y',
      '',
      '# Toggle ".rodata MMU" off vs on:',
      'CALL SWAP(2, Y)',
      'PRINT 2',
    ].join('\n'),
  },
  saxpy: {
    name: '3. 2D Matrix SAXPY Column Slicing',
    memSize: 64,
    tape: [],
    code: [
      'DIM A(3, 2)',
      'DIM Y(3)',
      '',
      'SUB SAXPY(N, ALPHA, X, OUT)',
      '  DO I = 0, N - 1',
      '    OUT[I] = ALPHA * X[I] + OUT[I]',
      '  END',
      'END',
      '',
      'DO C = 0, 1',
      '  DO R = 0, 2',
      '    A[R, C] = (C + 1) * 10 + R',
      '  END',
      'END',
      '',
      'CALL SAXPY(3, 2, A[0, 0], Y)',
      'CALL SAXPY(3, 1, A[0, 1], Y)',
      '',
      'DO I = 0, 2',
      '  PRINT Y[I]',
      'END',
    ].join('\n'),
  },
  equiv: {
    name: '4. EQUIV Static Memory Overlay',
    memSize: 64,
    tape: [],
    code: [
      'DIM WORKSPACE(4)',
      'EQUIV VIEW_A(2, 2) = WORKSPACE',
      '',
      'VIEW_A[0, 0] = 11',
      'VIEW_A[1, 0] = 22',
      'VIEW_A[0, 1] = 33',
      'VIEW_A[1, 1] = 44',
      '',
      'DO I = 0, 3',
      '  PRINT WORKSPACE[I]',
      'END',
    ].join('\n'),
  },
  tapeFilter: {
    name: '5. Multi-Tape Stream Filter & Rewind',
    memSize: 64,
    tape: [3, -1, 7, 0, 5],
    code: [
      'IS_EOF = 0',
      'DO STEP = 1, 20',
      '  IF IS_EOF == 0 THEN',
      '    READ(0) X, IS_EOF',
      '    IF IS_EOF == 0 THEN',
      '      IF X > 0 THEN',
      '        WRITE(1) X * 2',
      '      END',
      '    END',
      '  END',
      'END',
      'REWIND(1)',
      'IS_EOF = 0',
      'DO STEP = 1, 20',
      '  IF IS_EOF == 0 THEN',
      '    READ(1) Y, IS_EOF',
      '    IF IS_EOF == 0 THEN',
      '      PRINT Y',
      '    END',
      '  END',
      'END',
    ].join('\n'),
  },
  drum: {
    name: '6. Rotating Drum Matrix Paging',
    memSize: 64,
    tape: [],
    drumSeed: [1, 2, 3, 4, 5, 6, 7, 8],
    code: [
      'DIM BUF(8)',
      'EQUIV TILE(4, 2) = BUF',
      'DRUM_READ(0, 0, BUF)',
      'DO C = 0, 1',
      '  DO R = 0, 3',
      '    TILE[R, C] = TILE[R, C] + 100',
      '  END',
      'END',
      'DRUM_WRITE(0, 2, BUF)',
      'PRINT TILE[3, 1]',
    ].join('\n'),
  },
};

const RV_DISPLAY_REGS = [
  ['s0', 8], ['t0', 5], ['t1', 6], ['a0', 10], ['a1', 11], ['a2', 12], ['a7', 17],
];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const ch of children) {
    if (ch != null) node.append(ch);
  }
  return node;
}

function fmtInstr(instr) {
  return `${instr[0].padEnd(10)} ${instr[1]}, ${instr[2]}, ${instr[3]}`;
}

const span = (dims) => (dims ? dims[0] * (dims[1] ?? 1) : 1);

function cellLabelFor(name, i, dims) {
  if (!dims) return name;
  if (dims.length === 2) return `${name}[${i % dims[0]},${Math.floor(i / dims[0])}]`;
  return `${name}[${i}]`;
}

// The compiled program plus each memory cell's role, label and EQUIV aliases, built from the compiler's allocations.
export function layout(source, options) {
  const compiled = compile(source, options);
  const { allocs, aliases } = compiled.debug;
  const cells = Array.from({ length: compiled.usedCells }, () => ({ role: 'unused', label: '', aliases: [] }));
  for (const { base, size, role, label, dims } of allocs) {
    for (let i = 0; i < size; i++) cells[base + i] = { role, label: label ? cellLabelFor(label, i, dims) : `tmp_${base + i}`, aliases: [] };
  }
  for (const { name, addr, dims } of aliases) {
    for (let i = 0; i < span(dims); i++) cells[addr + i]?.aliases.push(cellLabelFor(name, i, dims));
  }
  return { ...compiled, debug: { ...compiled.debug, cells } };
}

function replayCompileEvents(events, limit) {
  const code = [];
  let lastPatchedIp = -1;
  for (let i = 0; i < limit && i < events.length; i++) {
    const ev = events[i];
    if (ev.kind === 'emit') {
      code[ev.ip] = [...ev.instr];
      lastPatchedIp = -1;
    } else if (ev.kind === 'patch') {
      code[ev.ip] = [...ev.instr];
      lastPatchedIp = ev.ip;
    }
  }
  return { code, lastPatchedIp };
}

function collectMatrices(debug) {
  const list = [];
  for (const [name, info] of Object.entries(debug.symbols)) {
    if (info.dims?.length === 2) list.push({ name, addr: info.addr, rows: info.dims[0], cols: info.dims[1] });
  }
  return list;
}

export function mountVisualizer(doc = document) {
  const dom = {
    demoSelect: doc.getElementById('demoSelect'),
    targetMode: doc.getElementById('targetMode'),
    memSize: doc.getElementById('memSize'),
    protectRodata: doc.getElementById('protectRodata'),
    source: doc.getElementById('source'),
    tapeInput: doc.getElementById('tapeInput'),
    sourceLines: doc.getElementById('sourceLines'),
    compileBtn: doc.getElementById('compileBtn'),
    stepBackBtn: doc.getElementById('stepBackBtn'),
    stepBtn: doc.getElementById('stepBtn'),
    runBtn: doc.getElementById('runBtn'),
    resetBtn: doc.getElementById('resetBtn'),
    speedSelect: doc.getElementById('speedSelect'),
    timeScrubber: doc.getElementById('timeScrubber'),
    stepCount: doc.getElementById('stepCount'),
    statusText: doc.getElementById('statusText'),
    trapBanner: doc.getElementById('trapBanner'),
    stdout: doc.getElementById('stdout'),
    cycleCount: doc.getElementById('cycleCount'),
    ramWrap: doc.getElementById('ramWrap'),
    ramSvg: doc.getElementById('ramSvg'),
    ramGrid: doc.getElementById('ramGrid'),
    ipLabel: doc.getElementById('ipLabel'),
    compileScrubber: doc.getElementById('compileScrubber'),
    compileEventLabel: doc.getElementById('compileEventLabel'),
    codeList: doc.getElementById('codeList'),
    regsWrap: doc.getElementById('regsWrap'),
    regsGrid: doc.getElementById('regsGrid'),
    matrices: doc.getElementById('matrices'),
    tapes: doc.getElementById('tapes'),
    drum: doc.getElementById('drum'),
  };

  for (const [key, demo] of Object.entries(DEMOS)) {
    dom.demoSelect.append(el('option', { value: key, text: demo.name }));
  }

  let compiled = null;
  let vm = null;
  let lastEvent = null;
  let selectedLine = null;
  let maxSeenStep = 0;
  let running = false;
  let rafId = null;
  let lastTick = 0;

  function stopRun() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    dom.runBtn.textContent = 'Run';
  }

  function parseTape() {
    const raw = dom.tapeInput.value.trim();
    if (!raw) return [];
    return raw.split(',').map((s) => Number(s.trim()) | 0);
  }

  function buildProgram() {
    stopRun();
    const memSize = Number(dom.memSize.value);
    const protectRodata = dom.protectRodata.checked;
    const target = dom.targetMode.value;
    const demo = DEMOS[dom.demoSelect.value];
    const initDrum = demo?.drumSeed ? new Int32Array(demo.drumSeed) : null;

    try {
      compiled = layout(dom.source.value, { memSize });
      const vmOpts = { debug: compiled.debug, protectRodata, initTape: parseTape(), initDrum };
      if (target === 'riscv') {
        const asm = emitRiscv(compiled.code, compiled.initMem, compiled.usedCells);
        vm = createRiscvVM(asm, compiled.initMem, vmOpts);
      } else {
        vm = createVM(compiled.code, compiled.initMem, vmOpts);
      }
      lastEvent = null;
      selectedLine = null;
      maxSeenStep = 0;
      dom.compileScrubber.max = String(compiled.debug.compileEvents.length);
      dom.compileScrubber.value = String(compiled.debug.compileEvents.length);
      dom.trapBanner.classList.remove('active');
      render();
    } catch (err) {
      dom.trapBanner.textContent = `Compile Error: ${err.message}`;
      dom.trapBanner.classList.add('active');
    }
  }

  function loadDemo(key) {
    const demo = DEMOS[key];
    dom.source.value = demo.code;
    dom.memSize.value = String(demo.memSize);
    dom.tapeInput.value = demo.tape.join(', ');
    buildProgram();
  }

  function renderSourceLines(activeLine) {
    dom.sourceLines.replaceChildren();
    const lines = dom.source.value.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = i + 1;
      const cls = `code-line${ln === activeLine ? ' active' : ''}`;
      dom.sourceLines.append(el('div', { class: cls },
        el('span', { class: 'ip-num', text: String(ln).padStart(2, '0') }),
        el('span', { text: lines[i] || ' ' }),
      ));
    }
  }

  function drawDerefArrow() {
    dom.ramSvg.replaceChildren();
    if (!lastEvent?.deref || lastEvent.deref.ptrCell == null) return;
    const fromEl = dom.ramGrid.querySelector(`[data-addr="${lastEvent.deref.ptrCell}"]`);
    const toEl = dom.ramGrid.querySelector(`[data-addr="${lastEvent.deref.targetAddr}"]`);
    if (!fromEl || !toEl) return;

    const wrap = dom.ramWrap.getBoundingClientRect();
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const x1 = a.left - wrap.left + a.width / 2;
    const y1 = a.top - wrap.top + a.height / 2;
    const x2 = b.left - wrap.left + b.width / 2;
    const y2 = b.top - wrap.top + b.height / 2;
    const cx = (x1 + x2) / 2;
    const cy = Math.min(y1, y2) - 28;
    const color = lastEvent.deref.access === 'write' ? '#fb923c' : '#22d3ee';

    const ns = 'http://www.w3.org/2000/svg';
    const defs = doc.createElementNS(ns, 'defs');
    const marker = doc.createElementNS(ns, 'marker');
    marker.setAttribute('id', 'arrow');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const poly = doc.createElementNS(ns, 'path');
    poly.setAttribute('d', 'M 0 1 L 10 5 L 0 9 z');
    poly.setAttribute('fill', color);
    marker.append(poly);
    defs.append(marker);

    const path = doc.createElementNS(ns, 'path');
    path.setAttribute('d', `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('marker-end', 'url(#arrow)');
    dom.ramSvg.append(defs, path);
  }

  function renderRam(state) {
    dom.ramGrid.replaceChildren();
    const reads = new Set(lastEvent?.reads ?? []);
    const writes = new Set(lastEvent?.writes ?? []);
    const visibleLimit = Math.min(state.MEM.length, Math.max(compiled.usedCells + 8, 32));

    for (let addr = 0; addr < visibleLimit; addr++) {
      const info = compiled.debug.cells[addr];
      const role = info?.role ?? 'unused';
      const flash = writes.has(addr) ? ' flash-write' : (reads.has(addr) ? ' flash-read' : '');
      const labelParts = [info?.label || ''];
      if (info?.aliases?.length) labelParts.push(`(${info.aliases.join(', ')})`);

      dom.ramGrid.append(el('div', { class: `cell${flash}`, 'data-addr': String(addr), 'data-role': role },
        el('div', { class: 'cell-top' }, el('span', { text: `[${String(addr).padStart(2, '0')}]` })),
        el('div', { class: 'cell-val', text: String(state.MEM[addr]) }),
        el('div', { class: 'cell-lbl', text: labelParts.filter(Boolean).join(' ') || role }),
      ));
    }
    requestAnimationFrame(drawDerefArrow);
  }

  function renderCode(state) {
    dom.codeList.replaceChildren();
    if (dom.targetMode.value === 'riscv' && state.instrs) {
      dom.regsWrap.style.display = '';
      dom.compileScrubber.parentElement.style.display = 'none';
      for (let i = 0; i < state.instrs.length; i++) {
        const active = i === state.ip ? ' active' : '';
        dom.codeList.append(el('div', { class: `code-line${active}` },
          el('span', { class: 'ip-num', text: String(i).padStart(3, '0') }),
          el('span', { text: state.instrs[i].text }),
        ));
      }
      dom.regsGrid.replaceChildren();
      for (const [name, idx] of RV_DISPLAY_REGS) {
        dom.regsGrid.append(el('div', { class: 'reg-box' },
          el('span', { text: name }),
          el('span', { text: String(state.regs[idx]) }),
        ));
      }
      return;
    }

    dom.regsWrap.style.display = 'none';
    dom.compileScrubber.parentElement.style.display = 'flex';
    const events = compiled.debug.compileEvents;
    const limit = Number(dom.compileScrubber.value);
    const isFull = limit >= events.length;
    dom.compileEventLabel.textContent = isFull ? 'all' : `${limit}/${events.length}`;

    const view = isFull
      ? { code: compiled.code, lastPatchedIp: -1 }
      : replayCompileEvents(events, limit);

    for (let i = 0; i < view.code.length; i++) {
      const instr = view.code[i];
      if (!instr) continue;
      const cls = `code-line${i === state.ip ? ' active' : ''}${i === view.lastPatchedIp ? ' patched' : ''}`;
      dom.codeList.append(el('div', {
        class: cls,
        onClick: () => {
          selectedLine = compiled.debug.ipMap[i] ?? null;
          renderSourceLines(selectedLine);
        },
      },
      el('span', { class: 'ip-num', text: String(i).padStart(3, '0') }),
      el('span', { text: fmtInstr(instr) }),
      ));
    }
  }

  function renderMatrices(state) {
    dom.matrices.replaceChildren();
    const mats = collectMatrices(compiled.debug);
    if (!mats.length) return;
    for (const m of mats) {
      const grid = el('div', { class: 'matrix-grid', style: `grid-template-columns: repeat(${m.cols}, auto)` });
      for (let r = 0; r < m.rows; r++) {
        for (let c = 0; c < m.cols; c++) {
          const addr = m.addr + r + c * m.rows;
          grid.append(el('div', { class: 'mat-cell' },
            el('div', { text: String(state.MEM[addr]) }),
            el('small', { text: `[${r},${c}] @${addr}` }),
          ));
        }
      }
      dom.matrices.append(el('div', { class: 'card-head', text: `${m.name} (${m.rows}x${m.cols} col-major)` }), grid);
    }
  }

  function renderPeripherals(state) {
    dom.tapes.replaceChildren();
    const hasTapes = state.tapes.some((t) => t.length > 0);
    if (hasTapes) {
      dom.tapes.append(el('div', { class: 'card-head', text: 'Magnetic Tapes' }));
      state.tapes.forEach((t, u) => {
        if (!t.length && state.tapeHeads[u] === 0) return;
        const row = el('div', { class: 'tape-row' }, el('span', { text: `U${u}:` }));
        t.forEach((val, idx) => {
          const cls = `tape-item${idx === state.tapeHeads[u] ? ' head' : ''}`;
          row.append(el('span', { class: cls, text: String(val) }));
        });
        if (state.tapeHeads[u] >= t.length) row.append(el('span', { class: 'tape-item head', text: 'EOF' }));
        dom.tapes.append(row);
      });
    }

    dom.drum.replaceChildren();
    const hasDrum = state.drum.some((v) => v !== 0) || lastEvent?.drum;
    if (hasDrum) {
      const info = lastEvent?.drum ? ` (stall: ${lastEvent.drum.stallCycles} cyc)` : '';
      dom.drum.append(el('div', { class: 'card-head', text: `Magnetic Drum (Track 0, head @ sector ${state.drumAngle})${info}` }));
      const grid = el('div', { class: 'drum-grid' });
      for (let s = 0; s < 8; s++) {
        const cls = `drum-sec${s === state.drumAngle ? ' angle' : ''}${lastEvent?.drum?.sector === s ? ' active' : ''}`;
        grid.append(el('div', { class: cls, text: `S${s}:${state.drum[s * 8]}` }));
      }
      dom.drum.append(grid);
    }
  }

  function render() {
    if (!vm || !compiled) return;
    const state = vm.getState();
    maxSeenStep = Math.max(maxSeenStep, state.steps);
    dom.timeScrubber.max = String(maxSeenStep);
    dom.timeScrubber.value = String(state.steps);
    dom.stepCount.textContent = String(state.steps);
    dom.cycleCount.textContent = `cycles: ${state.cycles}`;
    dom.ipLabel.textContent = `ip: ${state.ip}`;
    dom.stdout.textContent = state.stdout.join('\n');
    dom.statusText.textContent = state.trap ? state.trap.code : (state.halted ? 'Halted' : 'Running');

    if (state.trap) {
      dom.trapBanner.textContent = `${state.trap.code}: ${state.trap.message}`;
      dom.trapBanner.classList.add('active');
    } else {
      dom.trapBanner.classList.remove('active');
    }

    dom.stepBackBtn.disabled = state.steps === 0;
    dom.stepBtn.disabled = state.halted;

    const activeLine = selectedLine ?? compiled.debug.ipMap[lastEvent?.pc ?? state.ip] ?? null;
    renderSourceLines(activeLine);
    renderRam(state);
    renderCode(state);
    renderMatrices(state);
    renderPeripherals(state);
  }

  function stepOnce() {
    if (!vm) return;
    selectedLine = null;
    const res = vm.step();
    lastEvent = res.event ?? null;
    if (res.halted) stopRun();
    render();
  }

  function runLoop(now) {
    if (!running || !vm) return;
    const mode = dom.speedSelect.value;
    const interval = mode === 'slow' ? 100 : 16;
    if (now - lastTick >= interval) {
      lastTick = now;
      selectedLine = null;
      const budget = mode === 'burst' ? 5000 : 1;
      const res = vm.runSlice(budget);
      lastEvent = res.event ?? null;
      if (res.halted) stopRun();
      render();
    }
    if (running) rafId = requestAnimationFrame(runLoop);
  }

  dom.demoSelect.addEventListener('change', () => loadDemo(dom.demoSelect.value));
  dom.compileBtn.addEventListener('click', buildProgram);
  dom.targetMode.addEventListener('change', buildProgram);
  dom.memSize.addEventListener('change', buildProgram);
  dom.protectRodata.addEventListener('change', buildProgram);
  dom.compileScrubber.addEventListener('input', () => renderCode(vm.getState()));

  dom.stepBtn.addEventListener('click', () => { stopRun(); stepOnce(); });
  dom.stepBackBtn.addEventListener('click', () => {
    stopRun();
    lastEvent = null;
    vm.stepBack();
    render();
  });
  dom.resetBtn.addEventListener('click', () => {
    stopRun();
    lastEvent = null;
    vm.reset();
    render();
  });
  dom.runBtn.addEventListener('click', () => {
    if (running) { stopRun(); return; }
    if (vm.getState().halted) vm.reset();
    running = true;
    dom.runBtn.textContent = 'Pause';
    lastTick = 0;
    rafId = requestAnimationFrame(runLoop);
  });
  dom.timeScrubber.addEventListener('input', () => {
    stopRun();
    lastEvent = null;
    vm.seek(Number(dom.timeScrubber.value));
    render();
  });

  loadDemo('factorial');
}

if (typeof document !== 'undefined' && document.getElementById('demoSelect')) {
  mountVisualizer();
}
