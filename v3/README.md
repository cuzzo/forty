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
| `READ TAPE BUF` | `TAPE_READ` with a reference to `BUF` |
| `REWIND` | `REWIND` |

## What the VM adds

A tape position. The timings follow the IBM 727 tape drive, with one cycle being
one IBM 704 instruction (24 µs):

| | IBM 727 | Here |
| --- | --- | --- |
| reading a 36-bit word (6 characters at 15,000 a second) | 400 µs | 16 cycles |
| the 3/4-inch gap the tape starts in before each record | ~10 ms | 400 cycles |
| rewinding | faster than reading | 5 times faster (an estimate) |

A record of 8 words therefore takes 528 cycles to read, and the drum (v2) keeps
its IBM 733 speed: a word every 4 cycles, a turn every 1,024.

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
| 21 reads, 528 cycles each | 11,088 |
| the rewind over 20 records | 2,112 |

Reading in order costs the same every time. Going back costs a rewind over
everything read so far, and that grows the further along the tape you are: this
one is already longer than the drum's worst wait of one turn (1,024 cycles).

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
