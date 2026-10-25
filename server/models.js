// ---------------------------------------------------------------------------
// Data model (Phase 2)
// ---------------------------------------------------------------------------
// The domain is intentionally small and explicit. Everything is a plain object
// so it can be serialised to JSON for persistence and sent over the wire.
//
//  User        — a person who can take part in tests. Holds their profile and
//                the physiological anchors used to compute zones (FTP, HR).
//  Session     — a single FTP-test event that one or more participants join.
//  Participant — the link between a User and a Session, plus their live/last
//                telemetry and computed result for that session.
//  Sample      — one timestamped telemetry reading (power/hr/cadence).
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

/**
 * @typedef {Object} User
 * @property {string} id
 * @property {string} name
 * @property {string} [email]
 * @property {number} [weightKg]
 * @property {number} [ftp]            Functional Threshold Power in watts.
 * @property {number} [maxHr]          Maximum heart rate (bpm).
 * @property {number} [restingHr]      Resting heart rate (bpm).
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Sample
 * @property {number} t        Milliseconds since session start.
 * @property {number} [power]  Watts.
 * @property {number} [hr]     Heart rate (bpm).
 * @property {number} [cadence] RPM.
 */

/**
 * @typedef {Object} Participant
 * @property {string} userId
 * @property {string} name
 * @property {number} [ftp]
 * @property {number} [maxHr]
 * @property {'connected'|'disconnected'} deviceStatus
 * @property {Sample} live            Most recent reading.
 * @property {Sample[]} samples       Full logged history for the session.
 * @property {Object|null} result     Computed test result (see metrics.js).
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} name
 * @property {'ftp20'|'ftp8'|'ramp'} protocol
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
    restingHr: numberOrNull(data.restingHr),
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

export function createSession(data = {}) {
  return {
    id: data.id || randomUUID(),
    name: data.name || 'FTP Test',
    protocol: ['ftp20', 'ftp8', 'ramp'].includes(data.protocol) ? data.protocol : 'ftp20',
    state: 'lobby',
    participants: {},
    startedAt: null,
    finishedAt: null,
    createdAt: data.createdAt || new Date().toISOString(),
  };
}

export function createParticipant(user) {
  return {
    userId: user.id,
    name: user.name,
    ftp: user.ftp ?? null,
    maxHr: user.maxHr ?? null,
    deviceStatus: 'disconnected',
    live: { t: 0, power: 0, hr: 0, cadence: 0 },
    samples: [],
    result: null,
  };
}

function numberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
