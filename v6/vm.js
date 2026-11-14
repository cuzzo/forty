import { CARD_ROWS, COST_704, RECORDS, RECORD_SPAN, RECORD_WORDS, REWIND_SPEED, SECTORS, SECTOR_WORDS, ioWait } from '../machine.js';

// The machine's timings are shared by every version.
export * from '../machine.js';

const OPS = ['HALT', 'PRINT', 'CARD', 'PUNCH', 'DRUM_READ', 'TAPE_READ', 'REWIND', 'CLA', 'CLS', 'ADD', 'SUB', 'STO', 'LDQ', 'STQ',
  'MPY', 'DVP', 'TRA', 'TZE', 'TNZ', 'TMI', 'TPL', 'TSX', 'LXD', 'SXD', 'PXD', 'PAX', 'TXI', 'TXH'];

// The transfers that test the AC.
export const TESTS = { TZE: (ac) => ac === 0, TNZ: (ac) => ac !== 0, TMI: (ac) => ac < 0, TPL: (ac) => ac >= 0 };

// An operand is a 2-bit index-register tag (0 for none, 1-3 for A-C) and an 8-bit address.
export const tagOf = (operand) => operand >> 8;
export const addrOf = (operand) => operand & 255;
export const tagged = (addr, reg) => addr | ((reg + 1) << 8);

// One address per instruction, as the 704's words had: 5-bit opcode, a 10-bit address and a 10-bit decrement (each
// a tag and 8 bits), and a 7-bit field for an index register or a READ's word count.
export const encode = ([op, a, b, c]) => {
  if (c > 127) throw new RangeError(`${c} does not fit in an instruction's 7-bit count`);
  return (OPS.indexOf(op) << 27) | (a << 17) | (b << 7) | c;
};
export const decode = (word) => [OPS[word >>> 27] ?? `?${word >>> 27}`, (word >>> 17) & 1023, (word >>> 7) & 1023, word & 127];

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
  let AC = 0;
  let MQ = 0;

  const view = (reads = [], writes = []) => ({ pc, ip, halted, MEM, XR, AC, MQ, stdout, cards, pending, reads, writes, cycles, waited, tapePos, io, DRUM, TAPE });

  const at = (i) => {
    if (i < 0 || i >= MEM.length) throw new RangeError(`Memory address out of bounds: ${i}`);
    return i;
  };
  // An operand's address plus the index register its tag picks. (The 704 subtracted.)
  const ea = (operand) => addrOf(operand) + (tagOf(operand) ? XR[tagOf(operand) - 1] : 0);
  const m = (operand) => at(ea(operand));

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
    if (record) history.push({ pc, ip, mem: MEM.slice(), xr: XR.slice(), AC, MQ, stdoutLen: stdout.length, cardsLen: cards.length, pending, cycles, waited, tapePos, io });
    if (io) return ioCycle();
    pc = ip;
    const [op, a, b, c] = decode(MEM[ip++]);
    cycles += COST_704[op] ?? 2;
    const reads = [];
    const writes = [];
    const read = (operand) => { reads.push(m(operand)); return MEM[m(operand)]; };
    const write = (operand, value) => { writes.push(m(operand)); MEM[m(operand)] = value; };

    if (op === 'HALT') halted = true;
    else if (op === 'CLA') AC = read(a);
    else if (op === 'CLS') AC = -read(a) | 0;
    else if (op === 'ADD') AC = (AC + read(a)) | 0;
    else if (op === 'SUB') AC = (AC - read(a)) | 0;
    else if (op === 'STO') write(a, AC);
    else if (op === 'LDQ') MQ = read(a);
    else if (op === 'STQ') write(a, MQ);
    else if (op === 'MPY') {
      // The 704 left a product's high half in the AC; here every product fits in the MQ's one word.
      MQ = Math.imul(MQ, read(a));
      AC = 0;
    } else if (op === 'DVP') {
      const y = read(a);
      if (y === 0) throw new Error('Division by zero');
      AC = MQ % y | 0;
      MQ = MQ === -2147483648 && y === -1 ? MQ : (MQ / y) | 0;
    } else if (op === 'TRA') ip = ea(a);
    else if (op in TESTS) { if (TESTS[op](AC)) ip = a; }
    else if (op === 'TSX') {
      XR[c] = pc;
      ip = a;
    } else if (op === 'LXD') XR[c] = read(a);
    else if (op === 'SXD') write(a, XR[c]);
    else if (op === 'PXD') AC = XR[c];
    else if (op === 'PAX') XR[c] = AC;
    else if (op === 'TXI') {
      XR[c] += b;
      ip = a;
    } else if (op === 'TXH') { if (XR[c] > read(b)) ip = a; }
    else if (op === 'PRINT') stdout.push(read(a));
    else if (op === 'CARD') pending = [...pending, read(a)];
    else if (op === 'PUNCH') {
      io = { kind: 'punch', values: pending, done: 0, start: cycles };
      pending = [];
      ip = pc;
    } else if (op === 'DRUM_READ') {
      const sector = read(b);
      if (sector < 0 || sector >= SECTORS) throw new Error(`No drum sector ${sector}`);
      io = { kind: 'drum', sector, addr: read(a), done: 0, count: c };
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
    ({ pc, ip, cycles, waited, tapePos, io, pending, AC, MQ } = snap);
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
    AC = 0;
    MQ = 0;
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
