// ---------------------------------------------------------------------------
// Device layer (Phase 3, client side).
// ---------------------------------------------------------------------------
// Talks to real sensors over Web Bluetooth using the standard GATT profiles:
//   - Fitness Machine Service (0x1826)  smart trainer: power, cadence AND
//                                       resistance control (ERG target watts)
//   - Cycling Power Service   (0x1818)  power meter: power + cadence
//   - Heart Rate Service      (0x180D)  heart-rate strap
// ANT+ is not exposed to browsers; an ANT+ bridge forwarding the same reading
// shape drops in without changing the rest of the app.
//
// Every source is an EventTarget emitting
//   `reading` { power?, hr?, cadence? }
//   `status`  { status, detail }   status: connecting | connected | reconnecting
//                                           | disconnected | failed
//
// Stability: once a device is paired, a dropped link is re-opened automatically
// (same device object, so no new pairing dialog) with back-off, GATT operations
// are serialised, and connect attempts time out instead of hanging.
// ---------------------------------------------------------------------------

const SVC = { power: 0x1818, hr: 0x180d, ftms: 0x1826 };
const CHR = {
  powerMeasurement: 0x2a63,
  hrMeasurement: 0x2a37,
  indoorBikeData: 0x2ad2,
  controlPoint: 0x2ad9,
  powerRange: 0x2ad8,
};

// Web Bluetooth exists in Chromium browsers (Chrome, Edge, Opera, Brave) only,
// and only in a secure context (https:// or http://localhost).
export function bluetoothSupport() {
  if (!('bluetooth' in navigator)) {
    const ua = navigator.userAgent;
    const browser = /firefox/i.test(ua) ? 'Firefox' : /safari/i.test(ua) && !/chrome|chromium|edg/i.test(ua) ? 'Safari' : 'This browser';
    return {
      supported: false,
      reason: `${browser} does not support Web Bluetooth. Open this page in Chrome or Edge to pair devices (the Demo trainer still works).`,
    };
  }
  if (!window.isSecureContext) {
    return { supported: false, reason: 'Web Bluetooth needs a secure page: open the app via http://localhost or https://.' };
  }
  return { supported: true, reason: '' };
}

let nextId = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

export class DeviceSource extends EventTarget {
  constructor(kind) {
    super();
    this.kind = kind; // 'trainer' | 'power' | 'hr' | 'sim'
    this.id = `${kind}-${nextId++}`;
    this.name = '';
    this.status = 'disconnected';
    this.detail = '';
    this.controllable = false;
  }

  emit(reading) {
    this.dispatchEvent(new CustomEvent('reading', { detail: reading }));
  }

  setStatus(status, detail = this.detail) {
    this.status = status;
    this.detail = detail;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, detail } }));
  }

  get connected() {
    return this.status === 'connected';
  }

  describe() {
    return { id: this.id, kind: this.kind, name: this.name, status: this.status, controllable: this.controllable, detail: this.detail };
  }
}

// ---------------------------------------------------------------------------
// Shared Bluetooth plumbing: pairing, retrying connect, automatic reconnect.
// ---------------------------------------------------------------------------
class BluetoothSource extends DeviceSource {
  constructor(kind, filters, optionalServices = []) {
    super(kind);
    this._filters = filters;
    this._optional = optionalServices;
    this._device = null;
    this._closing = false;
    this._recovering = false;
  }

  // Must be called from a user gesture (it opens the browser's device chooser).
  async pair() {
    const support = bluetoothSupport();
    if (!support.supported) throw new Error(support.reason);
    this.setStatus('connecting', 'choose a device…');
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({ filters: this._filters, optionalServices: this._optional });
    } catch (err) {
      this.setStatus('disconnected', '');
      if (err.name === 'NotFoundError') throw new Error('Pairing cancelled');
      throw err;
    }
    // Let the app veto a device that is already paired to another rider.
    const veto = this.acceptDevice?.(device);
    if (veto) {
      this.setStatus('disconnected', '');
      throw new Error(veto);
    }
    this._device = device;
    this.bluetoothId = device.id;
    this.name = device.name || this.kind;
    device.addEventListener('gattserverdisconnected', () => this._onDropped());

