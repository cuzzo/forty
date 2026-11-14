// The IBM 704's timings, shared by every version that counts time. Page numbers are the 704 Manual of Operation's.

// One cycle is one core memory cycle, 12 µs (p6). Each 4-tuple costs the cycles of the 704 instructions it stands for:
// 2 for CLA, ADD, STO, LXD, TXI and the like, 20 for MPY and DVP (p17-26). MOV is CLA and STO; + is CLA, ADD and STO.
export const COST = {
  HALT: 2, MOV: 4, LOAD_IND: 6, STORE_IND: 6, PRINT: 2, JMP: 2, JAL: 4, JMP_IND: 4, JZ: 4,
  DRUM_READ: 2, TAPE_READ: 2, REWIND: 2, LXD: 2, PXD: 4, TXH: 2, TXI: 2, CARD: 4, PUNCH: 2,
  '+': 6, '-': 6, '*': 24, '/': 24, '%': 24, '==': 8, '!=': 8, '<': 8, '>': 8, '<=': 8, '>=': 8,
};
// The 704's own instructions (v6): every one takes 2 cycles but these.
export const COST_704 = { MPY: 20, DVP: 20 };

// The IBM 733 drum: a word every 96 µs, a turn every 24 ms (p37-38); here 32 sectors of 8 words, 2,048 cycles a turn.
export const SECTORS = 32;
export const SECTOR_WORDS = 8;
export const DRUM_WORD_CYCLES = 8;
const TURN = SECTORS * SECTOR_WORDS * DRUM_WORD_CYCLES;

// The IBM 727 tape: 2,500 words a second (p30), so 400 µs a word; a 3/4-inch gap between records (p31), 10 ms at
// 75 inches a second; rewinds of under 450 feet at that same 75 inches a second (p30). Tape positions count cycles
// of tape moving at that speed.
export const RECORDS = 64;
export const RECORD_WORDS = 8;
export const TAPE_WORD_CYCLES = 33;
export const GAP = 833;
export const REWIND_SPEED = 1;
export const RECORD_SPAN = GAP + RECORD_WORDS * TAPE_WORD_CYCLES;

// The IBM 721 card punch: 100 cards a minute (p40), 600 ms a card, 12 rows of ~4,167 cycles.
export const CARD_ROWS = 12;
export const ROW_CYCLES = 4167;

// The drum turns one word past the head every DRUM_WORD_CYCLES cycles.
export const headAt = (cycles) => {
  const word = Math.floor(cycles / DRUM_WORD_CYCLES) % (SECTORS * SECTOR_WORDS);
  return { sector: Math.floor(word / SECTOR_WORDS), word: word % SECTOR_WORDS };
};

// Cycles left before a read's next word can be copied (a drum word as it starts under the head, a tape word once it
// has passed it), before a tape read is past the rest of its record, before the card punch finishes its next row, or
// before a rewind finishes; 0 when that happens now.
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
