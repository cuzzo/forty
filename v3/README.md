# The v3 Implementation - The Tape

v3 adds a **magnetic tape** next to v2's drum: 64 records of 8 words, four times
what the drum holds.

A tape has no addresses. Each read gets the next record, and the tape only
moves forward while reading. To get an earlier record back, you rewind over
everything in between.

---

## What the compiler adds

| Statement | Compiles to |
| --- | --- |
| `READ TAPE BUF` | `TAPE_READ` with a reference to `BUF`, and `BUF`'s length |
| `REWIND` | `REWIND` |

A `READ TAPE` reads one record, as the 1956 FORTRAN manual says. A shorter `BUF`
gets the record's first words, and the tape still moves on to the next record.
A longer one stops the program with a Read-Write Check, as it did on the 704:
this tape's records are 8 words, so `DIM BUF(16)` with `READ TAPE BUF` stops.

## What the VM adds

A tape position. The timings follow the IBM 727 tape drive, in v2's 704 cycles of
12 µs ([machine.js](../machine.js)):

| | IBM 727 | Here |
| --- | --- | --- |
| reading a word (2,500 words a second) | 400 µs | 33 cycles |
| the 3/4-inch gap the tape starts in before each record | ~10 ms | 833 cycles |
| rewinding under 450 feet | 75 inches a second, as fast as reading | the same |

A record of 8 words therefore takes 1,097 cycles to read. The drum (v2) turns once
every 2,048.

---

## The program: `tape_rewind.f`

```fortran
DIM R(8)
DO K = 1, 20
  READ TAPE R
END
PRINT R[0]
REWIND
READ TAPE R
PRINT R[0]
```

It prints `153` (the first word of record 20), then `1` (record 1 again).

| | Cycles waiting on the tape |
| --- | --- |
| 21 reads, 1,097 cycles each | 23,037 |
| the rewind over 20 records | 21,940 |

Reading in order costs the same every time. Going back costs a rewind over
everything read so far, and that grows the further along the tape you are: this
one is already ten times the drum's worst wait of one turn (2,048 cycles).

## Drum or tape?

| | Drum | Tape |
| --- | --- | --- |
| reaching any piece of data | within one turn | a rewind over everything in between |
| reading in order | you can just miss each sector | only the start-up gap |
| capacity, cost per word | small, expensive | large, cheap |
| removable | no | yes: stored, shipped, archived |

So tape held large data processed in one pass (payroll files, sort/merge jobs),
and the drum held working data a program came back to.

## In the page

The tape is a strip under the drum, moving past a fixed head in the middle:
each record's start-up gap and number (`#17`), then its words. During `REWIND`
the strip slides back.

Next, [v4](../v4/README.md) compiles the same language to RISC-V.