    this.setStatus('connecting', 'connecting…');
    try {
      await this._openWithRetries(3);
    } catch (err) {
      this.setStatus('failed', err.message);
      throw new Error(`${this.name}: ${err.message}`);
    }
  }

  async _openWithRetries(attempts) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        await this._open();
        return;
      } catch (err) {
        lastErr = err;
        try {
          this._device.gatt.disconnect();
        } catch {
          /* ignore */
        }
        if (this._closing) break;
        await sleep(800 * (i + 1));
      }
    }
    throw lastErr;
  }

  async _open() {
    const server = await withTimeout(this._device.gatt.connect(), 12000, 'Connecting');
    await withTimeout(this._setup(server), 15000, 'Setting up the device');
    this.setStatus('connected', this._connectedDetail());
  }

  _connectedDetail() {
    return '';
  }

  _onDropped() {
    if (this._closing || this._recovering) return;
    this._recover();
  }

  // Re-open a dropped link with growing delays; give up after ~2 minutes and
  // leave a "failed" device the user can retry with one click.
  async _recover() {
    this._recovering = true;
    const delays = [500, 1000, 2000, 3000, 5000, 5000, 8000, 8000, 10000, 10000, 15000, 15000];
    try {
      for (let i = 0; i < delays.length && !this._closing; i++) {
        this.setStatus('reconnecting', `retry ${i + 1}/${delays.length}`);
        await sleep(delays[i]);
        if (this._closing) return;
        try {
          await this._open();
          return;
        } catch {
          try {
            this._device.gatt.disconnect();
          } catch {
            /* ignore */
          }
        }
      }
      if (!this._closing) this.setStatus('failed', 'connection lost');
    } finally {
      this._recovering = false;
    }
  }

  // Manual "retry" after a failure.
  async reconnect() {
    if (!this._device || this._recovering) return;
    this._closing = false;
    this._recovering = true;
    this.setStatus('connecting', 'reconnecting…');
    try {
      await this._openWithRetries(3);
    } catch (err) {
      this.setStatus('failed', err.message);
      throw err;
    } finally {
      this._recovering = false;
    }
  }

  async disconnect() {
    this._closing = true;
    try {
      this._device?.gatt?.disconnect();
    } catch {
      /* ignore */
    }
    this.setStatus('disconnected', '');
  }

  async _notify(service, uuid, handler) {
    const ch = await service.getCharacteristic(uuid);
    await ch.startNotifications();
    ch.addEventListener('characteristicvaluechanged', (e) => handler(e.target.value));
    return ch;
  }
}

// --- Heart-rate strap -------------------------------------------------------
export class HeartRateMonitor extends BluetoothSource {
  constructor() {
    super('hr', [{ services: [SVC.hr] }]);
  }

  async _setup(server) {
    const service = await server.getPrimaryService(SVC.hr);
    await this._notify(service, CHR.hrMeasurement, (dv) => {
      // flags(uint8): bit0 = value format (0: uint8, 1: uint16)
      const hr = dv.getUint8(0) & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
      if (hr > 0) this.emit({ hr });
    });
  }
}

// --- Power meter (Cycling Power Service) -----------------------------------
export class PowerMeter extends BluetoothSource {
  constructor() {
    super('power', [{ services: [SVC.power] }]);
    this._crank = null;
  }

  async _setup(server) {
    this._crank = null;
    const service = await server.getPrimaryService(SVC.power);
    await this._notify(service, CHR.powerMeasurement, (dv) => this._onValue(dv));
  }

  _onValue(dv) {
    // flags(uint16 LE), instantaneous power(sint16 LE), then optional fields.
    const flags = dv.getUint16(0, true);
    const reading = { power: dv.getInt16(2, true) };
    let offset = 4;
    if (flags & 0x01) offset += 1; // pedal power balance
    if (flags & 0x04) offset += 2; // accumulated torque
    if (flags & 0x10) offset += 6; // wheel revolution data
    if (flags & 0x20) {
      const cad = crankCadence(this, dv.getUint16(offset, true), dv.getUint16(offset + 2, true));
      if (cad !== null) reading.cadence = cad;
    }
    this.emit(reading);
  }
}

