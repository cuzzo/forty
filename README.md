# forty

Browser-native flat-RAM Fortran compiler, virtual machine, RV32IM micro-core, and interactive visualizer in zero-dependency JavaScript.

## Files

- `compiler.js` — Single-pass compiler (`tokenize`, `compile`, `emitRiscv`) targeting flat 4-tuple instructions and RV32IM assembly, with sidecar debug/backpatching metadata.
- `vm.js` — Time-travel flat-RAM VM (`createVM`) and shared-buffer RV32IM micro-core (`createRiscvVM`) with hardware traps, 4 magnetic tape drives, rotating magnetic drum DMA, stack/heap (`STACK`, `NEW`, `FREE`), and semi-space copying GC.
- `visualizer.js` — Browser visualizer rendering the segmented flat-RAM tape, SVG pointer-deref arcs, backpatching time-lapse scrubber, 2D column-major matrix views, peripherals, and RV32IM registers.
- `index.html` — Browser entrypoint loading `visualizer.js`.
- `test.js` — Node test suite verifying compiler, VM, RISC-V parity, traps, peripherals, and GC.

## Run in Browser

Serve the directory over HTTP (required for ES modules) and open `index.html`:

```sh
python3 -m http.server 8000
```

## Run Tests

```sh
npm test
```
