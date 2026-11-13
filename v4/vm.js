const ALU = {
  '+':  (x, y) => (x + y) | 0,
  '-':  (x, y) => (x - y) | 0,
  '*':  (x, y) => Math.imul(x, y),
  '/':  (x, y) => (x === -2147483648 && y === -1) ? -2147483648 : ((x / y) | 0),
  '==': (x, y) => +(x === y),
  '!=': (x, y) => +(x !== y),
  '<':  (x, y) => +(x < y),
  '>':  (x, y) => +(x > y),
  '<=': (x, y) => +(x <= y),
  '>=': (x, y) => +(x >= y),
};

const CODE_BASE = 0x00400000;

const REG_NAMES = {
  zero: 0, ra: 1, sp: 2, gp: 3, tp: 4,
  t0: 5, t1: 6, t2: 7, s0: 8, fp: 8, s1: 9,
  a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a5: 15, a6: 16, a7: 17,
};

function regIndex(name) {
  if (name in REG_NAMES) return REG_NAMES[name];
  if (/^x\d+$/.test(name)) {
    const idx = Number(name.slice(1));
    if (idx >= 0 && idx < 32) return idx;
  }
  throw new Error(`Unknown RISC-V register '${name}'`);
}

function createHardware(initMem, options) {
  const {
    debug = null,
    protectRodata = false,
    initTape = [],
    initTapes = null,
    initDrum = null,
    drumTracks = 8,
    drumSectors = 8,
    sectorWords = 8,
    cyclesPerSector = 4,
    maxHistory = 10000,
  } = options;

  const drumSize = drumTracks * drumSectors * sectorWords;
  const hw = {
    MEM: new Int32Array(initMem),
    drum: new Int32Array(drumSize),
    tapes: [0, 1, 2, 3].map((u) => Array.from(initTapes?.[u] ?? (u === 0 ? initTape : []), (x) => x | 0)),
    tapeHeads: new Int32Array(4),
    stdout: [],
    history: [],
    cycles: 0,
    halted: false,
    trap: null,
  };

  if (initDrum) hw.drum.set(initDrum.subarray ? initDrum.subarray(0, drumSize) : initDrum.slice(0, drumSize));

  const drumAngle = () => Math.floor(hw.cycles / cyclesPerSector) % drumSectors;

  function fail(code, message) {
    hw.trap = { code, message };
    hw.halted = true;
    return false;
  }

  function checkAddr(addr, isWrite = false) {
    if (addr < 0 || addr >= hw.MEM.length) {
      return fail('TRAP_OOB_MEM', `Memory address ${addr} out of bounds (0..${hw.MEM.length - 1})`);
    }
    if (isWrite && protectRodata && debug?.cells[addr]?.role === 'rodata') {
      return fail('TRAP_RODATA_WRITE_FAULT', `Illegal write to read-only constant cell MEM[${addr}]`);
    }
    return true;
  }

  function writeCell(addr, val, ev) {
    if (!checkAddr(addr, true)) return false;
    ev.writes.push(addr);
    if (!(addr in ev.prevValues)) ev.prevValues[addr] = hw.MEM[addr];
    hw.MEM[addr] = val | 0;
    ev.newValues[addr] = hw.MEM[addr];
    return true;
  }

  function checkTapeUnit(unit) {
    if (unit < 0 || unit >= hw.tapes.length) {
      return fail('TRAP_BAD_TAPE_UNIT', `Invalid tape unit ${unit} (0..${hw.tapes.length - 1})`);
    }
    return true;
  }

  function readTape(unit, hasEof, ev) {
    if (!checkTapeUnit(unit)) return null;
    const t = hw.tapes[unit];
    const head = hw.tapeHeads[unit];
    if (head >= t.length) {
      if (!hasEof) {
        fail('TRAP_TAPE_EOF', `Tape unit ${unit} read past EOF at position ${head}`);
        return null;
      }
      ev.tape = { action: 'eof', unit, pos: head, value: null };
      return { val: 0, eof: 1 };
    }
    const val = t[head];
    hw.tapeHeads[unit] = head + 1;
    ev.tape = { action: 'read', unit, pos: head, value: val };
    return { val, eof: 0 };
  }

  function writeTape(unit, val, ev, snap) {
    if (!checkTapeUnit(unit)) return false;
    const t = hw.tapes[unit];
    const head = hw.tapeHeads[unit];
    if (head < t.length) snap.tapePrev = { unit, pos: head, val: t[head] };
    t[head] = val | 0;
    hw.tapeHeads[unit] = head + 1;
    ev.tape = { action: 'write', unit, pos: head, value: val | 0 };
    return true;
  }

  function rewindTape(unit, ev) {
    if (!checkTapeUnit(unit)) return false;
    ev.tape = { action: 'rewind', unit, from: hw.tapeHeads[unit], to: 0 };
    hw.tapeHeads[unit] = 0;
    return true;
  }

  function dmaDrum(isRead, ramAddr, trk, sec, ev, snap) {
    if (trk < 0 || trk >= drumTracks || sec < 0 || sec >= drumSectors) {
      fail('TRAP_OOB_DRUM', `Invalid drum coordinates (track=${trk}, sector=${sec})`);
      return 0;
    }
    if (!checkAddr(ramAddr, isRead) || !checkAddr(ramAddr + sectorWords - 1, isRead)) return 0;

    const waitSectors = (sec - drumAngle() + drumSectors) % drumSectors;
    const stallCycles = waitSectors * cyclesPerSector;
    const offset = (trk * drumSectors + sec) * sectorWords;

    if (isRead) {
      for (let i = 0; i < sectorWords; i++) {
        if (!writeCell(ramAddr + i, hw.drum[offset + i], ev)) return 0;
      }
    } else {
      snap.drumPrev = { offset, data: hw.drum.slice(offset, offset + sectorWords) };
      for (let i = 0; i < sectorWords; i++) {
        if (!checkAddr(ramAddr + i, false)) return 0;
        ev.reads.push(ramAddr + i);
        hw.drum[offset + i] = hw.MEM[ramAddr + i];
      }
    }

    ev.drum = {
      op: isRead ? 'DRUM_READ' : 'DRUM_WRITE',
      track: trk, sector: sec, ramAddr, words: sectorWords, waitSectors, stallCycles,
    };
    return stallCycles + 1;
  }

  function pushSnapshot(ip, regs = null) {
    const snap = {
      ip,
      mem: hw.MEM.slice(),
      stdoutLen: hw.stdout.length,
      tapeHeads: hw.tapeHeads.slice(),
      tapeLens: hw.tapes.map((t) => t.length),
      tapePrev: null,
      drumPrev: null,
      cycles: hw.cycles,
      regs,
    };
    if (hw.history.length >= maxHistory) hw.history.shift();
    hw.history.push(snap);
    return snap;
  }

  function popSnapshot() {
    const snap = hw.history.pop();
    if (!snap) return null;
    hw.MEM.set(snap.mem);
    hw.stdout.length = snap.stdoutLen;
    if (snap.tapePrev) hw.tapes[snap.tapePrev.unit][snap.tapePrev.pos] = snap.tapePrev.val;
    snap.tapeLens.forEach((len, u) => { hw.tapes[u].length = len; });
    hw.tapeHeads.set(snap.tapeHeads);
    if (snap.drumPrev) hw.drum.set(snap.drumPrev.data, snap.drumPrev.offset);
    hw.cycles = snap.cycles;
    hw.halted = false;
    hw.trap = null;
    return snap;
  }

  function resetHardware() {
    hw.MEM.set(initMem);
    hw.drum.fill(0);
    if (initDrum) hw.drum.set(initDrum.subarray ? initDrum.subarray(0, drumSize) : initDrum.slice(0, drumSize));
    for (let u = 0; u < 4; u++) {
      const src = initTapes?.[u] ?? (u === 0 ? initTape : []);
      hw.tapes[u].length = 0;
      for (const x of src) hw.tapes[u].push(x | 0);
      hw.tapeHeads[u] = 0;
    }
    hw.cycles = 0;
    hw.stdout.length = 0;
    hw.history.length = 0;
    hw.halted = false;
    hw.trap = null;
  }

  return {
    hw, drumAngle, fail, checkAddr, writeCell,
    readTape, writeTape, rewindTape, dmaDrum,
    pushSnapshot, popSnapshot, resetHardware,
  };
}

