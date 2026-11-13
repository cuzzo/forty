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

const OPS = ['HALT', 'MOV', 'LOAD_IND', 'STORE_IND', 'PRINT', 'JMP', 'JAL', 'JMP_IND', 'JZ', 'DRUM_READ', 'TAPE_READ', 'REWIND',
  'LXD', 'PXD', 'TXH', 'TXI', 'CARD', 'PUNCH', ...Object.keys(ALU)];

// One cycle is one IBM 704 core memory cycle, 12 µs (704 Manual of Operation, p6). Each instruction costs the cycles
// its 704 instructions take: 2 for CLA, ADD, STO, LXD, TXI and the like, 20 for MPY and DVP (p17-26).
export const COST = {
  HALT: 2, MOV: 4, LOAD_IND: 6, STORE_IND: 6, PRINT: 2, JMP: 2, JAL: 4, JMP_IND: 4, JZ: 4,
  DRUM_READ: 2, TAPE_READ: 2, REWIND: 2, LXD: 2, PXD: 4, TXH: 2, TXI: 2, CARD: 4, PUNCH: 2,
  '+': 6, '-': 6, '*': 24, '/': 24, '%': 24, '==': 8, '!=': 8, '<': 8, '>': 8, '<=': 8, '>=': 8,
};

// The IBM 733 drum: a word every 96 µs, a turn every 24 ms (p37-38); here 32 sectors of 8 words, 2,048 cycles a turn.
export const SECTORS = 32;
export const SECTOR_WORDS = 8;
export const DRUM_WORD_CYCLES = 8;
const TURN = SECTORS * SECTOR_WORDS * DRUM_WORD_CYCLES;
// The IBM 721 card punch: 100 cards a minute (p40), 600 ms a card, 12 rows of ~4,167 cycles.
export const CARD_ROWS = 12;
export const ROW_CYCLES = 4167;
export const RECORDS = 64;
export const RECORD_WORDS = 8;
// The IBM 727 tape: 2,500 words a second (p30), so 400 µs a word; a 3/4-inch gap between records (p31), 10 ms at
// 75 inches a second; rewinds of under 450 feet at that same 75 inches a second (p30). Tape positions count cycles
// of tape moving at that speed.
export const TAPE_WORD_CYCLES = 33;
export const GAP = 833;
export const REWIND_SPEED = 1;
export const RECORD_SPAN = GAP + RECORD_WORDS * TAPE_WORD_CYCLES;

// An operand is a 2-bit index-register tag (0 for none, 1-3 for A-C) and a 7-bit address.
export const tagOf = (operand) => operand >> 7;

export const headAt = (cycles) => {
  const word = Math.floor(cycles / DRUM_WORD_CYCLES) % (SECTORS * SECTOR_WORDS);
  return { sector: Math.floor(word / SECTOR_WORDS), word: word % SECTOR_WORDS };
};

// Cycles left before a read's next word can be copied (a drum word as it starts under the head, a tape word once it
// has passed it), before the card punch finishes its next row, or before a rewind finishes; 0 when that happens now.
export const ioWait = ({ io, cycles, tapePos }) => {
  if (!io) return 0;
  if (io.kind === 'punch') return io.start + (io.done + 1) * ROW_CYCLES - 1 - cycles;
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

// record = false runs without the history Back needs, for measuring a program to the end.
export function createVM(initMem, drum = [], tape = [], record = true) {
  const MEM = new Int32Array(initMem);
  const XR = new Int32Array(3);
  const DRUM = new Int32Array(SECTORS * SECTOR_WORDS);
  const TAPE = new Int32Array(RECORDS * RECORD_WORDS);
  DRUM.set(drum);
  TAPE.set(tape);
  const stdout = [];
  const cards = [];
  const history = [];
  let pending = [];
  let pc = null;
  let ip = 0;
  let halted = false;
  let cycles = 0;
  let waited = 0;
  let tapePos = 0;
  let io = null;

  const view = (reads = [], writes = []) => ({ pc, ip, halted, MEM, XR, stdout, cards, pending, reads, writes, cycles, waited, tapePos, io, DRUM, TAPE });

  const at = (i) => {
    if (i < 0 || i >= MEM.length) throw new RangeError(`Memory address out of bounds: ${i}`);
    return i;
  };
  // The cell an operand names: its address, plus the index register its tag picks. (The 704 subtracted.)
  const m = (operand) => at((operand & 127) + (tagOf(operand) ? XR[tagOf(operand) - 1] : 0));

  function finish() {
    io = null;
    ip = pc + 1;
  }

  // One cycle of a drum read, tape read, rewind or card punch in progress, all of it spent waiting on the device.
  function ioCycle() {
    const wait = ioWait({ io, cycles, tapePos });
    cycles++;
    waited++;
    if (io.kind === 'punch') {
      if (wait) return view();
      io = { ...io, done: io.done + 1 };
      if (io.done === CARD_ROWS) {
        cards.push(io.values);
        finish();
      }
      return view();
    }
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

  function exec() {
    if (halted) return view();
    if (record) history.push({ pc, ip, mem: MEM.slice(), xr: XR.slice(), stdoutLen: stdout.length, cardsLen: cards.length, pending, cycles, waited, tapePos, io });
    if (io) return ioCycle();
    pc = ip;
    const [op, a, b, c] = decode(MEM[ip++]);
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
    } else if (op === 'TXH') {
      reads.push(m(b));
      if (XR[c] > MEM[m(b)]) ip = a;
    } else if (op === 'TXI') {
      XR[c] += b;
      ip = a;
    } else if (op === 'CARD') {
      reads.push(m(a));
      pending = [...pending, MEM[m(a)]];
    } else if (op === 'PUNCH') {
      io = { kind: 'punch', values: pending, done: 0, start: cycles };
      pending = [];
      ip = pc;
    } else if (op === 'DRUM_READ') {
      reads.push(m(b));
      if (MEM[m(b)] < 0 || MEM[m(b)] >= SECTORS) throw new Error(`No drum sector ${MEM[m(b)]}`);
      io = { kind: 'drum', sector: MEM[m(b)], addr: MEM[m(a)], done: 0, count: c };
      ip = pc;
    } else if (op === 'TAPE_READ') {
      if (c > RECORD_WORDS) throw new Error(`Read-Write Check: a list of ${c} words is longer than the ${RECORD_WORDS}-word record`);
      if (tapePos >= RECORDS * RECORD_SPAN) throw new Error('End of tape');
      io = { kind: 'tape', addr: MEM[m(a)], done: 0, count: c };
      ip = pc;
    } else if (op === 'REWIND') {
      if (tapePos) {
        io = { kind: 'rewind' };
        ip = pc;
      }
    } else if (op in ALU) {
      reads.push(m(b), m(c));
      if ((op === '/' || op === '%') && MEM[m(c)] === 0) throw new Error('Division by zero');
      writes.push(m(a));
      MEM[m(a)] = ALU[op](MEM[m(b)], MEM[m(c)]);
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
    ({ pc, ip, cycles, waited, tapePos, io, pending } = snap);
    MEM.set(snap.mem);
    XR.set(snap.xr);
    stdout.length = snap.stdoutLen;
    cards.length = snap.cardsLen;
    halted = false;
    return true;
  }

  function reset() {
    MEM.set(initMem);
    XR.fill(0);
    stdout.length = 0;
    cards.length = 0;
    history.length = 0;
    pending = [];
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
