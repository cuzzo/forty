# Puck on forty: the Call Stack in Core Memory

[Puck](https://github.com/cuzzo/clear/tree/master/examples/puck) is a small teaching
language from the CLEAR repository, built up in eleven versions. This directory runs
[Puck v4](https://github.com/cuzzo/clear/tree/master/examples/puck/v4)'s language on forty's
v6 machine, using all five of its registers, so the page can show what forty's FORTRAN never
needed: a call stack, laid out in core memory, one frame per call.

forty's FORTRAN gives every variable one fixed cell, so a SUB can't call itself: a second
call would overwrite the first one's variables. Puck procedures recurse. Each call gets a
fresh frame, and the frames pile up in memory.

---

## What is Puck's, and what is new

| Part | Here |
| --- | --- |
| Tokenizer, parser | Puck v4's, ported from Ruby to JavaScript, with each token's line kept for the page |
| Language | Puck v4's: `PROCEDURE`, `RETURN`, `IF`, `LOOP`, `EXIT`, `:=`, `+ - * / % =`, `SYSCALL(1, x)` |
| Code generator | new: it emits forty v6's one-address 704 code, not Puck's stack-machine bytecode |
| VM | forty v6's, unchanged ([vm.js](vm.js) only re-exports it) |
| Page | the shared visualizer, with the `stack` and `accumulator` features |

One change to Puck v4: a procedure is registered before its body is compiled. Puck v4
registers it after, so a procedure calling itself fails with `key not found` (as it does
in v5-v7). Recursion first works in v8.

---

## The registers

| Register | Holds |
| --- | --- |
| AC | the value being worked out, and a procedure's result |
| MQ | a product or quotient (`LDQ`, `MPY` or `DVP`, `STQ`) |
| C | the address of the running procedure's frame |
| B | the address a call returns to, left there by `TSX` |
| A | nothing: Puck v4 has no counted loops for it to step through |

## A frame

Index register C holds the address of the running procedure's frame:

```text
[ret, link, parameters and locals by name, temporaries]
```

`ret` is the call's own address, and `link` is the caller's frame. Slot `k` of the frame is the
operand `k,C`, the cell at k + C. So reading a local costs no extra instruction: `CLA 2,C` loads
`n` into the AC.

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
00: LXD 34,C        C = the stack base (cell 34 holds 38)
01: TRA 25          over factorial's body
02: SXD 0,C,B       factorial: ret = B, the call's address that TSX left there
03: CLA 2,C         AC = n
04: SUB 35          AC = n - 0
05: TNZ 9           not 0: n is not 0
06: CLA 36          AC = 1, the result
07: LXD 0,C,B       B = ret
08: TRA 1,B         return to the instruction after the call
09: CLA 2,C         AC = n
10: SUB 36          AC = n - 1
11: STO 5,C         the callee's n, straight into its frame
12: SXD 4,C,C       the callee's link = C
13: TXI 14,C,3      C += 3: the callee's frame starts at slot 3
14: TSX 2,B         B = 14, call factorial
15: LXD 1,C,C       C = link: back to this frame
16: STO 3,C         the result is in the AC: store it, to free the AC
17: LDQ 2,C         MQ = n
18: MPY 3,C         MQ = n * factorial(n - 1)
19: STQ 4,C
20: CLA 4,C         AC = the product, the result
21: LXD 0,C,B
22: TRA 1,B
...
```

The callee's frame starts at the caller's first free slot, so each level of `factorial` adds 3
words: `ret`, `link` and `n`. Its arguments are worked out straight into it.

## The AC does not survive a call

The AC holds one value, and a call uses it for everything, including its result. So before any
call, the code generator stores whatever the AC holds into a temporary in the frame: it
*spills* it. In `fib(n - 1) + fib(n - 2)`, the first call's result arrives in the AC and is
stored at once (`STO 3,C`), before the second call's argument is worked out. This is the
caller-saved register every real compiler handles.

Every temporary lives in the frame. If one had a fixed cell, as forty's FORTRAN temporaries do,
the second call would overwrite the first one's result.

## In the page

Cells in a live frame are pink, named `procedure.slot` (`factorial.n`), with each frame's
`ret` cell marked by a thick edge. The page finds the frames by following the links down from C,
so every frame is named, not only the newest. The registers panel shows the AC, the MQ, and
`C = frame (56)`, and the effect line names slots: `index register B (14) -> factorial.ret [via C]`.

## Limits

All 256 words hold code, data and the stack together. `fib(10)` needs 11 frames, and its
deepest starts at cell 82. A deep enough recursion, `fib(80)`, runs the stack past the end of
memory and stops with `Memory address out of bounds`: a stack overflow.

Against the same program on v5's three-address code, the registers cut the cycles: `fib(10)`
from 9,332 to 6,350, `factorial(5)` from 358 to 306. The code is longer, as one-address code is:
46 instructions for `fib.puck` instead of 33.

---

## Where it differs from Puck v4's Ruby VM

- A comparison gives 1 or 0, where Ruby gives `true` or `false`.
- `IF x THEN` takes 0 as false. In Ruby only `false` is, so `IF 0 THEN` runs its body there.
- Division truncates toward zero, as forty's does; Ruby rounds down. `(0 - 7) / 2` is -3 here and -4 in Puck.
- `SYSCALL(1, x)` prints the value, without Puck's `OUTPUT: ` prefix.

## Where it differs from the 704

`SXD` and `LXD` save and restore B and C in the frame through an indexed address (`SXD 0,C,B`).
forty's v6 machine allows that; the 704 did not, since an index instruction's tag picks the
register it loads or stores, so its address could not also be indexed. Doing it the 704's way
would mean returning results through memory, at about three more instructions a call.

## Running it

```sh
python3 -m http.server 8000     # from the repository's root
open http://localhost:8000/puck/
npm test
```

The demos: `fib.puck`, `factorial.puck`, `calls.puck` (calls inside arguments, run left to
right) and `fizzbuzz.puck` (Puck v4's own example). The tests check that each prints what
Puck v4's Ruby VM prints, with the one change above.
