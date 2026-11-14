# forty

A barebones implementation of old-school FORTRAN (pre-heap) written in JavaScript for browser visualizations.

Live demo: https://cuzzo.github.io/forty/v3

## Versions
| Version | What it adds | Lines added |
|---|---|---|
| [v0](v0/) | Minimal Compiler | ~220 SLoC |
| [v1](v1/) | Adds instruction visualization | ~8 SLoC |
| [v2](v2/) | Adds the "drum" (ancient hard drive) | ~15 SLoC |
| [v3](v3/) | Adds the "tape" (bigger, worse hard drive) | ~10 SLoC |
| [v4](v4/) | Adds a RISC-V backend | ~30 SLoC |
| [v5](v5/) | Adds index registers and punched cards | ~40 SLoC |
| [v6](v6/) | Adds the accumulator and MQ (one-address code) | ~50 SLoC |

The IBM 704's timings (instruction cycles, drum, tape and card punch speeds) are set once, in [machine.js](machine.js), for every version that counts time.

Every version's page is the same visualizer, [visualizer.js](visualizer.js). Each `vN/visualizer.js` only names that version's compiler, VM, memory size and the features it has covered so far.

The minimal compiler assumes knowledge of how tokenizing and machine code works.

For an example of how that works, see [Puck](https://github.com/cuzzo/clear/tree/master/examples/puck/README.md), which starts at ~80 SLoC, and has 10 versions of its own.

## Files

- `machine.js` — the IBM 704's timings, shared by every version that counts time.
- `visualizer.js`, `visualizer.css` — the page every version uses.
- `vN/compiler.js`, `vN/vm.js` — each version's compiler and VM. `vN/visualizer.js` names the version's features, `vN/index.html` loads its page, and `vN/test.js` holds its tests.

## Run in Browser

Serve the directory over HTTP (required for ES modules) and open a version's `index.html`, e.g. `v3/index.html`:

```sh
python3 -m http.server 8000
```

## Run Tests

```sh
npm test
```
