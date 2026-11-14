import test from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_LINES, cacheable, cached, lineOf } from './cache.js';
import { DRUM_WORD_CYCLES, SECTORS, SECTOR_WORDS } from './machine.js';
import * as v1 from './v1/visualizer.js';
import { createVM as createV1 } from './v1/vm.js';
import * as v6 from './v6/visualizer.js';
import { createVM as createV6 } from './v6/vm.js';
import * as lisp from './lisp/visualizer.js';
import { createVM as createLisp } from './lisp/vm.js';

const TURN = SECTORS * SECTOR_WORDS * DRUM_WORD_CYCLES;

function runToEnd(machine) {
  while (!machine.getState().halted) machine.step();
  return machine.getState();
}

test('cache mode changes only time: same output, same memory, more cycles, a miss per line first touched', () => {
  const prog = v6.layout(v6.DEMOS.factorial.code);
  const plain = runToEnd(createV6(prog.initMem));
  const withCache = runToEnd(cached(createV6(prog.initMem), true));
  assert.deepEqual([withCache.stdout, Array.from(withCache.MEM)], [plain.stdout, Array.from(plain.MEM)]);
  assert.equal(withCache.cycles, plain.cycles + withCache.cache.stalled);
  assert.ok(withCache.cache.misses > 0 && withCache.cache.hits > withCache.cache.misses);
  assert.ok(withCache.cache.lines.length <= CACHE_LINES);
  // A miss waits at most one drum turn, plus the line's copy; a written line waits again when it leaves.
  assert.ok(withCache.cache.stalled <= withCache.cache.misses * 2 * (TURN + SECTOR_WORDS * DRUM_WORD_CYCLES));
});

test('cache mode keeps the most recently used lines, writes back the ones written, and undoes with the machine', () => {
  const prog = v1.layout(v1.DEMOS.saxpy.code);
  const machine = cached(createV1(prog.initMem), true);
  machine.step();
  const first = machine.getState().cache;
  // The first instruction's fetch brings in line 0, where the code starts.
  assert.ok(first.misses >= 1 && first.fetched.includes(0), JSON.stringify(first));
  while (machine.getState().cache.misses <= CACHE_LINES) machine.step();
  const full = machine.getState().cache;
  assert.equal(full.lines.length, CACHE_LINES);
  assert.ok(full.lines.some(({ dirty }) => dirty));
  const before = JSON.stringify(full);
  machine.step();
  machine.stepBack();
  assert.equal(JSON.stringify(machine.getState().cache), before);
  machine.reset();
  assert.deepEqual([machine.getState().cache.misses, machine.getState().cache.lines], [0, []]);
  assert.equal(runToEnd(machine).stdout.join(' '), runToEnd(createV1(prog.initMem)).stdout.join(' '));
});

test('cache mode puts Lisp\'s 768 words on several drum tracks, and is off for drum programs', () => {
  const prog = lisp.layout(lisp.DEMOS.closures.code);
  const state = runToEnd(cached(createLisp(prog.code, prog.initMem), false));
  assert.deepEqual(lisp.printedLines(prog, state.stdout), ['ADDER', 'ADD3', '7', '15']);
  assert.ok(state.cache.lines.some(({ line }) => line * SECTOR_WORDS >= SECTORS * SECTOR_WORDS));
  assert.equal(lineOf(767), 95);
  assert.equal(cacheable(prog), true);
  assert.equal(cacheable(v6.layout(v6.DEMOS.drumSeq.code)), false);
  // A machine stepped past its end, or one that faults, leaves the cache as it was.
  const machine = cached(createV1(v1.layout('X = 0\nY = 5 / X').initMem), true);
  machine.step();
  const kept = JSON.stringify(machine.getState().cache);
  assert.throws(() => machine.step(), /Division by zero/);
  assert.equal(JSON.stringify(machine.getState().cache), kept);
});