function attachRunControls(stepFn, stepBackFn, resetFn, getStateFn, hw) {
  function seek(targetStep) {
    const goal = Math.max(0, targetStep | 0);
    while (hw.history.length > goal) {
      if (!stepBackFn()) break;
    }
    while (hw.history.length < goal && !hw.halted) {
      stepFn();
    }
    return getStateFn();
  }

  function runSlice(budget = 1000) {
    let last = null;
    for (let i = 0; i < budget && !hw.halted; i++) {
      last = stepFn();
    }
    return last ?? getStateFn();
  }

  return { step: stepFn, stepBack: stepBackFn, reset: resetFn, seek, runSlice, getState: getStateFn };
}

export function createVM(code, initMem, options = {}) {
  const ops = createHardware(initMem, options);
  const { hw, drumAngle, fail, checkAddr, writeCell, readTape, writeTape, rewindTape, dmaDrum, pushSnapshot, popSnapshot, resetHardware } = ops;

  let ip = 0;
  hw.halted = code.length === 0;

  function stateView(extra = {}) {
    return {
      ip,
      halted: hw.halted,
      trap: hw.trap,
      MEM: hw.MEM,
      stdout: hw.stdout,
      tape: hw.tapes[0],
      tapeHead: hw.tapeHeads[0],
      tapes: hw.tapes,
      tapeHeads: hw.tapeHeads,
      drum: hw.drum,
      cycles: hw.cycles,
      drumAngle: drumAngle(),
      steps: hw.history.length,
      ...extra,
    };
  }

  function step() {
    if (hw.halted || ip >= code.length) {
      hw.halted = true;
      return stateView();
    }

    const snap = pushSnapshot(ip);
    const pc = ip;
    const [op, a, b, c] = code[ip++];
    let stepCycles = 1;

    const ev = {
      stepIndex: hw.history.length - 1,
      pc,
      nextIp: ip,
      op,
      args: [a, b, c],
      reads: [],
      writes: [],
      prevValues: {},
      newValues: {},
      deref: null,
      branchTaken: null,
      printVal: null,
      tape: null,
      drum: null,
      cycles: 0,
      trap: null,
    };

    if (op === 'MOV') {
      if (checkAddr(b)) { ev.reads.push(b); writeCell(a, hw.MEM[b], ev); }
    } else if (op === 'LOAD_IND') {
      if (checkAddr(b)) {
        const target = hw.MEM[b];
        ev.reads.push(b);
        ev.deref = { ptrCell: b, targetAddr: target, access: 'read' };
        if (checkAddr(target)) { ev.reads.push(target); writeCell(a, hw.MEM[target], ev); }
      }
    } else if (op === 'STORE_IND') {
      if (checkAddr(a) && checkAddr(b)) {
        const target = hw.MEM[a];
        ev.reads.push(a, b);
        ev.deref = { ptrCell: a, targetAddr: target, access: 'write' };
        writeCell(target, hw.MEM[b], ev);
      }
    } else if (op === 'PRINT') {
      if (checkAddr(a)) { ev.reads.push(a); ev.printVal = hw.MEM[a]; hw.stdout.push(hw.MEM[a]); }
    } else if (op === 'TAPE_READ') {
      if (checkAddr(b)) {
        ev.reads.push(b);
        const res = readTape(hw.MEM[b], c >= 0, ev);
        if (res) {
          const ok = c >= 0 ? writeCell(c, res.eof, ev) : true;
          if (ok) writeCell(a, res.val, ev);
        }
      }
    } else if (op === 'TAPE_WRITE') {
      if (checkAddr(a) && checkAddr(b)) {
        ev.reads.push(a, b);
        writeTape(hw.MEM[b], hw.MEM[a], ev, snap);
      }
    } else if (op === 'TAPE_REWIND') {
      if (checkAddr(a)) { ev.reads.push(a); rewindTape(hw.MEM[a], ev); }
    } else if (op === 'DRUM_READ' || op === 'DRUM_WRITE') {
      if (checkAddr(a) && checkAddr(b) && checkAddr(c)) {
        ev.reads.push(a, b, c);
        const ramAddr = hw.MEM[a];
        const isRead = op === 'DRUM_READ';
        ev.deref = { ptrCell: a, targetAddr: ramAddr, access: isRead ? 'write' : 'read' };
        const usedCycles = dmaDrum(isRead, ramAddr, hw.MEM[b], hw.MEM[c], ev, snap);
        if (usedCycles > 0) stepCycles = usedCycles;
      }
    } else if (op === 'JMP') {
      ip = a;
    } else if (op === 'JAL') {
      if (writeCell(a, ip, ev)) ip = b;
    } else if (op === 'JMP_IND') {
      if (checkAddr(a)) { ev.reads.push(a); ip = hw.MEM[a]; }
    } else if (op === 'JZ') {
      if (checkAddr(b)) {
        ev.reads.push(b);
        ev.branchTaken = hw.MEM[b] === 0;
        if (ev.branchTaken) ip = a;
      }
    } else if (op in ALU) {
      if (checkAddr(b) && checkAddr(c)) {
        ev.reads.push(b, c);
        if (op === '/' && hw.MEM[c] === 0) {
          fail('TRAP_DIV_ZERO', `Division by zero at instruction ${pc}`);
        } else {
          writeCell(a, ALU[op](hw.MEM[b], hw.MEM[c]), ev);
        }
      }
    } else {
      fail('TRAP_ILLEGAL_OP', `Unknown opcode '${op}'`);
    }

    if (!hw.trap) hw.cycles += stepCycles;
    if (!hw.trap && (ip < 0 || ip > code.length)) {
      fail('TRAP_BAD_IP', `Instruction pointer ${ip} jumped outside valid code (0..${code.length})`);
    }
    if (ip === code.length) hw.halted = true;

    ev.cycles = hw.cycles;
    ev.nextIp = ip;
    ev.trap = hw.trap;
    return stateView({ event: ev });
  }

  function stepBack() {
    const snap = popSnapshot();
    if (!snap) return false;
    ip = snap.ip;
    return true;
  }

  function reset() {
    resetHardware();
    ip = 0;
    hw.halted = code.length === 0;
  }

  return attachRunControls(step, stepBack, reset, () => stateView(), hw);
}

