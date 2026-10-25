// ---------------------------------------------------------------------------
// Session manager — the live engine for FTP-test events.
// ---------------------------------------------------------------------------
// Holds in-memory sessions and, per rider, the raw telemetry buffer, the
// smoothed live values, the 1 Hz test log and the test timeline. A 1 Hz ticker
//   * averages the raw readings over settings.smoothing.windowSeconds,
//   * advances each rider through warm-up -> effort -> cool-down (riders can
//     start together or staggered, each on their own clock),
//   * decides the trainer command (free ride vs. ERG target watts), and
//   * emits one `tick` event per session for the WebSocket layer to broadcast.
// On finish it computes results (metrics.js) and persists the test record.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createSession, createParticipant } from './models.js';
import { summarize, phaseAt } from './metrics.js';
import { store } from './dataStore.js';
import { settings } from './config.js';

const RAW_KEEP_MS = 15000;

class SessionManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, import('./models.js').Session>} */
    this.sessions = new Map();
    this.timer = null;
  }

  startTicker() {
    if (!this.timer) this.timer = setInterval(() => this.#tick(), 1000);
  }

  list() {
    return [...this.sessions.values()].map(publicSession);
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  create(data) {
    const session = createSession(data);
    this.sessions.set(session.id, session);
    this.emit('session:created', publicSession(session));
    return session;
  }

  remove(id) {
    const ok = this.sessions.delete(id);
    if (ok) this.emit('session:removed', { id });
    return ok;
  }

  // --- participants ------------------------------------------------------
  join(sessionId, user) {
    const session = this.#session(sessionId);
    if (!session.participants[user.id]) {
      session.participants[user.id] = createParticipant(user, session.test);
      session.participants[user.id].history = [];
      session.participants[user.id].raw = [];
    }
    this.#updated(session);
    return session.participants[user.id];
  }

  leave(sessionId, userId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    delete session.participants[userId];
    this.#updated(session);
  }

  // Devices are paired in a browser; it reports the full list for a rider.
  setDevices(sessionId, userId, devices) {
    const p = this.#participant(sessionId, userId);
    if (!p || !Array.isArray(devices)) return;
    p.devices = devices.slice(0, 8).map((d) => ({
      id: String(d.id),
      kind: ['trainer', 'power', 'hr', 'sim'].includes(d.kind) ? d.kind : 'power',
      name: String(d.name || d.kind).slice(0, 60),
      status: ['connecting', 'connected', 'reconnecting', 'disconnected', 'failed'].includes(d.status) ? d.status : 'disconnected',
      controllable: Boolean(d.controllable),
      detail: String(d.detail || '').slice(0, 60),
    }));
    this.#updated(this.sessions.get(sessionId));
  }

  // Resistance for the effort phase: % of the rider's FTP, or absolute watts.
  setControl(sessionId, userId, input = {}) {
    const session = this.#session(sessionId);
    const p = session.participants[userId];
    if (!p) throw httpError(404, 'Rider not in session');
    const c = p.control;
    if (input.mode === 'percent' || input.mode === 'watts') c.mode = input.mode;
    if (input.percent !== undefined && Number.isFinite(Number(input.percent))) c.percent = clamp(Number(input.percent), 20, 200);
    if (input.watts !== undefined && input.watts !== null && Number.isFinite(Number(input.watts))) c.watts = clamp(Math.round(Number(input.watts)), 20, 2000);
    this.#updated(session);
    return p;
  }

  // --- lifecycle ---------------------------------------------------------
  // Start every rider that is still `ready` (or the given subset). Riders start
  // together (staggerSeconds = 0) or `staggerSeconds` apart, in the given order.
  start(sessionId, { staggerSeconds = 0, userIds = null } = {}) {
    const session = this.#session(sessionId);
    const now = Date.now();
    const gap = Math.max(0, Number(staggerSeconds) || 0) * 1000;
    const wanted = userIds ? new Set(userIds) : null;
    const queue = Object.values(session.participants).filter(
      (p) => p.state === 'ready' && (!wanted || wanted.has(p.userId)),
    );
    if (!queue.length) throw httpError(400, 'No riders are ready to start');
    // Honour the order the caller gave (the UI's staggered start order).
    if (userIds) queue.sort((a, b) => userIds.indexOf(a.userId) - userIds.indexOf(b.userId));
    queue.forEach((p, i) => this.#schedule(p, now + i * gap, now));
    this.#markRunning(session, now);
    this.#updated(session);
    return session;
  }

  startRider(sessionId, userId, delaySeconds = 0) {
    const session = this.#session(sessionId);
    const p = session.participants[userId];
    if (!p) throw httpError(404, 'Rider not in session');
    if (p.state !== 'ready') throw httpError(400, 'Rider already started');
    const now = Date.now();
    this.#schedule(p, now + Math.max(0, Number(delaySeconds) || 0) * 1000, now);
    this.#markRunning(session, now);
    this.#updated(session);
    return p;
  }

  async stopRider(sessionId, userId) {
    const session = this.#session(sessionId);
    const p = session.participants[userId];
    if (!p) throw httpError(404, 'Rider not in session');
    if (p.state === 'running' || p.state === 'scheduled') this.#finishRider(session, p);
    this.#updated(session);
    await this.#maybeFinalize(session);
    return p;
  }

  // Stop everyone still going and close the session.
  async finish(sessionId) {
    const session = this.#session(sessionId);
    for (const p of Object.values(session.participants)) {
      if (p.state === 'running' || p.state === 'scheduled') this.#finishRider(session, p);
    }
    await this.#finalize(session);
    return session;
  }

  // --- telemetry ---------------------------------------------------------
  // Raw readings from a browser. They are only buffered here; the 1 Hz ticker
  // turns them into smoothed values for the screens and the test log.
  ingest(sessionId, userId, reading) {
    const p = this.#participant(sessionId, userId);
    if (!p) return;
    const ts = Date.now();
    p.raw.push({ ts, power: numOrNull(reading.power), hr: numOrNull(reading.hr), cadence: numOrNull(reading.cadence) });
    while (p.raw.length && p.raw[0].ts < ts - RAW_KEEP_MS) p.raw.shift();
  }

  // Recent smoothed history for a freshly subscribed screen.
  history(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const riders = {};
    for (const p of Object.values(session.participants)) riders[p.userId] = p.history;
    return riders;
  }

  // --- internals ---------------------------------------------------------
  #tick() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      const participants = Object.values(session.participants);
      if (!participants.length) continue;
      let changed = false;
      let finishedAny = false;
      const riders = [];

      for (const p of participants) {
        if (p.state === 'scheduled' && now >= p.startAt) {
          p.state = 'running';
          p.samples = [];
          changed = true;
        }

        const live = smooth(p.raw, now);
        p.live = live;
        p.history.push([now, live.power, live.hr]);
        const cutoff = now - settings.history.windowSeconds * 1000;
        while (p.history.length && p.history[0][0] < cutoff) p.history.shift();

        let phase = null;
        let remaining = 0;
        let elapsed = 0;
        if (p.state === 'running') {
          const ph = phaseAt(session.test, (now - p.startAt) / 1000);
          if (ph.phase === 'done') {
            this.#finishRider(session, p, now);
            changed = finishedAny = true;
          } else {
            phase = ph.phase;
            remaining = Math.round(ph.remaining);
            elapsed = now - p.startAt;
            const inst = smooth(p.raw, now, 1000, true);
            p.samples.push({ t: Math.round(elapsed / 1000) * 1000, power: inst.power, hr: inst.hr, cadence: inst.cadence });
          }
        }

        riders.push({
          userId: p.userId,
          power: live.power,
          hr: live.hr,
          cadence: live.cadence,
          state: p.state,
          phase,
          remaining,
          elapsed: Math.round(elapsed / 1000),
          startsIn: p.state === 'scheduled' ? Math.max(0, Math.ceil((p.startAt - now) / 1000)) : 0,
          control: controlFor(p, session, phase),
        });
      }

      this.emit('session:tick', { sessionId: session.id, ts: now, riders });
      if (changed) this.#updated(session);
      if (finishedAny) this.#maybeFinalize(session).catch((err) => console.error('finalize failed', err));
    }
  }

  #schedule(p, startAt, now) {
    p.startAt = startAt;
    p.endedAt = null;
    p.result = null;
    p.samples = [];
    p.state = startAt <= now ? 'running' : 'scheduled';
  }

  #markRunning(session, now) {
    if (session.state !== 'running') {
      session.state = 'running';
      session.startedAt = now;
      session.finishedAt = null;
    }
  }

  #finishRider(session, p, now = Date.now()) {
    p.state = 'finished';
    p.endedAt = now;
    p.result = p.samples.length ? summarize(p.samples, session.test, p) : null;
  }

  async #maybeFinalize(session) {
    const riders = Object.values(session.participants);
    const started = riders.filter((p) => p.state !== 'ready');
    if (started.length && started.every((p) => p.state === 'finished') && session.state === 'running') {
      await this.#finalize(session);
    }
  }

  async #finalize(session) {
    if (session.state === 'finished' || session.finalizing) return;
    session.finalizing = true;
    try {
      session.state = 'finished';
      session.finishedAt = Date.now();
      const riders = Object.values(session.participants).filter((p) => p.result);

      // Persist freshly measured FTP / LTHR back onto the athlete's profile.
      for (const p of riders) {
        const user = store.getUser(p.userId);
        if (!user || p.result.effortCompletion < settings.test.minCompletionForProfileUpdate || p.result.estimatedFtp <= 0) continue;
        await store.saveUser({
          ...user,
          ftp: p.result.estimatedFtp,
          lthr: p.result.measuredLthr || user.lthr || null,
          updatedAt: new Date().toISOString(),
        });
      }

      if (riders.length) {
        await store.saveTest({
          id: session.id,
          name: session.name,
          createdAt: session.createdAt,
          startedAt: session.startedAt,
          finishedAt: session.finishedAt,
          test: session.test,
          riders: riders.map((p) => ({
            userId: p.userId,
            name: p.name,
            weightKg: p.weightKg,
            maxHr: p.maxHr,
            startAt: p.startAt,
            result: p.result,
            samples: p.samples.map((s) => [Math.round(s.t / 1000), s.power, s.hr, s.cadence]),
          })),
        });
        await store.addHistory({
          sessionId: session.id,
          name: session.name,
          finishedAt: new Date(session.finishedAt).toISOString(),
          test: session.test,
          results: riders.map((p) => ({ userId: p.userId, name: p.name, ...p.result })),
        });
      }
      this.#updated(session);
    } finally {
      session.finalizing = false;
    }
  }

  #updated(session) {
    this.emit('session:updated', publicSession(session));
  }

  #session(id) {
    const session = this.sessions.get(id);
    if (!session) throw httpError(404, 'Session not found');
    return session;
  }

  #participant(sessionId, userId) {
    const session = this.sessions.get(sessionId);
    return session ? session.participants[userId] || null : null;
  }
}

