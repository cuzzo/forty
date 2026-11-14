import { DRUM_WORD_CYCLES, SECTORS, SECTOR_WORDS, ioWait } from './machine.js';

// Cache mode: the drum is main memory, and core memory a cache of a few lines, each a drum sector of 8 words. A word in
// no cached line waits for its sector to come under the drum's head, and then the line is copied in; a line that was
// written is copied back to the drum when it leaves. The drum has as many 256-word tracks as memory needs, each with
// its own head, as the 704's 2,048-word drums did, so any sector arrives within one turn. Only time changes: the
// program, its memory and its output are the same as without the cache.
export const CACHE_LINES = 4;

export const lineOf = (addr) => Math.floor(addr / SECTOR_WORDS);

// A program that reads the drum itself cannot also have the drum as its memory.
export const cacheable = (prog) => !prog.code.some(([op]) => op === 'DRUM_READ');

// Cycles from time t until a line's sector is under the head, plus the cycles to copy its 8 words.
function transfer(line, t) {
  const wait = ioWait({ io: { kind: 'drum', sector: line % SECTORS, done: 0 }, cycles: t });
  return wait + SECTOR_WORDS * DRUM_WORD_CYCLES;
}

// A VM run in cache mode, with the VM's own interface. codeInMemory: whether instruction fetches go through the cache
// too, as they do from v1 on; v0 and Lisp keep their code apart from memory.
export function cached(machine, codeInMemory) {
  // The cached lines, least recently used first.
  let lines = [];
  let stalled = 0;
  let hits = 0;
  let misses = 0;
  // The lines the last step copied in.
  let fetched = [];
  const history = [];

  // A machine without a clock (v0, v1) counts 2 cycles an instruction, as the 704's simplest did.
  const now = (s) => (s.cycles ?? 2 * s.steps) + stalled;

  function access(addr, write, time) {
    const line = lineOf(addr);
    const at = lines.findIndex((entry) => entry.line === line);
    if (at >= 0) {
      hits++;
      const [entry] = lines.splice(at, 1);
      lines.push({ line, dirty: entry.dirty || write });
      return 0;
    }
    misses++;
    let wait = 0;
    if (lines.length === CACHE_LINES) {
      const [leaving] = lines.splice(0, 1);
      if (leaving.dirty) wait += transfer(leaving.line, time);
    }
    wait += transfer(line, time + wait);
    lines.push({ line, dirty: write });
    fetched.push(line);
    return wait;
  }

  return {
    step() {
      const before = machine.getState();
      const snapshot = { lines: lines.map((entry) => ({ ...entry })), stalled, hits, misses, fetched };
      const view = machine.step();
      if (before.halted) return view;
      history.push(snapshot);
      fetched = [];
      // A step spent waiting on a device fetches no instruction.
      const fetch = codeInMemory && !before.io ? [[view.pc, false]] : [];
      const reads = view.reads.map((addr) => [addr, false]);
      const writes = view.writes.map((addr) => [addr, true]);
      for (const [addr, write] of [...fetch, ...reads, ...writes]) stalled += access(addr, write, now(before));
      return view;
    },
    stepBack() {
      if (!machine.stepBack()) return false;
      ({ lines, stalled, hits, misses, fetched } = history.pop());
      return true;
    },
    reset() {
      machine.reset();
      lines = [];
      stalled = 0;
      hits = 0;
      misses = 0;
      fetched = [];
      history.length = 0;
    },
    getState() {
      const s = machine.getState();
      const clock = 'cycles' in s ? { cycles: s.cycles + stalled, waited: s.waited + stalled } : {};
      return { ...s, ...clock, cache: { lines: lines.map((entry) => ({ ...entry })), stalled, hits, misses, fetched, time: now(s) } };
    },
  };
}
