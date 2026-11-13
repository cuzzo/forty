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

const OPS = ['HALT', 'MOV', 'LOAD_IND', 'STORE_IND', 'PRINT', 'JMP', 'JAL', 'JMP_IND', 'JZ', 'DRUM_READ', 'TAPE_READ', 'REWIND', ...Object.keys(ALU)];

// One cycle is one IBM 704 instruction (24 µs). The IBM 733 drum moved a word past its head every 100 µs (about 4
// instructions) and turned once every ~24 ms (about 1,000): here 32 sectors of 8 words, 1,024 cycles a turn.
export const SECTORS = 32;
export const SECTOR_WORDS = 8;
export const DRUM_WORD_CYCLES = 4;
const TURN = SECTORS * SECTOR_WORDS * DRUM_WORD_CYCLES;
export const RECORDS = 64;
export const RECORD_WORDS = 8;
// The IBM 727 tape read 15,000 characters a second, so a 36-bit word (6 characters) took 400 µs, about 16
// instructions, and the 3/4-inch gap between records about 10 ms, about 400. Rewinding is faster than reading;
// 5 times faster is an estimate. Tape positions count cycles of tape moving at reading speed.
export const TAPE_WORD_CYCLES = 16;
export const GAP = 400;
export const REWIND_SPEED = 5;
export const RECORD_SPAN = GAP + RECORD_WORDS * TAPE_WORD_CYCLES;

// The drum turns one word past the head every DRUM_WORD_CYCLES cycles.
export const headAt = (cycles) => {
  const word = Math.floor(cycles / DRUM_WORD_CYCLES) % (SECTORS * SECTOR_WORDS);
  return { sector: Math.floor(word / SECTOR_WORDS), word: word % SECTOR_WORDS };
};

// Cycles left before a read's next word can be copied (a drum word as it starts under the head, a tape word once it
// has passed it), or before a rewind finishes; 0 when a word is copied now.
export const ioWait = ({ io, cycles, tapePos }) => {
  if (!io) return 0;
  if (io.kind === 'rewind') return Math.ceil(tapePos / REWIND_SPEED);
  if (io.kind === 'tape') {
    if (io.done === io.count) return RECORD_SPAN - 1 - (tapePos % RECORD_SPAN);
    const t = (tapePos % RECORD_SPAN) - GAP;
    return TAPE_WORD_CYCLES - 1 - (t < 0 ? t : t % TAPE_WORD_CYCLES);
  }
  return ((io.sector * SECTOR_WORDS + io.done) * DRUM_WORD_CYCLES - (cycles % TURN) + TURN) % TURN;
};

// One instruction per 32-bit word: 5-bit opcode, then three 9-bit operands.
export const encode = ([op, a, b, c]) => (OPS.indexOf(op) << 27) | (a << 18) | (b << 9) | c;
export const decode = (word) => [OPS[word >>> 27] ?? `?${word >>> 27}`, (word >>> 18) & 511, (word >>> 9) & 511, word & 511];

export function createVM(initMem, drum = [], tape = []) {
  const MEM = new Int32Array(initMem);
  const DRUM = new Int32Array(SECTORS * SECTOR_WORDS);
  const TAPE = new Int32Array(RECORDS * RECORD_WORDS);
  DRUM.set(drum);
  TAPE.set(tape);
  const stdout = [];
  const history = [];
  let pc = null;
  let ip = 0;
  let halted = false;
  let cycles = 0;
  let waited = 0;
  let tapePos = 0;
  let io = null;

  const view = (reads = [], writes = []) => ({ pc, ip, halted, MEM, stdout, reads, writes, cycles, waited, tapePos, io, DRUM, TAPE });

  function finish() {
    io = null;
    ip = pc + 1;
  }

  // One cycle of a drum read, tape read, or rewind in progress, all of it spent waiting on the device.
  function ioCycle() {
    const wait = ioWait({ io, cycles, tapePos });
    cycles++;
    waited++;
    if (io.kind === 'rewind') {
      tapePos = Math.max(0, tapePos - REWIND_SPEED);
      if (!tapePos) finish();
      return view();
    }
    const record = Math.floor(tapePos / RECORD_SPAN);
    if (io.kind === 'tape') tapePos++;
    if (wait) return view();
    // A tape list shorter than its record leaves the rest uncopied, but the tape still moves on to the next record.
    const writes = [];
    if (io.done < io.count) {
      const addr = io.addr + io.done;
      MEM[at(addr)] = io.kind === 'tape'
        ? TAPE[record * RECORD_WORDS + io.done]
        : DRUM[(io.sector * SECTOR_WORDS + io.done) % DRUM.length];
      writes.push(addr);
      io = { ...io, done: io.done + 1 };
    }
    if (io.done === io.count && (io.kind === 'drum' || tapePos % RECORD_SPAN === 0)) finish();
    return view([], writes);
  }

  const at = (i) => {
    if (i < 0 || i >= MEM.length) throw new RangeError(`Memory address out of bounds: ${i}`);
    return i;
  };

  function exec() {
    if (halted) return view();
    history.push({ pc, ip, mem: MEM.slice(), stdoutLen: stdout.length, cycles, waited, tapePos, io });
    if (io) return ioCycle();
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
      io = { kind: 'drum', sector: MEM[b], addr: MEM[a], done: 0, count: c };
      ip = pc;
    } else if (op === 'TAPE_READ') {
      if (c > RECORD_WORDS) throw new Error(`Read-Write Check: a list of ${c} words is longer than the ${RECORD_WORDS}-word record`);
      if (tapePos >= RECORDS * RECORD_SPAN) throw new Error('End of tape');
      io = { kind: 'tape', addr: MEM[a], done: 0, count: c };
      ip = pc;
    } else if (op === 'REWIND') {
      if (tapePos) {
        io = { kind: 'rewind' };
        ip = pc;
      }
    } else if (op in ALU) {
      reads.push(at(b), at(c));
      if ((op === '/' || op === '%') && MEM[c] === 0) throw new Error('Division by zero');
      writes.push(at(a));
      MEM[a] = ALU[op](MEM[b], MEM[c]);
    } else {
      throw new Error(`Unknown opcode: ${op}`);
    }

    at(ip);
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
    ({ pc, ip, cycles, waited, tapePos, io } = snap);
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
    tapePos = 0;
    io = null;
  }

  return {
    step,
    stepBack,
    reset,
    getState: () => ({ ...view(), steps: history.length }),
  };
}
