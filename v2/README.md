# The v2 Implementation - The Drum

v1's memory holds 128 words, program included. v2 adds a **magnetic drum**: a
spinning cylinder of 32 sectors, 8 words each, read by a head that never moves.

The drum turns all the time. To read sector 5, the computer waits until sector 5
comes round, then copies its words as they pass. On the [IBM 704](https://en.wikipedia.org/wiki/IBM_704)
the CPU did that copying itself, so the program waited for the read to finish.
v2 does the same.

---

## What the compiler adds

| Statement | Compiles to |
| --- | --- |
| `READ DRUM sector, BUF` | `DRUM_READ` with the sector, a reference to `BUF`, and `BUF`'s length |
| `MOD(a, b)` | the `%` instruction |

`BUF` is passed by reference with `ptrAddr`, exactly like a `CALL` argument, so
the destination can be a local array or a SUB's array argument.

As in FORTRAN, the read copies as many words as the list names, from the
start of the sector on through the following sectors: `DIM BUF(12)` reads 12.

## What the VM adds

A cycle counter. One cycle is one IBM 704 core memory cycle, 12 µs, and each
instruction costs the cycles of the 704 instructions it stands for (from the 704
*Manual of Operation*):

| Instruction | 704 instructions | Cycles |
| --- | --- | --- |
| `MOV` | `CLA`, `STO` | 4 |
| `+ -` | `CLA`, `ADD`, `STO` | 6 |
| `* / MOD` | `LDQ`, `MPY` or `DVP`, `STQ` | 24 |
| `JZ` | `CLA`, `TZE` | 4 |
| `LOAD_IND`, `STORE_IND` | through an index register | 6 |

The drum's position comes from the cycle count, at the IBM 733's speed: a word
every 8 cycles (96 µs), a turn every 2,048 (24 ms). A `DRUM_READ` waits for its
sector, then copies one word every 8 cycles into memory.

These timings are set once, in [machine.js](../machine.js), for every version from
here on.

---

## The program: an array too big for memory

```fortran
DIM BUF(8)
SKIP = 1
SUM = 0
DO K = 0, 15
  READ DRUM MOD(K * SKIP, 32), BUF
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

| Demo | Block `K` is stored in sector | Cycles | Of which waiting for the drum |
| --- | --- | --- | --- |
| `drum_in_order.f` | `K` | 34,161 | 27,381 |
| `drum_interleaved.f` | `K * 9 mod 32` | 11,121 | 4,341 |

**In order**, adding up 8 numbers takes about 420 cycles, a little over 6½ sectors
of drum turn. The next sector has long gone by, so every read waits most of a
turn.

**Interleaved**, each block is 9 sectors after the last: one sector to read it,
6½ to add it up, and the rest to spare. 8 would be tighter, but 8 divides 32, so
block 4 would land on block 0's sector. Of the 4,341 waiting cycles, 1,024 are the
words themselves passing the head (128 words x 8) and 2,031 are the very first read
waiting for sector 0.

Drum programmers placed their data (and on drum-memory machines like the IBM 650,
their instructions) this way on purpose. IBM's SOAP assembler did it for them.

## In the page

The drum is drawn as a three-row reel under the bytecode. The middle row is the
sector under the head; the faint rows are the one just gone and the one coming
next. EFFECT counts the wait down, and words copied into memory turn orange.
A wait is up to 2,048 cycles, so **Next** moves one sector's worth of it (or
one word of a transfer) at a time, and **Previous** undoes the same.

Next, [v3](../v3/README.md) adds a tape.
