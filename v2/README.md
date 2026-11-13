# The v2 Implementation - The Drum

v1's memory holds 128 words, program included. v2 adds a **magnetic drum**: a
spinning cylinder of 16 sectors, 8 words each, read by a head that never moves.

The drum turns one word past the head per cycle, all the time. To read sector 5,
the computer waits until sector 5 comes round, then copies its words one per
cycle as they pass. On the [IBM 704](https://en.wikipedia.org/wiki/IBM_704)
the CPU did that copying itself, so the program waited for the read to finish. 
v2 does the same.

---

## What the compiler adds

| Statement | Compiles to |
| --- | --- |
| `READ DRUM sector, BUF` | `DRUM_READ` with the sector and a reference to `BUF` |
| `MOD(a, b)` | the `%` instruction |

`BUF` is passed by reference with `ptrAddr`, exactly like a `CALL` argument, so
the destination can be a local array or a SUB's array argument.

## What the VM adds

A cycle counter. Every instruction takes one cycle, and the drum's position is
the cycle count mod 128. A `DRUM_READ` then takes many cycles: it waits for its
sector, then copies one word per cycle into memory.

---

## The program: an array too big for memory

```fortran
DIM BUF(8)
SKIP = 1
SUM = 0
DO K = 0, 15
  READ DRUM MOD(K * SKIP, 16), BUF
  DO I = 0, 7
    SUM = SUM + BUF[I]
  END
END
PRINT SUM
```

The drum holds a 128-word array, `1, 2, ..., 128`. The program alone uses 46
cells, so the array cannot fit next to it. It sums the array 8 words at a time
through `BUF`, and prints `8256`.

The two demos run the same program with the drum laid out two ways:

| Demo | Block `K` is stored in sector | Cycles spent waiting for the drum |
| --- | --- | --- |
| `drum_in_order.f` | `K` | 930 |
| `drum_interleaved.f` | `K * 11 mod 16` | 210 |

**In order**, adding up 8 numbers takes about 60 cycles, which is about 7 sectors
of drum turn. The next sector has already gone by, so every read waits almost a
whole turn.

**Interleaved**, each block is 11 sectors after the last, so it arrives just as
the adding finishes. About 120 of the 210 cycles are the very first read waiting
for sector 0.

Drum programmers placed their data (and on drum-memory machines like the IBM 650,
their instructions) this way on purpose. IBM's SOAP assembler did it for them.

## In the page

The drum is drawn as a three-row reel under the bytecode. The middle row is the
sector under the head; the faint rows are the one just gone and the one coming
next. EFFECT counts the wait down, and words copied into memory turn orange.

Next, [v3](../v3/README.md) adds a tape.
