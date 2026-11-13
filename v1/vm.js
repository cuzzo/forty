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

const OPS = ['HALT', 'MOV', 'LOAD_IND', 'STORE_IND', 'PRINT', 'JMP', 'JAL', 'JMP_IND', 'JZ', ...Object.keys(ALU)];

// One instruction per 32-bit word: 5-bit opcode, then three 9-bit operands.
export const encode = ([op, a, b, c]) => (OPS.indexOf(op) << 27) | (a << 18) | (b << 9) | c;
export const decode = (word) => [OPS[word >>> 27] ?? `?${word >>> 27}`, (word >>> 18) & 511, (word >>> 9) & 511, word & 511];

export function createVM(initMem) {
  const MEM = new Int32Array(initMem);
  const stdout = [];
  const history = [];
  let pc = null;
  let ip = 0;
  let halted = false;

  function step() {
    if (halted) {
      return { pc, ip, halted, MEM, stdout, reads: [], writes: [] };
    }
    history.push({ pc, ip, mem: MEM.slice(), stdoutLen: stdout.length });
    pc = ip;
    const [op, a, b, c] = decode(MEM[ip++]);
    const reads = [];
    const writes = [];

    if (op === 'HALT') {
      halted = true;
    } else if (op === 'MOV') {
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

    if (ip >= MEM.length) halted = true;
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
    halted = false;
  }

  return {
    step,
    stepBack,
    reset,
    getState: () => ({ pc, ip, halted, MEM, stdout, steps: history.length }),
  };
}
