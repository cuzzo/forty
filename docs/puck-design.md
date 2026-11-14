# Puck on forty: design and sizing

**Verdict.** Doable, but the JavaScript port is the bulk of the work, not the easy part.
Port Puck's pipeline to JavaScript and give the shared visualizer a call-stack panel in
place of forty's memory grid. Do it in two stages:

1. Puck v4's language (integers, procedures, recursion, `IF`, `LOOP`) and a call-stack panel.
2. Puck v5-v9 (the heap, strings, arrays, `VAR`, `MODULE`, macros, `core.puck`) and a heap panel.

Stage 1 is useful on its own: recursion is exactly what forty's FORTRAN cannot do.

| Sizing | Stage 1 | Stage 2 |
| --- | --- | --- |
| Production lines (estimate) | ~500-650 (`me`) | ~700-850 more (`l`) |
| Threat | T0 (a teaching page) | T0 |
| Polish | internal | internal |

The estimates scale Ruby line counts (`wc -l`, comments included) to JavaScript; the
comment share of those files was not measured, so they may come in lower.

---

## What Puck is (inspected in `~/dev/clear/examples/puck`)

- A Ruby pipeline built up over v1-v9: tokenizer, parser, macro expander, bytecode compiler,
  stack VM. v9 is 1,224 lines of Ruby (tokenizer 55, parser 440, macro expander 168,
  compiler 350, VM 211). v4 is 414 (41, 190, 108, 75).
- The VM (`v9/vm.rb`) is a stack machine with 18
  opcodes: `PUSH ALLOC ALLOC_CELL ALLOC_ARRAY LOAD LOAD_REF ARRAY_LEN MATH COMPARE JUMP
  JUMP_IF_FALSE STORE STORE_REF ARRAY_GET ARRAY_SET CALL RETURN SYSCALL`.
- **The call stack is Ruby's.** `CALL` recurses into `run_procedure`, and each call gets its own
  locals array and its own operand stack. Nothing holds the frames as data, so nothing can draw them.
- The heap is refcounted: every value is an array (strings are codepoint arrays) with a count.
- `SYSCALL` has 10 services: print, stdin, open, read and close a file, time, open and
  write a file for writing, exit, argv.
- `core.puck` (541 lines of Puck) is required by every v6+ program.

### There is no integration test suite yet

`spec/`, `testdata/` and `tools/` in `~/dev/clear` hold no Puck tests. What exists, and runs
green under Ruby 3.2 today:

| Program | Output |
| --- | --- |
| `v1/example.puck` .. `v9/example.puck` | one per version (`42`, ..., `kcup 104 105`) |
| `samples/fib.puck` | `fib(0..10)`, ending `55` |
| `v9/core-test.puck` | 78 checks of `core.puck`: `passed: 78`, `failed: 0` |
| `benchmarks/vm/01_fib.puck`, `02_loop_sum.puck`, `04_filter_sum.puck` | timings, so only the result line is stable |

So the suite has to be built: run each program under Ruby, save its output, and check the
JavaScript port prints the same. `core-test.puck` is the strongest test of stage 2, since it
exercises the whole of `core.puck` from inside Puck. Stage 1 has only the v1-v4 examples
and a fib written without `MODULE`, which already prints `55` under v9.

### Ruby semantics the port must copy

Checked by running v9:

| Puck | Ruby gives | A plain JavaScript port gives |
| --- | --- | --- |
| `0 - 7 / 2` | `-4`: no operator precedence, left to right | `-3` |
| `(0 - 7) / 2` | `-4`: integer division rounds down | `-3` |
| `(0 - 7) % 3` | `2`: takes the divisor's sign | `-1` |
| `SYSCALL(1, 3 < 4)` | `true`: comparisons are booleans | `1` |

Ruby integers never overflow. JavaScript numbers lose precision past 2^53, which no listed
program reaches.

---

## Options

**A. Compile Puck to forty's machine.** Rejected. forty allocates every variable at a fixed
address in 128 words (256 in v6). It has no stack and no heap, so recursion and strings
would need a stack discipline and an allocator built in those words: a new compiler, not a port.

**B. Port Puck to JavaScript and add a call-stack panel to the shared visualizer.** Recommended.

**C. Replay traces recorded by the Ruby VM.** Puck's `util/recorder.rb` records tokenizing,
parsing and compiling, not running, so an execution recorder would still have to be written.
Each demo would also become a fixed recording that can't be edited in the page.

### Why not simpler

