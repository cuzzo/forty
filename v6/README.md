# The v6 Implementation - The Accumulator and the MQ

v5 gave the compiler the 704's three index registers, but it still emitted three-address
instructions like `+ X A B`, and charged each one the cycles of the 704 instructions it
would take.

v6 emits those instructions. The 704 had one address per instruction, and two more
registers that every calculation went through:

| Register | Bits | Job |
| --- | --- | --- |
| AC, the accumulator | 38 | every add, subtract, compare and store |
| MQ, the multiplier-quotient | 36 | multiply and divide |
| A, B, C, the index registers | 15 | loop counters, array indexing, SUB linkage |

So `X = A + B * C` is now

```text
LDQ B      MQ = B
MPY C      MQ = MQ * C          20 cycles
STQ t      t = MQ
CLA A      AC = A               "clear and add"
ADD t      AC = AC + t
STO X      X = AC
```

Every instruction takes 2 cycles, except `MPY` and `DVP` (20).

---

## Places in the AC

v0's places (`DIR`, `IND`) and v5's (`REG`, `IDX`) get one more mode: `AC`, a value in the
accumulator. `+` loads its left side into the AC and adds its right side to it, and the
result stays there as an `AC` place.

There is only one AC. When something else needs it while it holds a value,
`spill()` stores the AC to a temporary, and the place it held becomes a `DIR` place naming that
cell. That is the whole register allocator:

```fortran
X = (A + B) * (C + D)
```

```text
CLA A
ADD B
STO t1     spill: the AC is needed for C + D
CLA C
ADD D
STO t2
LDQ t1
MPY t2
```

## Conditions

There are no compare instructions. A condition subtracts and branches on the AC's sign:

| Test | AC = | Go to ELSE on |
| --- | --- | --- |
| `X == Y` | X - Y | `TNZ` (not zero) |
| `X != Y` | X - Y | `TZE` (zero) |
| `X < Y` | X - Y | `TPL` (plus, >= 0) |
| `X >= Y` | X - Y | `TMI` (minus) |
| `X > Y` | Y - X | `TPL` |
| `X <= Y` | Y - X | `TMI` |

So a comparison only makes sense in an `IF`. `X = A < B` is now a compile error.

A `DO` loop counted in memory tests `stop - I` with `TMI`. One counted in an index
register uses `TXH` as before.

## SUBs: TSX and index register C

`CALL` puts each argument's address in the SUB's linkage cells, then jumps with
`TSX entry,C`, which leaves the call's location in index register C. The SUB saves C with
`SXD`, and returns with `LXD` and `TRA 1,C`: go to the instruction at C + 1. FORTRAN II
called and returned the same way (`TSX` and `TRA 1,4`; the tag for C was 4), but put the
argument addresses in the words just after the `TSX`.

The 704 had no indirect addressing. To reach an argument, the SUB loads its address into C
and uses C as an index:

```text
LXD SWAP.A,C   C = the address in SWAP.A
CLA 0,C        AC = the cell at 0 + C
```

So C belongs to linkage, and `DO` loops get A and B.

## The instruction word, and memory

v0 to v5 packed three 9-bit operands into one word, which no real machine of the time did.
A 704 instruction had one 15-bit address, a 15-bit decrement and a 3-bit tag. v6 does
the same, at a smaller size: a 5-bit opcode, an address and a decrement (each a 2-bit tag
and 8 bits), and a 2-bit register.

One address per instruction makes programs longer:

| Demo | v5 instructions | v6 instructions | v5 cycles | v6 cycles |
| --- | --- | --- | --- | --- |
| `factorial.f` | 10 | 16 | 196 | 196 |
| `swap.f` | 19 | 32 | 106 | 90 |
| `saxpy.f` | 56 | 112 | 1,362 | 1,210 |
| `formula.f` | 8 | 14 | 50 | 46 |

`saxpy.f` no longer fits in 128 words, so v6 has 256. Cells not in use show only their address.
A real 704 had 4,096 to 32,768 words.

v6 is slightly faster than v5's estimates, because a value can stay in the AC from one
operation to the next instead of going back to memory each time.

## Where v6 is not the 704

- Index registers add to the address. The 704 subtracted them (see v5), so its `TSX` stored
  the call's location negated.
- `TXH` compares the register with a cell. The 704 compared it with the instruction's
  decrement.
- `MPY` clears the AC. The 704 put the product's high half there. Every product here fits
  in one word.
- A product goes through a temporary (`STQ t`, `CLA t`) before it is stored. Storing it
  straight from the MQ would need a second spill rule for the MQ.
- `PRINT`, `PUNCH`, `READ` and `REWIND` stay single instructions. On the 704 they were a
  device select, then one `CPY` per word.

## The demos

The v5 demos, plus `formula.f` (`X = A + B * C`, prints 23) and `largest.f` (an `IF`, prints 7).
