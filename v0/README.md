# Forty V0 - A One-Pass Compiler for Pre-Heap FORTRAN

This is a compiler for a subset of FORTRAN (most of it - pre-heap).

This README does **not** teach:

 * tokenizing,
 * recursive-descent parsing,
 * backpatching,
 * or what machine code is.

[Puck](https://github.com/cuzzo/clear/tree/master/examples/puck/README.md)
builds all of those up from an 80-SLoC start, one version at a time. Read it
first if any of those words are new.

What is worth reading here is how *this* compiler is put together, and what
1950s FORTRAN asked of one: no heap, no stack, every variable at a fixed address.

It comes with a visualizer that helps understand what that *actually* means,
and it can help learn a lot about how today's computers work, from a much simpler
starting point.

---

## The architecture

[compiler.js](compiler.js) is one function, `compile(source)`, in four parts.

| Part | Job |
| --- | --- |
| `tokenize` | One regular expression splits the source into tokens, each with its line. |
| the parser | Recursive descent, one function per statement, looked up in `STATEMENTS`. |
| `alloc` / `defConst` | Hand out memory cells. |
| `emit` / `patch` | Write instructions, and fill in forward jumps once their target is known. |

### Tokens

Everything the regex does not know becomes a one-character token, so a stray
`.` or `$` is rejected by the parser where it does not fit. Every program ends
with an `end of input` token, so the parser never checks for running off the deep end.

### Parsing without a tree

There is no AST. The parser **emits code as it reads**. Modern languages are too 
complicated to implement so simply.

By the time the parser has read `FACT = FACT * I`, the instructions for it exist. 
Expressions use precedence climbing over one table:

```js
const PREC = { '==': 1, '!=': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3 };
```

### Places

A variable is a **place**: `{ mode, addr }`.

| Mode | The cell at `addr` holds | Used for |
| --- | --- | --- |
| `DIR` | the value | locals, constants, temporaries |
| `IND` | the *address* of the value | SUB arguments, array elements |

Reading a place is `valAddr` (an `IND` place costs one `LOAD_IND`), writing one
is `store`, and passing one by reference is `ptrAddr`. Every statement goes
through these three, so a SUB argument works anywhere a local does.

### Memory: one bump pointer

`alloc` hands out the next free cell and never takes one back. Variables,
arrays, constants, temporaries and SUB linkage all get a fixed address at
compile time, the way FORTRAN on an IBM 704 did. Constants are pooled: every
`1` in the program is the same `const(1)` cell.

### Instructions

Every instruction is a 4-tuple `[op, a, b, c]`, memory to memory, three operands:

| Instruction | What it does |
| --- | --- |
| `MOV a b` | `M[a] = M[b]` |
| `+ a b c` (and `- * / == != < > <= >=`) | `M[a] = M[b] op M[c]` |
| `LOAD_IND a b` | `M[a] = M[M[b]]` |
| `STORE_IND a b` | `M[M[a]] = M[b]` |
| `JMP a` | go to instruction `a` |
| `JZ a b` | if `M[b]` is 0, go to `a` |
| `JAL a b` | `M[a] =` the next instruction, go to `b` (call) |
| `JMP_IND a` | go to the instruction in `M[a]` (return) |
| `PRINT a` | print `M[a]` |

The VM ([vm.js](vm.js)) is one `if` per instruction.

---

## The FORTRAN it supports

| Statement | Example |
| --- | --- |
| assignment | `FACT = FACT * I` |
| integer arrays, 1D or 2D (column-major, like FORTRAN) | `DIM A(3, 2)` then `A[R, C] = 1` |
| `EQUIVALENCE`: two names for the same storage | `EQUIV VIEW_A(2, 2) = WORKSPACE` |
| `IF` | `IF X > 0 THEN ... ELSE ... END` |
| `DO` loops | `DO I = 1, N ... END` |
| subroutines, by reference | `SUB SWAP(A, B) ... END` and `CALL SWAP(X, Y)` |
| output | `PRINT X` |
| comments | `# ...` |

The syntax is modernised where FORTRAN's was hard to read: `END` closes blocks
instead of statement labels, and arrays index with `[ ]`. The semantics are not:
integers only, static storage, no recursion (a SUB has one return slot), and
arguments passed by reference.

---

## Example 1: `factorial.f`

```fortran
N = 5
FACT = 1
DO I = 1, N
  FACT = FACT * I
END
PRINT FACT
```

### Tokens

```text
N = 5 FACT = 1 DO I = 1 , N FACT = FACT * I END PRINT FACT (end of input)
```

### Memory

Before the first instruction runs, the compiler has laid out every cell:

```text
[0] N          variable
[1] const(5)   constant
[2] FACT       variable
[3] const(1)   constant
[4] I          variable
[5] tmp_5      temporary (I <= N)
[6] tmp_6      temporary (FACT * I)
```

### Bytecode

```text
00: MOV   0 1      N = 5
01: MOV   2 3      FACT = 1
02: MOV   4 3      I = 1
03: <=    5 4 0    tmp_5 = I <= N          <- loop top
04: JZ    9 5      if tmp_5 is 0, go to 09  (patched once END was reached)
05: *     6 2 4    tmp_6 = FACT * I
06: MOV   2 6      FACT = tmp_6
07: +     4 4 3    I = I + 1
08: JMP   3        back to the loop top
09: PRINT 2        prints 120
```

`JZ 9` was emitted as `JZ 0` while the compiler was still inside the loop, and
patched to `9` when it reached `END`. Press **Compile** in the page and step
through the walk to watch that happen.

---

## Example 2: `swap.f`, and why constants live in memory

```fortran
SUB SWAP(A, B)
  TMP = A
  A = B
  B = TMP
END
X = 10
Y = 99
CALL SWAP(X, Y)
PRINT X
PRINT Y
CALL SWAP(2, Y)
PRINT 2
```

It prints `99`, `10` and then **`10`**.

`CALL` passes each argument by reference: it moves the argument's *address*
into the SUB's linkage cell (`SWAP.A`). For `CALL SWAP(2, Y)` the argument is the
constant `2`, so `SWAP.A` holds the address of the `const(2)` cell, and
`A = B` writes `10` into it. From then on, every `2` in the program is `10`.

This was a real bug in early FORTRAN. Nothing stopped a subroutine from
overwriting a constant passed to it.

---

## Running it

```sh
python3 -m http.server 8000     # from the repository's root
open http://localhost:8000/v0/
npm test                         # every version's tests
```

The other demos: `saxpy.f` (2D arrays sliced by column and passed to a SUB) and
`equiv.f` (a 2x2 view over a 4-cell array).

When you're ready, [v1](../v1/README.md) puts the program itself into memory.