// Mean of the raw readings in the last `windowMs` (defaults to the configured
// smoothing window). Returns nulls when the sensor has gone quiet. With
// `holdLast`, a single late reading is still used so the 1 Hz log has no holes.
function smooth(raw, now, windowMs = settings.smoothing.windowSeconds * 1000, holdLast = false) {
  const last = raw.at(-1);
  const stale = settings.smoothing.staleAfterSeconds * 1000;
  const out = { power: null, hr: null, cadence: null };
  if (!last || now - last.ts > stale) return out;
  const win = raw.filter((r) => r.ts > now - windowMs);
  for (const key of Object.keys(out)) {
    let vals = win.map((r) => r[key]).filter((v) => v !== null);
    if (!vals.length && holdLast) {
      const latest = [...raw].reverse().find((r) => r[key] !== null);
      if (latest && now - latest.ts <= 2500) vals = [latest[key]];
    }
    if (vals.length) out[key] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return out;
}

// Trainer command for a rider: free ride outside the effort phase, otherwise
// ERG at the configured % of FTP or absolute watts.
export function controlFor(p, session, phase) {
  const c = p.control;
  const target = c.mode === 'watts' ? c.watts : p.ftp ? Math.round((p.ftp * c.percent) / 100) : null;
  if (phase === 'effort' && target) return { mode: 'erg', targetWatts: target };
  return { mode: 'free', targetWatts: null };
}

// Strip heavy buffers for network/state payloads.
export function publicSession(session) {
  return {
    id: session.id,
    name: session.name,
    test: session.test,
    state: session.state,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    createdAt: session.createdAt,
    participants: Object.values(session.participants).map((p) => ({
      userId: p.userId,
      name: p.name,
      ftp: p.ftp,
      maxHr: p.maxHr,
      lthr: p.lthr,
      devices: p.devices,
      state: p.state,
      startAt: p.startAt,
      control: p.control,
      live: p.live,
      result: p.result,
    })),
  };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export const sessions = new SessionManager();
