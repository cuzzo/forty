# The v1 Implementation - The Program Lives in Memory

In v0 the instructions sat in a JavaScript array and memory held only data.
Real machines of the period had one memory: the program and its data shared
the same few thousand words, and a program that did not fit did not run.

v1 makes that true here. Three things change:

1. Each instruction is **packed into one 32-bit memory word**.
2. The compiler puts the program at `MEM[0..]`, ends it with `HALT`, and puts the
   data right after it.
3. The VM **fetches each instruction from memory**, so whatever is in a code
   cell is what runs.

---

## Packing an instruction

```text
 31     27 26        18 17         9 8          0
+---------+------------+------------+------------+
| opcode  |     a      |     b      |     c      |
| 5 bits  |   9 bits   |   9 bits   |   9 bits   |
+---------+------------+------------+------------+
```

`encode` and `decode` in [vm.js](vm.js) are one line each. Nine bits per operand
means a program can address up to 512 cells; v1 uses 128.

`factorial.f` (the same program as v0) becomes these words:

```text
00  MOV 11 12 0      00001 000001011 000001100 000000000
01  MOV 13 14 0      00001 000001101 000001110 000000000
 ...
10  HALT 0 0 0       00000 000000000 000000000 000000000
```

## Data starts where the code ends

The compiler needs to know how long the code is before it can give the first
variable an address. It compiles twice: once to measure the code, then again
with the data starting right after it. In `factorial.f` the code is cells 0-10,
so `N` is cell 11, not 0.

## Fitting in memory

| Demo | Code cells | Code + data |
| --- | --- | --- |
| `factorial.f` | 11 | 18 |
| `swap.f` | 19 | 33 |
| `equiv.f` | 25 | 54 |
| `saxpy.f` | 60 | 116 |

`saxpy.f` uses 116 of the 128 cells. Compile it for 64 and it fails with
`Program does not fit in 64 cells of RAM`.

Because the VM runs whatever is in memory, a stray `STORE_IND` into a code cell
changes the program. The tests overwrite a `PRINT` with a `HALT` and watch the
program stop early.

## In the page

The RAM grid shows all 128 cells. Code cells are the small grey chips at the
top, numbered by address; the one that just ran is blue and the next one has a
`>`. Hovering a chip highlights its bytecode row.

Next, [v2](../v2/README.md) adds a drum to hold more data than memory can.
