# Registers: a design for v5 and v6

v5 adds the 704's three **index registers**, the way FORTRAN I used them. v6 adds the
**accumulator and MQ**, so forty compiles to 704-style one-address code. Both keep the
parser, places and statements of v0-v3; only code generation, the VM and the page change.

Everything below about the 704 comes from IBM's *704 Electronic Data-Processing Machine
Manual of Operation* (page numbers are the PDF's), unless marked as an estimate.

---

## 1. What the 704 had

| Register | Size | What it does | Manual |
| --- | --- | --- | --- |
| Accumulator (AC) | 38 bits: sign, Q, P, 1-35 | every add, subtract, compare and store goes through it; Q and P catch overflow | p17-19 |
| Multiplier-quotient (MQ) | 36 bits | holds the multiplier, then the low half of a product; the quotient after a divide; **every word to or from the drum, tape and card punch passes through it** | p18-19, p38 |
| Index registers A, B, C | 15 bits (for 32K words) | "automatic counting and effective address modification": an instruction's tag names one, and the CPU uses *address minus register* as the address | p5, p10-11 |
| Indicators | 1 bit each | AC overflow, MQ overflow, divide check, sense lights and switches | p11 |

Things that matter for the design:

- **Indexing subtracts.** "It is executed as if its address field had contained its stated
  address minus the contents of the specified index register" (p10). `TSX` stores the 2's
  complement of the return location for the same reason (p25).
- **A register instruction costs the same as a memory one.** The manual's headings give
  `CLA`, `ADD`, `SUB`, `STO`, `LDQ`, `STQ` as 2 cycles, and `TXI`, `TIX`, `TXH`, `LXD`,
  `SXD`, `PXD`, `PAX`, `TSX` as 2 cycles too. `MPY` and `DVP` take 20 (p17-26). A cycle is
  12 µs, the time of one core memory access (p6).
- **So index registers saved instructions, not access time.** `TIX` decrements, tests and
  branches in one instruction; an indexed `CLA BUF,A` replaces the address arithmetic of a
  subscript. FORTRAN I's compiler was "driven by the need to produce nearly perfect code
  for array addressing on the three-register 704" (Allen, 1982).
- **There is no indirect addressing.** The manual describes none. A pointer is reached by
  loading it into an index register, or by storing it into another instruction's address
  field with `STA` (p19).
- **The CPU moves every I/O word itself.** A drum, tape or card is read or written by a
  *copy loop* of `CPY` instructions, one word each, through the MQ; "the MQ cannot be
  used for computing during the copy loop", and a `CPY` must come within three cycles of
  the last or the drum disconnects (p38).

Device speeds, for the cost model:

| Device | Manual | Cycles of 12 µs |
| --- | --- | --- |
| core memory access | 12 µs (p6) | 1 |
| drum word | 96 µs, 10,000 words/s (p37) | 8 |
| drum turn | 24 ms; average access 12.29 ms (p38) | 2,048 (256 words a turn) |
| tape word | 2,500 words/s at 75 in/s (p30) | 33 |
| tape record gap | 3/4 inch (p31), so 10 ms at 75 in/s | 833 |
| tape rewind | 75 in/s for up to 450 feet; about 1.2 minutes for a full reel (p30) | the same speed as reading |
| card punch | 100 cards a minute, cards fed 9-edge first (p40) | 50,000 a card |

**A correction to v3:** v3 rewinds at an estimated 5 times reading speed. The manual says
a rewind of under 450 feet runs at the reading speed, 75 inches a second, so v3's
`REWIND_SPEED` should be 1.

---

## 2. One cost model for both versions

v2-v4 count one cycle per instruction. v5 and v6 count **704 cycles of 12 µs**, so device
waits and instruction costs share one clock, and the device constants above apply as is.

- In **v6** every instruction is a 704 instruction and costs what the manual says.
- In **v5** each 4-tuple costs what it would take on the 704 (an estimate, written out so it
  can be checked):

| 4-tuple | 704 instructions | Cycles |
| --- | --- | --- |
| `MOV a b` | `CLA b`, `STO a` | 4 |
| `+ - a b c` | `CLA b`, `ADD c`, `STO a` | 6 |
| `* a b c` | `LDQ b`, `MPY c`, `STQ a` | 24 |
| `/ % a b c` | `LDQ b`, `DVP c`, `STQ a` | 24 |
| comparisons | `CLA b`, `SUB c`, a transfer, a store | 8 |
| `JZ a b` | `CLA b`, `TZE a` | 4 |
| `JMP a` | `TRA a` | 2 |
| `LOAD_IND` / `STORE_IND` | `LXD` a pointer, an indexed `CLA` or `STO`, `STO` | 6 |
| `JAL` / `JMP_IND` | `TSX`, or `TRA` through the saved location | 4 |
| new: `LXD`, `TXI`, `TXH` | themselves | 2 |
| new: `PXD a reg` (register to memory) | `PXD`, `STO` | 4 |

This is a VM table only; the compiler does not change for it.

---

## 3. v5: the index registers

### The idea

FORTRAN I kept each `DO` loop's counter in an index register for the length of the loop
and indexed arrays with it directly. FORTRAN leaves a `DO` variable undefined after the
loop, so the counter never has to be stored back. v5 does exactly that.

### The compiler (an estimated 20 lines)

1. **A place can be a register**: `{ mode: 'REG', reg }`, next to `DIR` and `IND`.
2. **`parseDo`** takes a free register when the loop variable is a local scalar and the loop
   is not inside a `SUB`. It points the variable's symbol at the register for the body,
   then restores the symbol and frees the register, as `parseSub` already does with `sym`.
   The loop compiles to
   ```text
   LXD  reg, start          # once
   top: TXH exit, stop, reg # leave when reg > stop
        ... body ...
        TXI top, 1, reg     # reg += 1, back to the top
   ```
   With no free register (a fourth nested loop), or inside a `SUB`, it compiles as today.
   SUBs get no registers because a call from inside a loop would overwrite the caller's;
   FORTRAN II saved them around calls instead, which is more code for no new lesson.
3. **An index register as a subscript costs nothing.** In `parseLValue`, `A[I]` with `I` in a
   register and `A` a local 1D array becomes the place `{ mode: 'DIR', addr: A, tag: reg }`:
   an indexed operand, with no add and no `LOAD_IND`. Anything else (2D, expressions,
   SUB arguments) takes today's path.
4. **Reading or writing the register as a value** goes through `valAddr` and `store`:
   `PXD tmp, reg` and `LXD reg, src`, one new branch in each.

### The VM

- An operand is a 2-bit tag and a 7-bit address (RAM is 128 cells, so the word format does
  not change). The effective address is `address + register`. **Additive, not subtractive:**
  subtracting would mean storing every array backwards and every counter negated, which
  teaches nothing new; the README says the 704 subtracted.
- New instructions `LXD`, `PXD`, `TXI`, `TXH`; registers kept with the rest of the state, so
  Back works.
- Costs from the table above.

### What it should show (estimates)

The drum demo's inner loop, `SUM = SUM + BUF[I]`:

| | Instructions per iteration | Cycles per iteration |
| --- | --- | --- |
| v3 (memory counter) | 8 | about 42 |
| v5 (`I` in index register A) | 4 | about 14 |

The page compiles each program both ways and shows both cycle counts, so the saving is
read off directly, without a switch.

### In the page

- A **register panel** next to RAM: three boxes `A`, `B`, `C`, each showing its value and the
  variable it holds (`A = I`), outlined like a RAM cell when read or written.
- An indexed operand in EFFECT and hover text reads `BUF[I] (BUF + A = M[45])`.
- The FORTRAN line keeps its arrow to the bytecode; a loop's `TXH` and `TXI` are the lines
  it points to.

---

## 4. v6: the accumulator and MQ

### The idea

Compile to the 704's own one-address form, keeping the v5 index registers:

```text
X = A + B * C         LDQ B
                      MPY C
                      STQ T
                      CLA A
                      ADD T
                      STO X
```

Every value now makes a visible trip through the AC (or MQ) and back to core. That trip is
the memory traffic the cost model counts.

### The compiler: a new emitter, the same parser

1. **A place can be the AC**: `{ mode: 'AC' }`, the result of an expression still in the
   accumulator. Places stay the only interface the statements use.
2. **One spill rule.** When code needs the AC and a live `AC` place holds it, store the AC to a
   temporary and turn that place into `DIR` (one helper). Precedence climbing then works
   unchanged: the left operand is spilled only if the right one needs the AC.
3. **Operators**: `+ -` are `CLA lhs`, `ADD`/`SUB rhs`; `*` is `LDQ`, `MPY`, `STQ` to a
   temporary; `/` and `MOD` are `LDQ`, `DVP`, with the quotient in the MQ and the remainder
   in the AC.
4. **Conditions become branches.** `IF A <= B` computes `A - B` in the AC and branches with
   `TZE`, `TMI`, `TPL`, from a small table of relation to transfers, like FORTRAN's own
   sign-testing `IF`. Comparisons are then allowed only in `IF` and loop tests, which is
   all the demos use.
5. **SUB arguments** (an `IND` place) use index register C as the pointer: `LXD C, arg` then an
   indexed `CLA` or `STO`. That reserves C, so `DO` loops get A and B.
6. **I/O as copy loops (the strongest lesson, and optional).** `READ DRUM s, BUF` compiles to
   `RDS`, `LDA`, then `CPY BUF,A` and `TIX` eight times. Each `CPY` waits for its word and
   passes it through the MQ, so the page shows the CPU itself moving every word, at the
   drum's pace.

An estimated 40-60 lines change, almost all of them in code generation; tokenizing, parsing,
the statement table and places stay as they are.

### The VM

A new set of about 20 one-address instructions (`CLA ADD SUB STO LDQ STQ MPY DVP TRA TZE
TMI TPL TSX TXI TXH TIX LXD PXD STA CPY RDS WRS LDA`), with AC, MQ, A, B, C and the
overflow and divide-check indicators. Each costs its manual cycles.

### In the page

- The register panel grows to `AC`, `MQ`, `A`, `B`, `C`. Values flow visibly: a `CLA` outlines
  the RAM cell and fills the AC; a `CPY` fills the MQ from the drum reel, then the RAM cell.
- The BYTECODE header becomes `704 CODE`; instructions read like the manual (`CLA N`,
  `ADD ONE`, `STO N`).

---

## 5. How the tiers compare with a modern computer

| 704 | Access | Today, by role | Today's access (approximate, ~2012 figures) |
| --- | --- | --- | --- |
| AC, MQ, index registers | inside the instruction | registers | under 1 ns |
| core memory | 12 µs a word | caches (L1-L3) | about 1-40 ns |
| drum | 12.3 ms on average to reach a word | main memory | about 100 ns |
| tape | 10 ms to start a record; up to 1.2 minutes to rewind | disk | about 10 ms to seek |

Each step down is about a thousand times slower, then and now. The page shows each run's
cycles split by tier (instructions in core, drum, tape, card punch) next to this table.

Two differences, which the README should say plainly:

- **On the 704 the program moves the data between tiers.** Every drum word is a `CPY` the
  compiler or programmer wrote, and keeping a counter in a register was the compiler's
  decision. A modern cache does its moves in hardware, unseen by the program.
- **Registers were not faster to reach than core on the 704**: both took the same 2-cycle
  instruction. They paid off by needing fewer instructions. Today they are also far faster
  to reach than memory.

---

## 6. Why not simpler?

1. **Do nothing**: the visualizer would keep hiding that compiled FORTRAN lived on its
   register allocation.
2. **Only explain it in the README**: the point is seeing cycle counts change, which a
   README cannot do.
3. **Only change the VM's costs**: with no registers there is nothing for memory to be slower than.
4. **Registers as fast memory cells**: easy, but it shows the wrong lesson; on the 704 a
   register access was not faster, it saved instructions.
5. **Index registers with indexed operands (v5)**: the smallest change that shows the real
   saving, so it is the first step.
6. **The full one-address instruction set (v6)**: the most faithful; worth it only after
   v5, because it replaces code generation rather than adding to it.

## 7. Scope

| Part | v5 | v6 | Risk |
| --- | --- | --- | --- |
| compiler | about 20 lines: `REG` places, `parseDo`, one subscript case | about 40-60 lines: an emitter with `AC` places, spill, branches, copy loops | v6's spill rule and conditions are the only new logic with real cases |
| VM | about 35 lines: tagged operands, 4 instructions, cost table | a new one-address instruction set, about the size of today's VM | `CPY` timing has to match the device constants |
| page | about 40 lines: register panel, both-ways cycle counts | AC and MQ in the panel, 704 mnemonics in EFFECT and hover | the panel must fit beside RAM |
| tests | new cost and register tests; pinned cycle counts re-derived | most bytecode and cycle tests rewritten | |

All line counts are estimates, not measurements.

## 8. Open questions

- Should v5's cost table count the extra instructions a 4-tuple implies (as above), or keep
  1 cycle per 4-tuple so that only v6 is in 704 cycles? The table makes v5's saving honest;
  1-per-4-tuple understates it.
- Floating point is the other big 704 feature FORTRAN existed for. It belongs in its own
  version; nothing here depends on it.

## Sources

- IBM, [*704 Electronic Data-Processing Machine Manual of Operation*](https://www.ibiblio.org/apollo/Documents/IBM704ElectronicDataProcessingMachineManualOfOperation.pdf):
  registers p5 and p10-11; instructions and cycles p17-26; timing types p28; tape p30-31;
  drum p37-38; cards p40.
- F. E. Allen, [*A Technological Review of the FORTRAN I Compiler*](https://www.softwarepreservation.org/projects/FORTRAN/paper/Allen-technological_review_FORTRAN-1982.pdf), 1982.
- J. Backus and W. Heising, [*FORTRAN*](https://www.softwarepreservation.org/projects/FORTRAN/paper/BackusHeising-FORTRAN-1964.pdf), 1964: the `DO` statement as the region for assigning index registers.
- [IBM 704](https://en.wikipedia.org/wiki/IBM_704), Wikipedia: register table.
- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832) (Norvig, Dean): modern figures, about 2012.
