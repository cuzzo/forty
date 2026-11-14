# The v5 Implementation - Index Registers and Punched Cards

v5 starts from v3 and adds two things from the IBM 704:

1. **Index registers.** The 704 had three, A, B and C. FORTRAN I kept each `DO` loop's
   counter in one and used it to index arrays. v5 does the same.
2. **`PUNCH`.** Real FORTRAN sent `PRINT` to the line printer and `PUNCH` to the card punch.
   v5 keeps `PRINT` as before and adds `PUNCH`, which punches cards.

---

## Time

v5 counts 704 cycles as v2 and v3 do ([machine.js](../machine.js)). Its new instructions
cost `LXD`, `TXH` and `TXI` 2 cycles each, and `PXD` 4 (`PXD`, then `STO`). A punched card
takes 50,000 cycles (100 cards a minute).

---

## Index registers

A `DO` loop over a local variable takes a free register, and compiles to

```text
LXD  A, start          # load the counter into index register A
top: TXH exit, stop, A # leave once A > stop
     ... body ...
     TXI top, 1, A     # A = A + 1, back to the top
```

instead of a compare, a jump-if-zero, an add and a jump on a counter in memory. FORTRAN leaves
a `DO` variable undefined after its loop, so the counter is never stored back.

Inside the loop, `A[I]` costs nothing: the instruction names `A`'s address and register A,
and the machine adds them. The bytecode shows that as `26,A`. The 704 *subtracted* the
register from the address, which is why FORTRAN I stored arrays backwards; v5 adds, to keep
arrays the right way round.

Using the counter as a number (`PUNCH I`, `X = I * 2`) needs a `PXD` to copy it out of the
register first. A loop that does that more than a few times per iteration comes out
*slower* with a register: `PUNCH I, I * I, I * I * I` reads `I` six times.

A loop gets no register when all three are taken (a fourth nested loop), when its variable
is a SUB argument, or when it is inside a SUB (a call from inside a loop would overwrite the
caller's registers).

### What it saves

`drum_interleaved.f` sums 128 words from the drum, 8 at a time:

| | Instruction cycles | Waiting for the drum |
| --- | --- | --- |
| with index registers | 2,800 | 4,229 |
| without | 6,780 | 31,221 |

The registers cut the instruction cycles by more than half. That moves the best drum layout
too: blocks 5 sectors apart suit the faster loop, while the slower one would need 9.

The INDEX REGISTERS header shows each program's whole-run instruction cycles with and
without them. Each register box shows its value and, while its loop runs, the variable it
holds (`A = I`).

### Registers then and now

On the 704 a register instruction took the same 2 cycles as a memory one, so registers saved
*instructions*, not access time. Today they also save time: a register is under a
nanosecond away, main memory about 100.

| 704 | Today, by role |
| --- | --- |
| index registers | registers |
| core memory (12 µs) | caches |
| drum (~12 ms to reach a word) | main memory |
| tape (10 ms to start a record, minutes to rewind) | disk |

---

## `PUNCH`

```fortran
DO I = 1, 6
  PUNCH I, I * I
END
```

Each `PUNCH` makes up a card: every value goes in its own 10-column field, 7 to a card's 72
columns, and a longer list goes on "card after card", as the 1956 FORTRAN manual puts it.
Each statement starts a new card. The program waits while the card is punched, one row at a
time, row 9 first, as the IBM 721 took cards 9-edge first.

`squares_punch.f` punches six cards, `array_sum_punch.f` one.

[v6](../v6/README.md) adds the rest of the 704's registers, the accumulator and the MQ.
