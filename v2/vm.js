export const ALU = {
  '+':  (x, y) => (x + y) | 0,
  '-':  (x, y) => (x - y) | 0,
  '*':  (x, y) => Math.imul(x, y),
  '/':  (x, y) => (x === -2147483648 && y === -1) ? -2147483648 : ((x / y) | 0),
  '%':  (x, y) => (x % y) | 0,
  '==': (x, y) => +(x === y),
  '!=': (x, y) => +(x !== y),
  '<':  (x, y) => +(x < y),
  '>':  (x, y) => +(x > y),
  '<=': (x, y) => +(x <= y),
  '>=': (x, y) => +(x >= y),
};

const OPS = ['HALT', 'MOV', 'LOAD_IND', 'STORE_IND', 'PRINT', 'JMP', 'JAL', 'JMP_IND', 'JZ', 'DRUM_READ', ...Object.keys(ALU)];

export const SECTORS = 16;
export const SECTOR_WORDS = 8;

// The drum turns one word past the head per cycle.
export const headAt = (cycles) => {
  const word = cycles % (SECTORS * SECTOR_WORDS);
  return { sector: Math.floor(word / SECTOR_WORDS), word: word % SECTOR_WORDS };
};

// One instruction per 32-bit word: 5-bit opcode, then three 9-bit operands.
export const encode = ([op, a, b, c]) => (OPS.indexOf(op) << 27) | (a << 18) | (b << 9) | c;
export const decode = (word) => [OPS[word >>> 27] ?? `?${word >>> 27}`, (word >>> 18) & 511, (word >>> 9) & 511, word & 511];

export function createVM(initMem, drum = []) {
  const MEM = new Int32Array(initMem);
  const DRUM = new Int32Array(SECTORS * SECTOR_WORDS);
  DRUM.set(drum);
  const stdout = [];
  const history = [];
  let pc = null;
  let ip = 0;
  let halted = false;
  let cycles = 0;
  let waited = 0;
  let io = null;

  const view = (reads = [], writes = []) => ({ pc, ip, halted, MEM, stdout, reads, writes, cycles, waited, io, DRUM });

  // One cycle of a DRUM_READ in progress: wait for the next word to reach the head, or copy it.
  function drumCycle() {
    const head = headAt(cycles++);
    if (head.sector !== io.sector || head.word !== io.done) {
      waited++;
      return view();
    }
    const addr = io.addr + io.done;
    MEM[addr] = DRUM[io.sector * SECTOR_WORDS + io.done];
    io = io.done + 1 === SECTOR_WORDS ? null : { ...io, done: io.done + 1 };
    if (!io) ip = pc + 1;
    return view([], [addr]);
  }

  function step() {
    if (halted) return view();
    history.push({ pc, ip, mem: MEM.slice(), stdoutLen: stdout.length, cycles, waited, io });
    if (io) return drumCycle();
    pc = ip;
    cycles++;
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
    } else if (op === 'DRUM_READ') {
      reads.push(b);
      if (MEM[b] < 0 || MEM[b] >= SECTORS) throw new Error(`No drum sector ${MEM[b]}`);
      io = { sector: MEM[b], addr: a, done: 0 };
      ip = pc;
    } else if (op in ALU) {
      reads.push(b, c); writes.push(a);
      MEM[a] = ALU[op](MEM[b], MEM[c]);
    } else {
      throw new Error(`Unknown opcode: ${op}`);
    }

    if (ip >= MEM.length) halted = true;
    return view(reads, writes);
  }

  function stepBack() {
    const snap = history.pop();
    if (!snap) return false;
    ({ pc, ip, cycles, waited, io } = snap);
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
    cycles = 0;
    waited = 0;
    io = null;
  }

  return {
    step,
    stepBack,
    reset,
    getState: () => ({ ...view(), steps: history.length }),
  };
}