function parseRiscv(asmText) {
  const instrs = [];
  const labels = Object.create(null);

  for (const rawLine of asmText.split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line || line === '.data' || line === '.text' || line.startsWith('.globl') || line.startsWith('MEM:')) continue;
    if (line.endsWith(':')) {
      labels[line.slice(0, -1)] = instrs.length;
      continue;
    }
    const spaceIdx = line.search(/\s/);
    const op = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim();
    const args = rest ? rest.split(',').map((s) => s.trim()) : [];
    instrs.push({ op, args, text: line });
  }

  return { instrs, labels };
}

function parseMemOperand(operand) {
  const m = /^(-?\d+)\((\w+)\)$/.exec(operand);
  if (!m) throw new Error(`Invalid memory operand '${operand}'`);
  return { imm: Number(m[1]), rs1: regIndex(m[2]) };
}

export function createRiscvVM(asmText, initMem, options = {}) {
  const { instrs, labels } = parseRiscv(asmText);
  const ops = createHardware(initMem, options);
  const { hw, drumAngle, fail, checkAddr, readTape, writeTape, rewindTape, dmaDrum, pushSnapshot, popSnapshot, resetHardware } = ops;

  const regs = new Int32Array(32);
  const view = new DataView(hw.MEM.buffer);
  let ip = labels.main ?? 0;
  hw.halted = instrs.length === 0;

  function stateView(extra = {}) {
    return {
      ip,
      halted: hw.halted,
      trap: hw.trap,
      MEM: hw.MEM,
      regs,
      instrs,
      stdout: hw.stdout,
      tape: hw.tapes[0],
      tapeHead: hw.tapeHeads[0],
      tapes: hw.tapes,
      tapeHeads: hw.tapeHeads,
      drum: hw.drum,
      cycles: hw.cycles,
      drumAngle: drumAngle(),
      steps: hw.history.length,
      ...extra,
    };
  }

  function step() {
    if (hw.halted || ip >= instrs.length) {
      hw.halted = true;
      return stateView();
    }

    const snap = pushSnapshot(ip, regs.slice());
    const pc = ip;
    const { op, args, text } = instrs[ip++];
    let stepCycles = 1;

    const ev = {
      stepIndex: hw.history.length - 1,
      pc,
      nextIp: ip,
      op,
      args,
      text,
      reads: [],
      writes: [],
      prevValues: {},
      newValues: {},
      deref: null,
      branchTaken: null,
      printVal: null,
      tape: null,
      drum: null,
      cycles: 0,
      trap: null,
    };

    if (op === 'la') {
      const rd = regIndex(args[0]);
      const lbl = args[1];
      regs[rd] = lbl === 'MEM' ? 0 : CODE_BASE + labels[lbl] * 4;
    } else if (op === 'li') {
      regs[regIndex(args[0])] = Number(args[1]) | 0;
    } else if (op === 'lw') {
      const rd = regIndex(args[0]);
      const { imm, rs1 } = parseMemOperand(args[1]);
      const byteAddr = (regs[rs1] + imm) | 0;
      const cell = byteAddr >> 2;
      if ((byteAddr & 3) !== 0) {
        fail('TRAP_OOB_MEM', `Unaligned lw byte address ${byteAddr}`);
      } else if (checkAddr(cell, false)) {
        ev.reads.push(cell);
        if (rs1 !== 8) ev.deref = { ptrCell: null, targetAddr: cell, access: 'read' };
        regs[rd] = view.getInt32(byteAddr, true);
      }
    } else if (op === 'sw') {
      const rs2 = regIndex(args[0]);
      const { imm, rs1 } = parseMemOperand(args[1]);
      const byteAddr = (regs[rs1] + imm) | 0;
      const cell = byteAddr >> 2;
      if ((byteAddr & 3) !== 0) {
        fail('TRAP_OOB_MEM', `Unaligned sw byte address ${byteAddr}`);
      } else if (checkAddr(cell, true)) {
        ev.writes.push(cell);
        ev.prevValues[cell] = hw.MEM[cell];
        if (rs1 !== 8) ev.deref = { ptrCell: null, targetAddr: cell, access: 'write' };
        view.setInt32(byteAddr, regs[rs2], true);
        ev.newValues[cell] = hw.MEM[cell];
      }
    } else if (op === 'slli') {
      regs[regIndex(args[0])] = regs[regIndex(args[1])] << Number(args[2]);
    } else if (op === 'add') {
      regs[regIndex(args[0])] = (regs[regIndex(args[1])] + regs[regIndex(args[2])]) | 0;
    } else if (op === 'sub') {
      regs[regIndex(args[0])] = (regs[regIndex(args[1])] - regs[regIndex(args[2])]) | 0;
    } else if (op === 'mul') {
      regs[regIndex(args[0])] = Math.imul(regs[regIndex(args[1])], regs[regIndex(args[2])]);
    } else if (op === 'div') {
      const d = regs[regIndex(args[2])];
      if (d === 0) fail('TRAP_DIV_ZERO', `Division by zero at RV32IM instruction ${pc}`);
      else regs[regIndex(args[0])] = ALU['/'](regs[regIndex(args[1])], d);
    } else if (op === 'slt') {
      regs[regIndex(args[0])] = regs[regIndex(args[1])] < regs[regIndex(args[2])] ? 1 : 0;
    } else if (op === 'xori') {
      regs[regIndex(args[0])] = regs[regIndex(args[1])] ^ Number(args[2]);
    } else if (op === 'seqz') {
      regs[regIndex(args[0])] = regs[regIndex(args[1])] === 0 ? 1 : 0;
    } else if (op === 'snez') {
      regs[regIndex(args[0])] = regs[regIndex(args[1])] !== 0 ? 1 : 0;
    } else if (op === 'beqz') {
      ev.branchTaken = regs[regIndex(args[0])] === 0;
      if (ev.branchTaken) ip = labels[args[1]];
    } else if (op === 'j') {
      ip = labels[args[0]];
    } else if (op === 'jr') {
      const target = regs[regIndex(args[0])];
      const rel = target - CODE_BASE;
      if ((rel & 3) !== 0 || rel < 0 || (rel >> 2) > instrs.length) {
        fail('TRAP_BAD_IP', `Invalid jr target address 0x${(target >>> 0).toString(16)}`);
      } else {
        ip = rel >> 2;
      }
    } else if (op === 'ecall') {
      const sys = regs[17];
      if (sys === 1) {
        ev.printVal = regs[10];
        hw.stdout.push(regs[10]);
      } else if (sys === 10) {
        hw.halted = true;
      } else if (sys === 20) {
        const res = readTape(regs[12], regs[13] !== 0, ev);
        if (res) { regs[10] = res.val; regs[11] = res.eof; }
      } else if (sys === 21) {
        writeTape(regs[11], regs[10], ev, snap);
      } else if (sys === 22) {
        rewindTape(regs[11], ev);
      } else if (sys === 23 || sys === 24) {
        const ramAddr = regs[10] >> 2;
        const usedCycles = dmaDrum(sys === 23, ramAddr, regs[11], regs[12], ev, snap);
        if (usedCycles > 0) stepCycles = usedCycles;
      }
    } else {
      fail('TRAP_ILLEGAL_OP', `Unknown RV32IM instruction '${op}'`);
    }

    regs[0] = 0;
    if (!hw.trap) hw.cycles += stepCycles;
    if (ip >= instrs.length) hw.halted = true;

    ev.cycles = hw.cycles;
    ev.nextIp = ip;
    ev.trap = hw.trap;
    return stateView({ event: ev });
  }

  function stepBack() {
    const snap = popSnapshot();
    if (!snap) return false;
    regs.set(snap.regs);
    ip = snap.ip;
    return true;
  }

  function reset() {
    resetHardware();
    regs.fill(0);
    ip = labels.main ?? 0;
    hw.halted = instrs.length === 0;
  }

  return attachRunControls(step, stepBack, reset, () => stateView(), hw);
}