function crankCadence(src, revs, time) {
  // revs: cumulative crank revolutions; time: last crank event in 1/1024 s.
  let cadence = null;
  if (src._crank) {
    let dRev = revs - src._crank.revs;
    let dT = time - src._crank.time;
    if (dRev < 0) dRev += 0x10000;
    if (dT < 0) dT += 0x10000;
    if (dT > 0) cadence = Math.round((dRev * 1024 * 60) / dT);
  }
  src._crank = { revs, time };
  return cadence;
}

// --- Smart trainer (Fitness Machine Service) --------------------------------
// Reads power/cadence and — the part that was missing before — actually drives
// the resistance: the Fitness Machine Control Point must be asked for control
// (opcode 0x00) before it accepts a target power (0x05, ERG mode).
const FTMS = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetPower: 0x05,
  start: 0x07,
  setSimulation: 0x11,
  response: 0x80,
  ok: 0x01,
  notPermitted: 0x05,
};

export class SmartTrainer extends BluetoothSource {
  constructor() {
    super('trainer', [{ services: [SVC.ftms] }], [SVC.power]);
    this.controllable = false;
    this._cp = null;
    this._pending = new Map(); // opcode -> resolve
    this._queue = Promise.resolve();
    this._desired = { mode: 'free', targetWatts: null };
    this._range = null;
    this._crank = null;
  }

  async _setup(server) {
    this._cp = null;
    this.controllable = false;
    this._pending.clear();
    const service = await server.getPrimaryService(SVC.ftms);
    await this._notify(service, CHR.indoorBikeData, (dv) => this._onBikeData(dv));

    try {
      const rangeCh = await service.getCharacteristic(CHR.powerRange);
      const dv = await rangeCh.readValue();
      this._range = { min: dv.getInt16(0, true), max: dv.getInt16(2, true) };
    } catch {
      this._range = null; // optional characteristic
    }

    try {
      this._cp = await this._notify(service, CHR.controlPoint, (dv) => this._onResponse(dv));
      await this._acquireControl();
      this.controllable = true;
    } catch (err) {
      this._cp = null;
      this.controllable = false;
      this.detail = `no resistance control (${err.message})`;
    }
    if (this.controllable) await this._apply().catch(() => {});
  }

  _connectedDetail() {
    return this.controllable ? this._controlDetail() : this.detail;
  }

  // Indoor Bike Data: flags(uint16) then fields in a fixed order, each present
  // only if its flag bit is set (bit0 is inverted: 0 = speed present).
  _onBikeData(dv) {
    const flags = dv.getUint16(0, true);
    let o = 2;
    const reading = {};
    if (!(flags & 0x0001)) o += 2; // instantaneous speed
    if (flags & 0x0002) o += 2; // average speed
    if (flags & 0x0004) {
      reading.cadence = Math.round(dv.getUint16(o, true) / 2); // 0.5 rpm units
      o += 2;
    }
    if (flags & 0x0008) o += 2; // average cadence
    if (flags & 0x0010) o += 3; // total distance (uint24)
    if (flags & 0x0020) o += 2; // resistance level
    if (flags & 0x0040) {
      reading.power = dv.getInt16(o, true);
      o += 2;
    }
    this.emit(reading);
  }

  // --- control point ---
  _onResponse(dv) {
    if (dv.getUint8(0) !== FTMS.response) return;
    const op = dv.getUint8(1);
    const resolve = this._pending.get(op);
    if (resolve) {
      this._pending.delete(op);
      resolve(dv.getUint8(2));
    }
  }

