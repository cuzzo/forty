import * as compiler from './compiler.js';
import * as vm from './vm.js';
import { visualizer } from '../visualizer.js';

export * from '../visualizer.js';
export const { MEM_SIZE, DEMOS, layout, effect, describe, asm, saving, mount } = visualizer({ compiler, vm, memSize: 128, features: ['code', 'drum'] });
