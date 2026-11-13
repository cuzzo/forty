# The v4 Implementation - A RISC-V Backend

Up to v3, the only machine that runs a forty program is forty's own VM. v4 adds
a second backend, `emitRiscv` in [compiler.js](compiler.js), which turns the same
4-tuple instructions into **RV32IM assembly**: the 32-bit RISC-V base integer
set plus multiply and divide. The page can run either one, and a standard
RISC-V simulator can run the assembly too.

v4 is the original full app the earlier versions were cut down from, so it also
has its own, fuller I/O: four tape units with `WRITE` and an end-of-file
flag, and a drum addressed by track and sector with `DRUM_WRITE`. Like v0, it
keeps the instructions separate from memory.

---

## From 4-tuples to RISC-V

All of memory becomes one array of words, `MEM`, and register `s0` holds its
address. Cell `n` is at byte offset `4 * n`. Each 4-tuple then becomes a few
loads, one operation and a store:

| 4-tuple | RV32IM |
| --- | --- |
| `MOV a b` | `lw t0, 4b(s0)` / `sw t0, 4a(s0)` |
| `* a b c` | `lw t0, 4b(s0)` / `lw t1, 4c(s0)` / `mul t0, t0, t1` / `sw t0, 4a(s0)` |
| `<= a b c` | `lw` / `lw` / `slt t0, t1, t0` / `xori t0, t0, 1` / `sw` |
| `JZ a b` | `lw t0, 4b(s0)` / `beqz t0, L_a` |
| `JAL a b` | `la t0, L_next` / `sw t0, 4a(s0)` / `j L_b` |
| `JMP_IND a` | `lw t0, 4a(s0)` / `jr t0` |
| `PRINT a` | `lw a0, 4a(s0)` / `li a7, 1` / `ecall` (and a newline) |

Every instruction gets a label `L_n`, so jumps keep their instruction numbers.
There are no register allocations to work out: like the 4-tuples, every value
lives in memory, and `t0` and `t1` only hold it between a load and a store.

`factorial.f` starts:

```asm
.data
MEM: .word 0, 5, 0, 1, 0, 0, 0
.text
.globl main
main:
    la s0, MEM
L_0:
    lw t0, 4(s0)
    sw t0, 0(s0)
```

---

## What else v4 adds

| Statement | Does |
| --- | --- |
| `WHILE cond ... END` | loops while `cond` is not 0 |
| `READ(u) X, EOF` | reads one word from tape unit `u`; sets `EOF` to 1 at the end of the tape |
| `WRITE(u) expr` | writes a word at tape unit `u`'s head and moves on |
| `REWIND(u)` | rewinds tape unit `u` |
| `DRUM_READ(track, sector, BUF)` / `DRUM_WRITE(...)` | copies 8 words between the drum and `BUF` |

In the page, **.rodata MMU** makes constants read-only, so `swap.f` stops with a
trap instead of silently turning `2` into `10`. The time scrubber jumps to any
step, and 2D arrays are drawn as matrices.

---

## Running the assembly on a real RISC-V simulator

[RARS](https://github.com/TheThirdOne/rars) is a RISC-V simulator written in
Java. Its system calls match the ones `emitRiscv` uses: 1 prints an integer,
11 prints a character and 10 exits.

Install Java:

```sh
# macOS
brew install openjdk
export PATH="$(brew --prefix openjdk)/bin:$PATH"

# Debian / Ubuntu
sudo apt install default-jre

# Fedora
sudo dnf install java-21-openjdk
```

Download RARS:

```sh
curl -LO https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar
```

From the repository's root, write a demo's assembly to a file and run it:

```sh
node --input-type=module -e "
import { compile, emitRiscv } from './v4/compiler.js';
import { DEMOS } from './v4/visualizer.js';
const p = compile(DEMOS.factorial.code, { memSize: 64 });
console.log(emitRiscv(p.code, p.initMem, p.usedCells));
" > factorial.s

java -jar rars1_6.jar nc factorial.s
```

It prints `120`. Swap `factorial` for `swap`, `saxpy` or `equiv` to run the
others.

The tape and drum demos use system calls 20-24, which are forty's own, so they
run only in the page.
