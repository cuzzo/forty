import * as compiler from './compiler.js';
import * as vm from './vm.js';
import { visualizer } from '../visualizer.js';

export * from '../visualizer.js';

const FIB = `PROCEDURE fib(n);
  IF n = 0 THEN
    RETURN 0;
  END;
  IF n = 1 THEN
    RETURN 1;
  END;
  RETURN fib(n - 1) + fib(n - 2);
END;

r := fib(10);
SYSCALL(1, r);`;

const FACTORIAL = `PROCEDURE factorial(n);
  IF n = 0 THEN
    RETURN 1;
  END;
  RETURN n * factorial(n - 1);
END;

r := factorial(5);
SYSCALL(1, r);`;

const CALLS = `PROCEDURE show(x);
  SYSCALL(1, x);
  RETURN x;
END;

PROCEDURE sum(a, b);
  RETURN a + b;
END;

r := sum(show(1), sum(show(2), show(3)));
SYSCALL(1, r);`;

// Puck v4's own example.
const FIZZBUZZ = `PROCEDURE fizzbuzz(limit);
  i := 1;
  LOOP
    IF i % 3 = 0 THEN
      IF i = 42 THEN
        SYSCALL(1, i);
      END;
    END;

    IF i = limit THEN
      EXIT;
    END;

    i := i + 1;
  END;
END;

fizzbuzz(100);`;

// Puck v4 programs: fizzbuzz.puck is v4's own example; the others need only v4's language, plus recursion.
export const DEMOS = {
  fib: { name: 'fib.puck', code: FIB },
  factorial: { name: 'factorial.puck', code: FACTORIAL },
  calls: { name: 'calls.puck', code: CALLS },
  fizzbuzz: { name: 'fizzbuzz.puck', code: FIZZBUZZ },
};

export const { MEM_SIZE, layout, effect, describe, asm, mount } = visualizer({
  compiler,
  vm,
  features: ['code', 'stack'],
  demos: DEMOS,
  language: 'PUCK',
});
