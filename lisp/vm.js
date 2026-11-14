import { COST } from '../machine.js';
import { ALU } from '../v5/vm.js';

export { ALU };

// v5's instructions, with one change: the program is kept apart from data, as v0's is. v5 packs three operands into
// each 32-bit word, which leaves 7 bits for an address; a program held as a list of 4-tuples has no such limit.
export const MEM_WORDS = 768;

// An operand is a 2-bit index-register tag (0 for none, 1-3 for A-C) and a 10-bit address.
export const tagOf = (operand) => operand >> 10;
export const addrOf = (operand) => operand & 1023;
export const tagged = (addr, reg) => addr | ((reg + 1) << 10);

// record = false runs without the history Back needs, for running a program to the end.
export function createVM(code, initMem, record = true) {
  const MEM = new Int32Array(initMem);
  const XR = new Int32Array(3);
  const stdout = [];
  const history = [];
  let pc = null;
  let ip = 0;
  let halted = false;
  let cycles = 0;

  const view = (reads = [], writes = []) => ({ pc, ip, halted, MEM, XR, stdout, reads, writes, cycles, waited: 0 });

  const at = (i) => {
    if (i < 0 || i >= MEM.length) throw new RangeError(`Memory address out of bounds: ${i}`);
    return i;
  };
  // The cell an operand names: its address, plus the index register its tag picks.
  const m = (operand) => at(addrOf(operand) + (tagOf(operand) ? XR[tagOf(operand) - 1] : 0));

  function exec() {
    if (halted) return view();
    if (record) history.push({ pc, ip, mem: MEM.slice(), xr: XR.slice(), stdoutLen: stdout.length, cycles });
    pc = ip;
    const [op, a, b, c] = code[ip++];
    cycles += COST[op] ?? 2;
    const reads = [];
    const writes = [];

    if (op === 'HALT') {
      halted = true;
    } else if (op === 'MOV') {
      reads.push(m(b)); writes.push(m(a));
      MEM[m(a)] = MEM[m(b)];
    } else if (op === 'LOAD_IND') {
      const t = MEM[m(b)];
      reads.push(m(b), at(t)); writes.push(m(a));
      MEM[m(a)] = MEM[t];
    } else if (op === 'STORE_IND') {
      const t = MEM[m(a)];
      reads.push(m(a), m(b)); writes.push(at(t));
      MEM[t] = MEM[m(b)];
    } else if (op === 'PRINT') {
      reads.push(m(a));
      stdout.push(MEM[m(a)]);
    } else if (op === 'JMP') {
      ip = a;
    } else if (op === 'JAL') {
      writes.push(m(a));
      MEM[m(a)] = ip;
      ip = b;
    } else if (op === 'JMP_IND') {
      reads.push(m(a));
      ip = MEM[m(a)];
    } else if (op === 'JZ') {
      reads.push(m(b));
      if (MEM[m(b)] === 0) ip = a;
    } else if (op === 'LXD') {
      reads.push(m(b));
      XR[a] = MEM[m(b)];
    } else if (op === 'PXD') {
      writes.push(m(a));
      MEM[m(a)] = XR[b];
    } else if (op === 'TXI') {
      XR[c] += b;
      ip = a;
    } else if (op in ALU) {
      reads.push(m(b), m(c));
      if ((op === '/' || op === '%') && MEM[m(c)] === 0) throw new Error('Division by zero');
      writes.push(m(a));
      MEM[m(a)] = ALU[op](MEM[m(b)], MEM[m(c)]);
    } else {
      throw new Error(`Unknown opcode: ${op}`);
    }
    if (!halted && ip >= code.length) throw new RangeError(`No instruction at ${ip}`);
    return view(reads, writes);
  }

  // A step that faults leaves the machine as it was.
  function step() {
    try {
      return exec();
    } catch (e) {
      stepBack();
      throw e;
    }
  }

  function stepBack() {
    const snap = history.pop();
    if (!snap) return false;
    ({ pc, ip, cycles } = snap);
    MEM.set(snap.mem);
    XR.set(snap.xr);
    stdout.length = snap.stdoutLen;
    halted = false;
    return true;
  }

  function reset() {
    MEM.set(initMem);
    XR.fill(0);
    stdout.length = 0;
    history.length = 0;
    pc = null;
    ip = 0;
    halted = false;
    cycles = 0;
  }

  return { step, stepBack, reset, getState: () => ({ ...view(), steps: history.length }) };
}
