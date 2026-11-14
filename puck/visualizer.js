import * as compiler from './compiler.js';
import * as vm from './vm.js';
import { visualizer } from '../visualizer.js';

export * from '../visualizer.js';

// Puck v4 programs. fizzbuzz.puck is Puck v4's own example; the others need only v4's language, plus recursion.
const DEMOS = {
  fib: { name: 'fib.puck', code: 'PROCEDURE fib(n);\n  IF n = 0 THEN\n    RETURN 0;\n  END;\n  IF n = 1 THEN\n    RETURN 1;\n  END;\n  RETURN fib(n - 1) + fib(n - 2);\nEND;\n\nr := fib(10);\nSYSCALL(1, r);' },
  factorial: { name: 'factorial.puck', code: 'PROCEDURE factorial(n);\n  IF n = 0 THEN\n    RETURN 1;\n  END;\n  RETURN n * factorial(n - 1);\nEND;\n\nr := factorial(5);\nSYSCALL(1, r);' },
  calls: { name: 'calls.puck', code: 'PROCEDURE show(x);\n  SYSCALL(1, x);\n  RETURN x;\nEND;\n\nPROCEDURE sum(a, b);\n  RETURN a + b;\nEND;\n\nr := sum(show(1), sum(show(2), show(3)));\nSYSCALL(1, r);' },
  fizzbuzz: { name: 'fizzbuzz.puck', code: 'PROCEDURE fizzbuzz(limit);\n  i := 1;\n  LOOP\n    IF i % 3 = 0 THEN\n      IF i = 42 THEN\n        SYSCALL(1, i);\n      END;\n    END;\n\n    IF i = limit THEN\n      EXIT;\n    END;\n\n    i := i + 1;\n  END;\nEND;\n\nfizzbuzz(100);' },
};

export const { MEM_SIZE, layout, effect, describe, asm, mount } = visualizer({ compiler, vm, features: ['code', 'stack'], demos: DEMOS, language: 'PUCK' });
export { DEMOS };
