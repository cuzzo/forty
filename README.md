# forty

Browser-native pre-heap static-RAM Fortran compiler, virtual machine, RV32IM micro-core, and interactive visualizer in zero-dependency JavaScript.

Live demo: https://cuzzo.github.io/forty/

## Files

- `compiler.js` — Single-pass compiler (`tokenize`, `compile`, `emitRiscv`) targeting flat 4-tuple instructions and RV32IM assembly, with sidecar debug/backpatching metadata.
- `vm.js` — Time-travel flat-RAM VM (`createVM`) and shared-`ArrayBuffer` RV32IM micro-core (`createRiscvVM`) with hardware traps, 4 magnetic tape drives, and rotating magnetic drum DMA.
- `visualizer.js` — Browser visualizer rendering the segmented flat-RAM tape, SVG pointer-deref arcs, backpatching time-lapse scrubber, 2D column-major matrix views, peripherals, and RV32IM registers.
- `index.html` — Browser entrypoint loading `visualizer.js`.
- `test.js` — Node test suite verifying compiler, VM, RISC-V parity, traps, and peripherals.

## Run in Browser

Serve the directory over HTTP (required for ES modules) and open `index.html`:

```sh
python3 -m http.server 8000
```

## Run Tests

```sh
npm test
```
