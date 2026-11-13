import { compile } from './compiler.js';
import { createVM } from './vm.js';

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
  const ramBox = document.getElementById('ram');
  const codeBox = document.getElementById('code');
  const outBox = document.getElementById('out');
  const statusBox = document.getElementById('status');

  for (const [k, d] of Object.entries(DEMOS)) demoSel.append(el('option', { value: k, text: d.name }));

  let prog = null;
  let vm = null;
  let last = { reads: [], writes: [] };
  let timer = null;

  function render() {
    const s = vm.getState();
    const reads = new Set(last.reads);
    const writes = new Set(last.writes);
    statusBox.textContent = `ip: ${s.ip} | steps: ${s.steps}${s.halted ? ' | HALTED' : ''}`;
    outBox.textContent = s.stdout.join('\n');

    ramBox.replaceChildren();
    for (let i = 0; i < prog.usedCells; i++) {
      const cell = prog.cells[i];
      const flash = writes.has(i) ? ' write' : (reads.has(i) ? ' read' : '');
      ramBox.append(el('div', { class: `cell ${cell.role}${flash}` },
        el('small', { text: `[${i}] ${cell.label}` }),
        el('strong', { text: String(s.MEM[i]) }),
      ));
    }

    codeBox.replaceChildren();
    prog.code.forEach((instr, i) => {
      codeBox.append(el('div', {
        class: `line${i === s.ip ? ' active' : ''}`,
        text: `${String(i).padStart(2, '0')}: ${instr.join(' ')}`,
      }));
    });
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function compileAndLoad() {
    stop();
    prog = compile(srcBox.value, 64);
    vm = createVM(prog.code, prog.initMem);
    last = { reads: [], writes: [] };
    render();
  }

  demoSel.addEventListener('change', () => { srcBox.value = DEMOS[demoSel.value].code; compileAndLoad(); });
  document.getElementById('compile').addEventListener('click', compileAndLoad);
  document.getElementById('step').addEventListener('click', () => { stop(); last = vm.step(); render(); });
  document.getElementById('back').addEventListener('click', () => { stop(); vm.stepBack(); last = { reads: [], writes: [] }; render(); });
  document.getElementById('reset').addEventListener('click', () => { stop(); vm.reset(); last = { reads: [], writes: [] }; render(); });
  document.getElementById('run').addEventListener('click', () => {
    if (timer) { stop(); return; }
    if (vm.getState().halted) vm.reset();
    timer = setInterval(() => {
      last = vm.step();
      render();
      if (last.halted) stop();
    }, 60);
  });

  srcBox.value = DEMOS.factorial.code;
  compileAndLoad();
}

if (typeof document !== 'undefined' && document.getElementById('demo')) mount();
