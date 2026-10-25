// ---------------------------------------------------------------------------
// Data model (Phase 2)
// ---------------------------------------------------------------------------
// The domain is intentionally small and explicit. Everything is a plain object
// so it can be serialised to JSON for persistence and sent over the wire.
//
//  User        — a person who can take part in tests. Holds their profile and
//                the physiological anchors used to compute zones (FTP, HR).
//  Session     — a single FTP-test event that one or more participants join.
//  Participant — the link between a User and a Session, plus their paired
//                devices, resistance setting, telemetry and computed result.
//  Device      — a sensor/trainer a rider paired in some browser.
//  Sample      — one timestamped 1 Hz log entry (power/hr/cadence).
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { buildTestConfig } from './metrics.js';

/**
 * @typedef {Object} User
 * @property {string} id
 * @property {string} name
 * @property {string} [email]
 * @property {number} [weightKg]
 * @property {number} [ftp]            Functional Threshold Power in watts.
 * @property {number} [maxHr]          Maximum heart rate (bpm).
 * @property {number} [lthr]           Lactate-threshold heart rate (bpm).
 * @property {number} [restingHr]      Resting heart rate (bpm).
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Sample
 * @property {number} t        Milliseconds since the rider's own start.
 * @property {number} [power]  Watts.
 * @property {number} [hr]     Heart rate (bpm).
 * @property {number} [cadence] RPM.
 */

/**
 * @typedef {Object} Device
 * @property {string} id
 * @property {'trainer'|'power'|'hr'|'sim'} kind
 * @property {string} name
 * @property {'connecting'|'connected'|'reconnecting'|'disconnected'|'failed'} status
 * @property {boolean} controllable  Trainer accepts resistance commands.
 */

/**
 * @typedef {Object} Participant
 * @property {string} userId
 * @property {string} name
 * @property {number} [ftp]
 * @property {number} [maxHr]
 * @property {number} [lthr]
 * @property {Device[]} devices       Devices the rider has paired (reported by the browser).
 * @property {'ready'|'scheduled'|'running'|'finished'} state  Rider's own test state.
 * @property {number|null} startAt    epoch ms at which this rider's test starts/started.
 * @property {{mode:'percent'|'watts', percent:number, watts:number|null}} control  Effort-phase resistance.
 * @property {Sample} live            Smoothed reading (see settings.smoothing).
 * @property {Sample[]} samples       1 Hz log of the rider's test.
 * @property {Object|null} result     Computed test result (see metrics.js).
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} name
 * @property {Object} test             Warm-up / effort / cool-down plan (metrics.buildTestConfig).
 * @property {'lobby'|'running'|'finished'} state
 * @property {Object.<string, Participant>} participants  keyed by userId
 * @property {number|null} startedAt   epoch ms
 * @property {number|null} finishedAt  epoch ms
 * @property {string} createdAt
 */

export function createUser(data = {}) {
  const now = new Date().toISOString();
  return {
    id: data.id || randomUUID(),
    name: data.name || 'Anonymous',
    email: data.email || '',
    weightKg: numberOrNull(data.weightKg),
    ftp: numberOrNull(data.ftp),
    maxHr: numberOrNull(data.maxHr),
    lthr: numberOrNull(data.lthr),
    restingHr: numberOrNull(data.restingHr),
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

export function createSession(data = {}) {
  return {
    id: data.id || randomUUID(),
    name: data.name || 'FTP Test',
    test: buildTestConfig(data.test),
    state: 'lobby',
    participants: {},
    startedAt: null,
    finishedAt: null,
    createdAt: data.createdAt || new Date().toISOString(),
  };
}

export function createParticipant(user, test) {
  return {
    userId: user.id,
    name: user.name,
    ftp: user.ftp ?? null,
    maxHr: user.maxHr ?? null,
    lthr: user.lthr ?? null,
    weightKg: user.weightKg ?? null,
    devices: [],
    state: 'ready',
    startAt: null,
    endedAt: null,
    control: { mode: 'percent', percent: test.effortPercentFtp, watts: null },
    live: { power: null, hr: null, cadence: null },
    samples: [],
    result: null,
  };
}

function numberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