1. Do nothing: `run.rb` already steps Puck in a terminal, but it has no stack view and doesn't run in a browser.
2. Link to `run.rb` from forty's README: same gap.
3. Replay Ruby traces (C): needs a new recorder anyway, and loses live editing.
4. Run Puck on forty's VM (A): impossible without a stack and a heap.
5. Port only Puck v4 (stage 1): the smallest version that recurses. This is the starting point.
6. Port all of v9 and mirror all nine versions: the biggest. Defer it until stage 1 has proven out.

---

## Design (option B)

### Files

`puck/` in this repo, beside `v0/`..`v6/`: `compiler.js`, `vm.js`, `visualizer.js` (feature
config, as each version's is now), `index.html`, `test.js`, and `README.md`. One port that
grows from v4's language to v9's. There's no copy per Puck version: Puck's own READMEs already teach those steps.

### Compiler

Port Ruby v4's tokenizer, parser and compiler, with three changes the page needs:

- **Line numbers.** The tokenizer records each token's line, as forty's does. The compiler keeps
  an `ipMap` (instruction to source line) and `emit`/`patch` events for the compile walk.
- **One flat code array.** Ruby keeps one array per procedure. Here each procedure starts at an
  offset in a single array, and `CALL` carries that offset. The visualizer then has one listing
  and one `ip`, as it has now, and the printed output is unchanged.
- **Local names.** The compiler's per-procedure name-to-slot table goes into the output, so the
  stack panel can label `n` instead of `slot 0`.

### VM

Frames become data: `frames = [{ proc, ret, locals, stack }]`. `CALL` pushes a frame, and
`RETURN` pops it and pushes the result onto the caller's stack. The VM keeps forty's
interface (`step`, `stepBack`, `reset`, `getState`, with history snapshots), so the
shared `stepper`, Next and Previous, `marks`, `haltLine`, the compile walk and the printer
paper all work unchanged. A snapshot copies the frames; stage 2 adds the heap. Tests run
without history, as forty's `instructionCycles` does.

System calls in the page: print goes to the printer; time returns the step count; exit halts.
Stdin, files and argv have no browser equivalent, so they stop with an error, and the tests
can supply them.

### Visualizer

- **One visualizer, not a second one.** Two visualizers would recreate the copies the shared one
  removed. Instead, a `stack` feature replaces MEMORY with a CALL STACK panel, and the effect and
  hover text gets a third instruction set (Puck's), as v6's 704 set was added.
- **Panel split.** This needs `render` split so the memory grid is a panel of its own. Today it's
  inline in `render`, so this is the one change that touches v0-v6.
- **CALL STACK.** One card per frame, newest on top. Each card shows the procedure's name,
  its named locals and its operand stack. The running frame is highlighted, and the
  caller's return point links to its bytecode row. With deep recursion, the middle frames
  fold into "... 6 more fib frames". Stage 2 adds a HEAP panel: each array with its
  refcount, and a ref value on the stack highlights the array it points at.
- **The contrast with forty.** forty's FORTRAN has no recursion because every variable has
  one fixed cell. `fib` makes a frame per call, and the panel shows that directly.

### Production scoping

| Piece | Lines (estimate) | Basis | Stage |
| --- | --- | --- | --- |
| Tokenizer, parser (v4 language) | ~200 | Ruby 231 | 1 |
| Compiler (+ lines, flat code, names) | ~130 | Ruby 108 | 1 |
| VM with explicit frames and history | ~110 | Ruby 75 | 1 |
| Visualizer: panel split, CALL STACK, Puck text | ~200 | none to scale from; forty's panels are 20-60 lines each | 1 |
| Parser v5-v9 additions | ~220 | Ruby 250 | 2 |
| Macro expander | ~150 | Ruby 168 | 2 |
| Compiler v5-v9 additions | ~220 | Ruby 242 | 2 |
| VM: heap, refcounts, arrays, system calls | ~150 | Ruby 136 | 2 |
| HEAP panel | ~100 | none | 2 |

---

## Work the proposal would otherwise hide

- Building the golden suite from Ruby output (~20 programs), and keeping it current if Puck changes in `~/dev/clear`.
- The four semantics traps above, each with a test.
- The `render` split touches every version's page: re-run v0-v6's 117 tests and check each page in a browser.
- Undo for a heap: snapshotting the heap every step is fine for demos and too slow for `core-test.puck` (tests run without history).
- `core.puck`'s 541 lines are parsed on every compile in the page. This is fast enough for a click, but should be measured once stage 2 lands.
- READMEs in Puck's style for each stage.

## Decisions for you

1. **Where it lives.** `puck/` in forty (recommended: it uses forty's visualizer), or `examples/puck/web` in clear.
2. **One port or nine versions.** One port growing from v4 to v9 (recommended), or a JavaScript copy of each Puck version, as forty's v0-v6 are.
