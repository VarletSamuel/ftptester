// ---------------------------------------------------------------------------
// Session manager — the live engine for FTP-test events.
// ---------------------------------------------------------------------------
// Holds in-memory sessions, tracks participants and their telemetry, and emits
// events that the WebSocket layer broadcasts. On finish, it computes results
// (via metrics.js) and hands a summary to the persistent store.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createSession, createParticipant } from './models.js';
import { summarize } from './metrics.js';
import { store } from './dataStore.js';

class SessionManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, import('./models.js').Session>} */
    this.sessions = new Map();
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
    const session = this.sessions.get(sessionId);
    if (!session) throw httpError(404, 'Session not found');
    if (!session.participants[user.id]) {
      session.participants[user.id] = createParticipant(user);
    }
    this.emit('session:updated', publicSession(session));
    return session.participants[user.id];
  }

  leave(sessionId, userId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    delete session.participants[userId];
    this.emit('session:updated', publicSession(session));
  }

  setDeviceStatus(sessionId, userId, status) {
    const p = this.#participant(sessionId, userId);
    if (!p) return;
    p.deviceStatus = status === 'connected' ? 'connected' : 'disconnected';
    this.emit('session:updated', publicSession(this.sessions.get(sessionId)));
  }

  // --- lifecycle ---------------------------------------------------------
  start(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw httpError(404, 'Session not found');
    session.state = 'running';
    session.startedAt = Date.now();
    session.finishedAt = null;
    for (const p of Object.values(session.participants)) {
      p.samples = [];
      p.result = null;
    }
    this.emit('session:started', publicSession(session));
    return session;
  }

  async finish(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw httpError(404, 'Session not found');
    session.state = 'finished';
    session.finishedAt = Date.now();

    for (const p of Object.values(session.participants)) {
      p.result = summarize(p.samples, session.protocol);
      // Persist the newly measured FTP back onto the user's profile.
      const user = store.getUser(p.userId);
      if (user && p.result.estimatedFtp > 0) {
        await store.saveUser({ ...user, ftp: p.result.estimatedFtp, updatedAt: new Date().toISOString() });
      }
    }

    await store.addHistory({
      sessionId: session.id,
      name: session.name,
      protocol: session.protocol,
      finishedAt: new Date(session.finishedAt).toISOString(),
      results: Object.values(session.participants).map((p) => ({
        userId: p.userId,
        name: p.name,
        ...p.result,
      })),
    });

    this.emit('session:finished', publicSession(session));
    return session;
  }

  // --- telemetry ---------------------------------------------------------
  // Called by the WebSocket layer for every device reading. Stores the sample
  // (only while running) and updates the live snapshot for the dashboard.
  ingest(sessionId, userId, sample) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const p = session.participants[userId];
    if (!p) return null;

    const live = {
      t: session.startedAt ? Date.now() - session.startedAt : 0,
      power: num(sample.power),
      hr: num(sample.hr),
      cadence: num(sample.cadence),
    };
    p.live = live;
    p.deviceStatus = 'connected';

    if (session.state === 'running') {
      p.samples.push(live);
    }
    return { sessionId, userId, live, state: session.state };
  }

  #participant(sessionId, userId) {
    const session = this.sessions.get(sessionId);
    return session ? session.participants[userId] || null : null;
  }
}

// Strip heavy sample arrays for network/state payloads.
export function publicSession(session) {
  return {
    id: session.id,
    name: session.name,
    protocol: session.protocol,
    state: session.state,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    createdAt: session.createdAt,
    participants: Object.values(session.participants).map((p) => ({
      userId: p.userId,
      name: p.name,
      ftp: p.ftp,
      maxHr: p.maxHr,
      deviceStatus: p.deviceStatus,
      live: p.live,
      result: p.result,
    })),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export const sessions = new SessionManager();
