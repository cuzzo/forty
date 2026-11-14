# The v4 Implementation - A RISC-V Backend

Up to v3, the only machine that runs a forty program is forty's own VM. v4 adds a
second backend, `emitRiscv` in [compiler.js](compiler.js), which turns the same
4-tuple instructions into **RV32IM assembly**: the 32-bit RISC-V base integer set
plus multiply and divide. A standard RISC-V simulator can run it.

v4 is v3 plus `emitRiscv`, about 30 lines. The page shows the RISC-V under the
bytecode, with the lines for the instruction that just ran highlighted.

---

## From 4-tuples to RISC-V

All of memory becomes one array of words, `MEM`, and register `s0` holds its
address. Cell `n` is at byte offset `4 * n`. Each 4-tuple then becomes a few
loads, one operation and a store:

| 4-tuple | RV32IM |
| --- | --- |
| `MOV a b` | `lw t0, 4b(s0)` / `sw t0, 4a(s0)` |
| `* a b c` | `lw t0, 4b(s0)` / `lw t1, 4c(s0)` / `mul t0, t0, t1` / `sw t0, 4a(s0)` |
| `% a b c` | the same, with `rem` |
| `<= a b c` | `lw` / `lw` / `slt t0, t1, t0` / `xori t0, t0, 1` / `sw` |
| `JZ a b` | `lw t0, 4b(s0)` / `beqz t0, L_a` |
| `JAL a b` | `la t0, L_next` / `sw t0, 4a(s0)` / `j L_b` |
| `JMP_IND a` | `lw t0, 4a(s0)` / `jr t0` |
| `PRINT a` | `lw a0, 4a(s0)` / `li a7, 1` / `ecall` (and a newline) |
| `HALT` | `li a7, 10` / `ecall` |

Every instruction gets a label `L_n`, so jumps keep their instruction numbers.
There are no registers to allocate: as in the 4-tuples, every value lives in
memory, and `t0` and `t1` only hold it between a load and a store.

Since v1 the program sits in memory too, at the start. RISC-V runs the code
itself, so those cells are just 0 in `MEM`, and every variable keeps its address.

`factorial.f` starts:

```asm
.data
MEM: .word 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 1, 0, 0, 0
.text
.globl main
main:
    la s0, MEM
L_0:
    lw t0, 48(s0)
    sw t0, 44(s0)
```

RISC-V machines have no drum or tape, so a program that reads one has no RISC-V
version, and the page says so. A division by zero stops forty's VM; RISC-V
gives -1 and goes on.

The tests run the emitted assembly on a small RV32IM interpreter and check that
it prints what the VM prints.

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
import { emitRiscv } from './v4/compiler.js';
import { DEMOS, layout } from './v4/visualizer.js';
console.log(emitRiscv(layout(DEMOS.factorial.code)));
" > factorial.s

java -jar rars1_6.jar nc factorial.s
```

It prints `120`. Swap `factorial` for `swap`, `saxpy` or `equiv` to run the
others.

Next, [v5](../v5/README.md) goes back to the 704 and adds its index registers.
