# Lisp on forty: an Interpreter in Core Memory

Lisp was created for the IBM 704, the machine forty imitates: `car` and `cdr` were the 704's
"contents of the address part" and "contents of the decrement part" of a word. This directory
runs a small Lisp on forty's machine, the way LISP 1.5 ran on the 704: an interpreter written in
machine code, reading a program that sits in memory as lists.

It shows four things neither forty's FORTRAN nor [Puck](../puck/README.md) does:

- **Cons cells.** Every list is a chain of two-word cells, `[car, cdr]`, in core memory.
- **Code = data.** The program is a list too, laid out in the same cells; `eval` walks it.
- **Closures.** A function keeps its environment after the call that made it returns.
- **Garbage collection.** When the free cells run out, a mark-and-sweep collector reclaims the
  ones nothing points to.

---

## The Lisp

McCarthy's core, with integers added:

| | |
| --- | --- |
| special forms | `(QUOTE x)` or `'x`, `(IF test then else)`, `(LAMBDA (params) body)`, `(DEFINE name value)` |
| primitives | `CAR`, `CDR`, `CONS`, `ATOM`, `EQ`, `+`, `-`, `*`, `<` |
| values | `NIL`, `T`, symbols, integers, lists, dotted pairs `(a . b)` |

`NIL` is false and everything else is true. Each top-level expression's value is printed.

## The machine

v5's instructions and index registers, with one change: the interpreter's code is kept apart from
data, as v0's is ([vm.js](vm.js)). v5 packs three operands into each 32-bit instruction word,
which leaves room to name only 128 words. A program kept as a list of 4-tuples has no such
limit, so data memory grows to 768 words.

### Values

Every value is one word:

| Value | Stored as |
| --- | --- |
| `NIL` | 0 |
| an integer n | 2n + 1, so every integer is odd |
| a symbol | the address of its cell, `[name, global value]` |
| a cons cell | the address of its cell, `[car, cdr]` |

Symbols come before the cons cells in memory, so one comparison tells a symbol from a list, and
`% 2` tells an integer from either. No bit masks are needed. Cell 0 is NIL's own cell, holding
0 and 0, so `car` and `cdr` of NIL are NIL.

### Memory

| Cells | What |
| --- | --- |
| 0-63 | NIL's cell, named cells (`RET`, `FREE`, `PROGRAM`) and constants |
| 64-191 | symbols, two words each |
| 192-383 | 96 cons cells: the program's, then the free list |
| 384-479 | one mark word per cons cell, for the collector |
| 480-767 | the stack |

## The interpreter

[interpreter.js](interpreter.js) writes the interpreter in forty instructions through a small
assembler ([compiler.js](compiler.js)): 379 instructions in 10 routines. Each routine has a
frame on the stack, `[ret, link, parameters, locals]`, with index register C pointing at it, and
calls use Puck's call sequence. `lookup`, for example:

```js
// A symbol's value: its first binding in the environment, or else its global value.
routine('lookup', ['symbol', 'env'], ['pair', 't'], ($) => {
  label('next');
  ifZero($.env, 'global');
  car($.pair, $.env);
  car($.t, $.pair);
  op('==', $.t, $.t, $.symbol);
  ifZero($.t, 'on');
  cdr(RET, $.pair);
  ret();
  label('on');
  cdr($.env, $.env);
  jmp('next');
  label('global');
  cdr(RET, $.symbol);
  ret();
});
```

`car` is one `LOAD_IND`; `cdr` adds 1 to the address first.

| Routine | Does |
| --- | --- |
| `main` | evaluates each top-level expression and prints its value |
| `eval` | NIL, numbers and symbols; `QUOTE`, `IF`, `LAMBDA`, `DEFINE`; and calls |
| `evlis` | a call's arguments, evaluated into a list |
| `apply` | a primitive |
| `pairlis` | binds a closure's parameters: `(name . value)` pairs in front of its environment |
| `lookup` | a symbol's value |
| `cons` | a cell from the free list, collecting garbage when it is empty |
| `collect`, `mark` | the garbage collector |
| `print` | a value, as symbols and numbers |

A JavaScript loader reads the program text before the machine starts, like loading a deck of
cards. It interns the symbols and lays every expression out as cons cells. (LISP 1.5 read in
machine code.)

### Environments and closures

An environment is a list of `(name . value)` pairs in the heap, not a stack frame.
`(LAMBDA (x) (+ x n))` evaluates to a closure: one cons cell, `(lambda-expression . environment)`.
So in `closures.lisp`, `add3` still finds `n` = 3 long after `adder` has returned.

### Tail calls

`eval` applies a closure itself: it binds the parameters, then evaluates the body in its own frame,
by jumping back to its top. A call in tail position therefore doesn't grow the stack: `(count 300)`
runs in the same stack as `(count 40)`. A call that isn't in tail position does: each level of
`(fact n)` adds about 15 words, so `(fact 10)` fits and `(fact 20)` runs off the end of memory.

### Garbage collection

`cons` takes cells from the free list. When the list is empty, `collect` runs:

1. **Mark.** Starting from every symbol's global value, `RET`, and every word on the stack, set the
   mark word of each cell reachable through car and cdr.
2. **Sweep.** Every unmarked cell goes back on the free list; marks are cleared for next time.

The stack scan is conservative: any word that looks like a cons cell's address is treated as one.
Return addresses and links point into code and the stack, and integers are odd, so at worst some
garbage survives a collection. A live cell is never freed. That includes a value half-way through
an expression: in `(cons (f x) (g y))`, `(f x)`'s result sits in a frame while `(g y)` runs.

If nothing can be freed, the program prints `out of memory` and stops.

---

## In the page

- **Next** runs to the next call of `eval`, so one step is one Lisp evaluation. The effect line
  shows the expression, read back out of memory: `eval (FACT 5)`.
- The source pane highlights the expression being evaluated.
- The bytecode pane is the interpreter: the instruction it stopped on.
- In memory, cons cells (blue) and symbols' values read as Lisp values: `NIL`, `7`, `FACT`, or
  `@200` for the cell at 200. The free list shows as cells with car `NIL` and cdr pointing to the
  next. Mark words sit below the cons cells.
- The stack shows each routine's frame by name: `eval.x`, `eval.env`, `apply.f`.
- The printer shows each top-level value.

## Where it differs from LISP 1.5

- `IF` instead of `COND`, and `DEFINE` for global definitions.
- Integers are small and tagged; there are no floating-point numbers, strings or property lists.
- The reader is JavaScript, not machine code.

## Running it

```sh
python3 -m http.server 8000     # from the repository's root
open http://localhost:8000/lisp/
npm test
```

The demos: `factorial.lisp`, `lists.lisp` (`append` and `reverse`), `closures.lisp` and
`garbage.lisp` (a tail-recursive count that fills the heap until the collector runs). The tests
check every demo, and more, against a reference Lisp written in JavaScript.
