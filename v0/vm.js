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

  const at = (i) => {
    if (i < 0 || i >= MEM.length) throw new RangeError(`Memory address out of bounds: ${i}`);
    return i;
  };

  function exec() {
    if (halted) return { pc, ip, halted, MEM, stdout, reads: [], writes: [] };
    history.push({ pc, ip, mem: MEM.slice(), stdoutLen: stdout.length });
    pc = ip;
    const [op, a, b, c] = code[ip++];
    const reads = [];
    const writes = [];

    if (op === 'MOV') {
      reads.push(at(b)); writes.push(at(a));
      MEM[a] = MEM[b];
    } else if (op === 'LOAD_IND') {
      const t = MEM[at(b)];
      reads.push(b, at(t)); writes.push(at(a));
      MEM[a] = MEM[t];
    } else if (op === 'STORE_IND') {
      const t = MEM[at(a)];
      reads.push(a, at(b)); writes.push(at(t));
      MEM[t] = MEM[b];
    } else if (op === 'PRINT') {
      reads.push(at(a));
      stdout.push(MEM[a]);
    } else if (op === 'JMP') {
      ip = a;
    } else if (op === 'JAL') {
      writes.push(at(a));
      MEM[a] = ip;
      ip = b;
    } else if (op === 'JMP_IND') {
      reads.push(at(a));
      ip = MEM[a];
    } else if (op === 'JZ') {
      reads.push(at(b));
      if (MEM[b] === 0) ip = a;
    } else if (op in ALU) {
      reads.push(at(b), at(c));
      if (op === '/' && MEM[c] === 0) throw new Error('Division by zero');
      writes.push(at(a));
      MEM[a] = ALU[op](MEM[b], MEM[c]);
    } else {
      throw new Error(`Unknown opcode: ${op}`);
    }

    if (ip < 0 || ip > code.length) throw new RangeError(`Instruction pointer out of bounds: ${ip}`);
    if (ip === code.length) halted = true;
    return { pc, ip, halted, MEM, stdout, reads, writes };
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