  // Serialised: one command in flight at a time, each awaiting its indication.
  _cmd(op, bytes = []) {
    const run = async () => {
      if (!this._cp) throw new Error('no control point');
      const result = new Promise((resolve, reject) => {
        this._pending.set(op, resolve);
        setTimeout(() => {
          if (this._pending.delete(op)) reject(new Error('trainer did not answer'));
        }, 4000);
      });
      const data = Uint8Array.from([op, ...bytes]);
      if (this._cp.writeValueWithResponse) await this._cp.writeValueWithResponse(data);
      else await this._cp.writeValue(data);
      return result;
    };
    const next = this._queue.then(run, run);
    this._queue = next.catch(() => {});
    return next;
  }

  async _acquireControl() {
    const r = await this._cmd(FTMS.requestControl);
    if (r !== FTMS.ok) throw new Error(`control refused (code ${r})`);
    await this._cmd(FTMS.start).catch(() => {}); // start/resume; some trainers need it
  }

  async applyControl(control) {
    this._desired = control?.mode === 'erg' && control.targetWatts ? { mode: 'erg', targetWatts: control.targetWatts } : { mode: 'free', targetWatts: null };
    if (!this.controllable) return;
    await this._apply();
  }

  async _apply() {
    const d = this._desired;
    try {
      if (d.mode === 'erg') {
        let w = Math.round(d.targetWatts);
        if (this._range) w = Math.min(this._range.max, Math.max(this._range.min, w));
        let r = await this._cmd(FTMS.setTargetPower, [w & 0xff, (w >> 8) & 0xff]);
        if (r === FTMS.notPermitted) {
          await this._acquireControl();
          r = await this._cmd(FTMS.setTargetPower, [w & 0xff, (w >> 8) & 0xff]);
        }
        if (r !== FTMS.ok) throw new Error(`target rejected (code ${r})`);
        this._setControlDetail(`ERG ${w} W`);
      } else {
        // Free ride: simulate a flat road so resistance follows the rider.
        const r = await this._cmd(FTMS.setSimulation, [0, 0, 0, 0, 40, 51]);
        if (r !== FTMS.ok) {
          await this._cmd(FTMS.reset); // trainers without simulation mode: release ERG
          await this._acquireControl();
        }
        this._setControlDetail('free ride');
      }
    } catch (err) {
      this._setControlDetail(`control error: ${err.message}`);
      throw err;
    }
  }

  _controlDetail() {
    return this._ctl || 'resistance control ready';
  }

  _setControlDetail(text) {
    this._ctl = text;
    this.setStatus(this.status, text);
  }
}

// --- Simulator (no hardware needed) ----------------------------------------
// Behaves like a controllable trainer: ERG holds the target watts, free ride
// settles around 60% of FTP.
export class SimulatedTrainer extends DeviceSource {
  constructor(ftp = 220) {
    super('sim');
    this.name = 'Demo trainer';
    this.controllable = true;
    this._ftp = ftp;
    this._desired = { mode: 'free', targetWatts: null };
    this._power = 0;
    this._t = 0;
    this._timer = null;
  }

  async pair() {
    this.setStatus('connected', 'simulated');
    this._timer = setInterval(() => this._tick(), 1000);
  }

  async applyControl(control) {
    this._desired = control?.mode === 'erg' && control.targetWatts ? control : { mode: 'free', targetWatts: null };
    this.setStatus('connected', this._desired.mode === 'erg' ? `ERG ${this._desired.targetWatts} W` : 'free ride');
  }

  _tick() {
    this._t += 1;
    const goal = this._desired.mode === 'erg' ? this._desired.targetWatts : this._ftp * 0.6 + Math.sin(this._t / 25) * 25;
    const noise = (Math.random() - 0.5) * (this._desired.mode === 'erg' ? 6 : 24);
    this._power += (goal - this._power) * 0.5; // trainers settle within a couple of seconds
    const power = Math.max(0, Math.round(this._power + noise));
    const hr = Math.round(95 + (power / this._ftp) * 70 + Math.sin(this._t / 40) * 3 + (Math.random() - 0.5) * 3);
    const cadence = Math.round(88 + Math.sin(this._t / 10) * 5 + (Math.random() - 0.5) * 3);
    this.emit({ power, hr, cadence });
  }

  async disconnect() {
    clearInterval(this._timer);
    this._timer = null;
    this.setStatus('disconnected', '');
  }
}
