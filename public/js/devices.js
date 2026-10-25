// ---------------------------------------------------------------------------
// Device layer (Phase 3, client side).
// ---------------------------------------------------------------------------
// Talks to real sensors over Web Bluetooth using the standard GATT profiles:
//   - Cycling Power Service (0x1818) / Cycling Power Measurement (0x2A63)
//   - Heart Rate Service   (0x180D) / Heart Rate Measurement    (0x2A37)
// It also parses crank data for cadence. ANT+ is not exposed to browsers, so
// for ANT+ USB sticks a native bridge is required (documented in the README);
// the same reading shape is emitted, keeping the rest of the app agnostic.
//
// A built-in simulator lets the whole app be demoed without hardware.
// Each source is an EventTarget emitting `reading` events:
//   { power, hr, cadence }  (fields present only when the sensor provides them)
// ---------------------------------------------------------------------------

const CYCLING_POWER_SERVICE = 0x1818;
const CYCLING_POWER_MEASUREMENT = 0x2a63;
const HEART_RATE_SERVICE = 0x180d;
const HEART_RATE_MEASUREMENT = 0x2a37;

export class DeviceSource extends EventTarget {
  constructor(kind) {
    super();
    this.kind = kind; // 'power' | 'hr' | 'sim'
    this.name = '';
    this.connected = false;
    this._device = null;
    this._crank = null; // { revs, time } for cadence deltas
  }

  emit(reading) {
    this.dispatchEvent(new CustomEvent('reading', { detail: reading }));
  }

  setConnected(v) {
    this.connected = v;
    this.dispatchEvent(new CustomEvent('status', { detail: { connected: v, name: this.name } }));
  }

  async disconnect() {
    try {
      this._device?.gatt?.disconnect();
    } catch {
      /* ignore */
    }
    this.setConnected(false);
  }
}

// --- Bluetooth power meter --------------------------------------------------
export class PowerMeter extends DeviceSource {
  constructor() {
    super('power');
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not supported in this browser.');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [CYCLING_POWER_SERVICE] }],
    });
    this._device = device;
    this.name = device.name || 'Power meter';
    device.addEventListener('gattserverdisconnected', () => this.setConnected(false));

    const gatt = await device.gatt.connect();
    const service = await gatt.getPrimaryService(CYCLING_POWER_SERVICE);
    const ch = await service.getCharacteristic(CYCLING_POWER_MEASUREMENT);
    await ch.startNotifications();
    ch.addEventListener('characteristicvaluechanged', (e) => this._onValue(e.target.value));
    this.setConnected(true);
  }

  _onValue(dv) {
    // Cycling Power Measurement layout: flags(uint16 LE), instantaneous power
    // (sint16 LE), then optional fields gated by flag bits.
    const flags = dv.getUint16(0, true);
    const power = dv.getInt16(2, true);
    let offset = 4;
    const reading = { power };

    if (flags & 0x01) offset += 1; // Pedal Power Balance
    if (flags & 0x04) offset += 2; // Accumulated Torque
    if (flags & 0x10) offset += 6; // Wheel Revolution Data

    if (flags & 0x20) {
      // Crank Revolution Data: cumulative crank revs (uint16) + last event time
      // (uint16, 1/1024 s). Cadence = revs delta / time delta.
      const revs = dv.getUint16(offset, true);
      const time = dv.getUint16(offset + 2, true);
      if (this._crank) {
        let dRev = revs - this._crank.revs;
        let dT = time - this._crank.time;
        if (dRev < 0) dRev += 0x10000;
        if (dT < 0) dT += 0x10000;
        if (dT > 0) reading.cadence = Math.round((dRev * 1024 * 60) / dT);
      }
      this._crank = { revs, time };
    }
    this.emit(reading);
  }
}

// --- Bluetooth heart-rate strap --------------------------------------------
export class HeartRateMonitor extends DeviceSource {
  constructor() {
    super('hr');
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not supported in this browser.');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HEART_RATE_SERVICE] }],
    });
    this._device = device;
    this.name = device.name || 'HR monitor';
    device.addEventListener('gattserverdisconnected', () => this.setConnected(false));

    const gatt = await device.gatt.connect();
    const service = await gatt.getPrimaryService(HEART_RATE_SERVICE);
    const ch = await service.getCharacteristic(HEART_RATE_MEASUREMENT);
    await ch.startNotifications();
    ch.addEventListener('characteristicvaluechanged', (e) => this._onValue(e.target.value));
    this.setConnected(true);
  }

  _onValue(dv) {
    // Heart Rate Measurement: flags(uint8). Bit0 = value format (0:uint8, 1:uint16).
    const flags = dv.getUint8(0);
    const hr = flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
    this.emit({ hr });
  }
}

// --- Simulator (no hardware needed) ----------------------------------------
// Produces plausible power/HR/cadence with slow drift so the UI, feedback and
// results can be exercised end-to-end.
export class SimulatedTrainer extends DeviceSource {
  constructor(basePower = 220) {
    super('sim');
    this.name = 'Simulated trainer';
    this._base = basePower;
    this._t = 0;
    this._timer = null;
  }

  async connect() {
    this.setConnected(true);
    this._timer = setInterval(() => this._tick(), 1000);
  }

  _tick() {
    this._t += 1;
    const wave = Math.sin(this._t / 25) * 30;
    const noise = (Math.random() - 0.5) * 25;
    const power = Math.max(0, Math.round(this._base + wave + noise));
    const hr = Math.round(120 + (power - this._base) * 0.15 + Math.sin(this._t / 40) * 8 + (Math.random() - 0.5) * 4);
    const cadence = Math.round(88 + Math.sin(this._t / 10) * 6 + (Math.random() - 0.5) * 3);
    this.emit({ power, hr: Math.max(60, hr), cadence });
  }

  async disconnect() {
    clearInterval(this._timer);
    this._timer = null;
    this.setConnected(false);
  }
}
