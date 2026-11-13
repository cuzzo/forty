import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from './compiler.js';
import { createVM } from './vm.js';
import { DEMOS } from './visualizer.js';

function run(source) {
  const { code, initMem } = compile(source, 64);
  const vm = createVM(code, initMem);
  while (!vm.getState().halted) vm.step();
  return vm;
}

test('v0 runs Demos 1-4 and supports stepBack/reset', () => {
  assert.deepEqual(run(DEMOS.factorial.code).getState().stdout, [120]);
  assert.deepEqual(run(DEMOS.swap.code).getState().stdout, [99, 10, 10]);
  assert.deepEqual(run(DEMOS.saxpy.code).getState().stdout, [40, 43, 46]);
  assert.deepEqual(run(DEMOS.equiv.code).getState().stdout, [11, 22, 33, 44]);

  const vm = run(DEMOS.factorial.code);
  assert.equal(vm.stepBack(), true);
  assert.deepEqual(vm.getState().stdout, []);
  vm.reset();
  assert.equal(vm.getState().ip, 0);
});
