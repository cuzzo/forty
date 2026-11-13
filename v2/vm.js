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

// Cycles until the next word a DRUM_READ needs comes under the head (0 when none is waited for).
export const waitCycles = ({ io, cycles }) => {
  const turn = SECTORS * SECTOR_WORDS;
  return io ? (io.sector * SECTOR_WORDS + io.done - (cycles % turn) + turn) % turn : 0;
};

// One instruction per 32-bit word: 5-bit opcode, then three 9-bit operands.
export function encode([op, a, b, c]) {
  const id = OPS.indexOf(op);
  if (id < 0) throw new Error(`Unknown opcode: ${op}`);
  if ([a, b, c].some((x) => !Number.isInteger(x) || x < 0 || x > 511)) {
    throw new RangeError(`Operand out of 9-bit range (0..511): ${op} ${a} ${b} ${c}`);
  }
  return (id << 27) | (a << 18) | (b << 9) | c;
}
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
    MEM[at(addr)] = DRUM[io.sector * SECTOR_WORDS + io.done];
    io = io.done + 1 === SECTOR_WORDS ? null : { ...io, done: io.done + 1 };
    if (!io) ip = pc + 1;
    return view([], [addr]);
  }

  const at = (i) => {
    if (i < 0 || i >= MEM.length) throw new RangeError(`Memory address out of bounds: ${i}`);
    return i;
  };

  function exec() {
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
    } else if (op === 'DRUM_READ') {
      reads.push(at(b));
      if (MEM[b] < 0 || MEM[b] >= SECTORS) throw new Error(`No drum sector ${MEM[b]}`);
      io = { sector: MEM[b], addr: c ? MEM[at(a)] : a, done: 0 };
      ip = pc;
    } else if (op in ALU) {
      reads.push(at(b), at(c));
      if ((op === '/' || op === '%') && MEM[c] === 0) throw new Error('Division by zero');
      writes.push(at(a));
      MEM[a] = ALU[op](MEM[b], MEM[c]);
    } else {
      throw new Error(`Unknown opcode: ${op}`);
    }

    if (ip < 0 || ip > MEM.length) throw new RangeError(`Instruction pointer out of bounds: ${ip}`);
    if (ip === MEM.length) halted = true;
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
