import * as compiler from './compiler.js';
import * as vm from './vm.js';
import { visualizer } from '../visualizer.js';

export * from '../visualizer.js';

const FACTORIAL = `; The product of 1..n. Each call waits on the stack for the one inside it.
(define fact
  (lambda (n)
    (if (< n 1)
        1
        (* n (fact (- n 1))))))

(fact 5)`;

const LISTS = `; Lists are cons cells: (car . cdr) pairs in memory.
(define append
  (lambda (a b)
    (if (eq a nil)
        b
        (cons (car a) (append (cdr a) b)))))

(define reverse
  (lambda (l done)
    (if (eq l nil)
        done
        (reverse (cdr l) (cons (car l) done)))))

(append '(1 2 3) '(4 5))
(reverse '(a b c d) nil)`;

const CLOSURES = `; adder returns a function that remembers n, after adder itself has returned.
(define adder
  (lambda (n)
    (lambda (x) (+ x n))))

(define add3 (adder 3))
(add3 4)
((adder 10) 5)`;

const GARBAGE = `; Each call binds n in fresh cons cells, so the heap fills and the collector runs.
; The call is in tail position, so the stack does not grow.
(define count
  (lambda (n)
    (if (< n 1)
        'done
        (count (- n 1)))))

(count 40)`;

export const DEMOS = {
  factorial: { name: 'factorial.lisp', code: FACTORIAL },
  lists: { name: 'lists.lisp', code: LISTS },
  closures: { name: 'closures.lisp', code: CLOSURES },
  garbage: { name: 'garbage.lisp', code: GARBAGE },
};

export const { MEM_SIZE, layout, effect, describe, asm, mount } = visualizer({
  compiler,
  vm,
  features: ['stack', 'lisp'],
  demos: DEMOS,
  language: 'LISP',
});
