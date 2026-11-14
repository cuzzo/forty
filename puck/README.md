# Puck on forty: the Call Stack in Core Memory

[Puck](https://github.com/cuzzo/clear/tree/master/examples/puck) is a small teaching
language from the CLEAR repository, built up in eleven versions. This directory runs
[Puck v4](https://github.com/cuzzo/clear/tree/master/examples/puck/v4)'s language on forty's
v5 machine, so the page can show what forty's FORTRAN never needed: a call stack, laid out
in core memory, one frame per call.

forty's FORTRAN gives every variable one fixed cell, so a SUB can't call itself: a second
call would overwrite the first one's variables. Puck procedures recurse. Each call gets a
fresh frame, and the frames pile up in memory.

---

## What is Puck's, and what is new

| Part | Here |
| --- | --- |
| Tokenizer, parser | Puck v4's, ported from Ruby to JavaScript, with each token's line kept for the page |
| Language | Puck v4's: `PROCEDURE`, `RETURN`, `IF`, `LOOP`, `EXIT`, `:=`, `+ - * / % =`, `SYSCALL(1, x)` |
| Code generator | new: it emits forty v5's 4-tuples, not Puck's stack-machine bytecode |
| VM | forty v5's, unchanged ([vm.js](vm.js) only re-exports it) |
| Page | the shared visualizer, with a `stack` feature |

One change to Puck v4: a procedure is registered before its body is compiled. Puck v4
registers it after, so a procedure calling itself fails with `key not found` (as it does
in v5-v7). Recursion first works in v8.

---

## A frame

Index register C holds the address of the running procedure's frame:

```text
[ret, link, parameters and locals by name, temporaries]
```

`ret` is where the call returns to, and `link` is the caller's frame. Slot `k` of the frame is
the operand `k,C`, the cell at k + C, as v5's indexed operands already work. So reading a local
costs no extra instruction.

main's frame sits at the base of the stack, after the program's code and data. Its `ret` and
`link` are 0, and link 0 ends the chain.

## A call

`factorial.puck`:

```pascal
PROCEDURE factorial(n);
  IF n = 0 THEN
    RETURN 1;
  END;
  RETURN n * factorial(n - 1);
END;

r := factorial(5);
SYSCALL(1, r);
```

compiles to:

```text
00: LXD 2 23 0         C = the stack base (cell 23 holds 28)
01: JMP 15             over factorial's body
02: == 3,C 2,C 25      factorial: tmp = n = 0
03: JZ 6 3,C
04: MOV 24 26          RET = 1
05: JMP_IND 0,C        return to ret
06: - 6,C 2,C 26       the callee's n = n - 1, straight into its frame
07: PXD 5,C 2          the callee's link = C
08: TXI 9 4 2          C += 4: the callee's frame starts at slot 4
09: JAL 0,C 2          the callee's ret = 10, call factorial
10: LXD 2 1,C          C = link: back to this frame
11: MOV 3,C 24         tmp = RET
12: * 24 2,C 3,C       RET = n * tmp
13: JMP_IND 0,C
...
```

The callee's frame starts at the caller's first free slot, so each level of `factorial` adds 4
words: `ret`, `link`, `n` and one temporary. Its arguments are worked out straight into it.

Every temporary lives in the frame too. If one had a fixed cell, as forty's FORTRAN temporaries do,
the second call in `fib(n - 1) + fib(n - 2)` would overwrite the first one's result.

## In the page

Cells in a live frame are pink, named `procedure.slot` (`factorial.n`), with each frame's
`ret` cell marked by a thick edge. The page finds the frames by following the links down from C,
so every frame is named, not only the newest. The registers panel shows `C = frame (51)`, and
the effect line names slots: `factorial.link [via C] (47) -> index register C`.

## Limits

All 128 words hold code, data and the stack together. `fib(10)` needs 11 frames, and its
deepest starts at cell 79. `fib(40)` runs out of memory and stops with
`Memory address out of bounds: 128`: a stack overflow.

---

## Where it differs from Puck v4's Ruby VM

- A comparison gives 1 or 0, where Ruby gives `true` or `false`.
- `IF x THEN` takes 0 as false. In Ruby only `false` is, so `IF 0 THEN` runs its body there.
- Division truncates toward zero, as forty's does; Ruby rounds down. `(0 - 7) / 2` is -3 here and -4 in Puck.
- `SYSCALL(1, x)` prints the value, without Puck's `OUTPUT: ` prefix.

## Running it

```sh
python3 -m http.server 8000     # from the repository's root
open http://localhost:8000/puck/
npm test
```

The demos: `fib.puck`, `factorial.puck`, `calls.puck` (calls inside arguments, run left to
right) and `fizzbuzz.puck` (Puck v4's own example). The tests check that each prints what
Puck v4's Ruby VM prints, with the one change above.
