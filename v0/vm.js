export const ALU = {
  '+':  (x, y) => (x + y) | 0,
  '-':  (x, y) => (x - y) | 0,
  '*':  (x, y) => Math.imul(x, y),
  '/':  (x, y) => (x === -2147483648 && y === -1) ? -2147483648 : ((x / y) | 0),
  '==': (x, y) => +(x === y),
  '!=': (x, y) => +(x !== y),
  '<':  (x, y) => +(x < y),
  '>':  (x, y) => +(x > y),
  '<=': (x, y) => +(x <= y),
  '>=': (x, y) => +(x >= y),
};

export function createVM(code, initMem) {
  const MEM = new Int32Array(initMem);
  const stdout = [];
  const history = [];
  let pc = null;
  let ip = 0;
  let halted = code.length === 0;

  function step() {
    if (halted || ip >= code.length) {
      halted = true;
      return { pc, ip, halted, MEM, stdout, reads: [], writes: [] };
    }
    history.push({ pc, ip, mem: MEM.slice(), stdoutLen: stdout.length });
    pc = ip;
    const [op, a, b, c] = code[ip++];
    const reads = [];
    const writes = [];

    if (op === 'MOV') {
      reads.push(b); writes.push(a);
      MEM[a] = MEM[b];
    } else if (op === 'LOAD_IND') {
      reads.push(b, MEM[b]); writes.push(a);
      MEM[a] = MEM[MEM[b]];
    } else if (op === 'STORE_IND') {
      reads.push(a, b); writes.push(MEM[a]);
      MEM[MEM[a]] = MEM[b];
    } else if (op === 'PRINT') {
      reads.push(a);
      stdout.push(MEM[a]);
    } else if (op === 'JMP') {
      ip = a;
    } else if (op === 'JAL') {
      writes.push(a);
      MEM[a] = ip;
      ip = b;
    } else if (op === 'JMP_IND') {
      reads.push(a);
      ip = MEM[a];
    } else if (op === 'JZ') {
      reads.push(b);
      if (MEM[b] === 0) ip = a;
    } else if (op in ALU) {
      reads.push(b, c); writes.push(a);
      MEM[a] = ALU[op](MEM[b], MEM[c]);
    } else {
      throw new Error(`Unknown opcode: ${op}`);
    }

    if (ip >= code.length) halted = true;
    return { pc, ip, halted, MEM, stdout, reads, writes };
  }

  function stepBack() {
    const snap = history.pop();
    if (!snap) return false;
    pc = snap.pc;
    ip = snap.ip;
    MEM.set(snap.mem);
    stdout.length = snap.stdoutLen;
    halted = false;
    return true;
  }

  function reset() {
    MEM.set(initMem);
    stdout.length = 0;
    history.length = 0;
    pc = null;
    ip = 0;
    halted = code.length === 0;
  }

  return {
    step,
    stepBack,
    reset,
    getState: () => ({ pc, ip, halted, MEM, stdout, steps: history.length }),
  };
}
