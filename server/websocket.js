// ---------------------------------------------------------------------------
// WebSocket middleware (Phase 3 — the wire between frontend and backend).
// ---------------------------------------------------------------------------
// Browsers own the physical device connection (Web Bluetooth). Each browser
// streams parsed readings up over this socket; the server fans out live
// telemetry and session state to every client watching the same session.
//
// Client -> server messages:
//   { type:'subscribe', sessionId }
//   { type:'telemetry', sessionId, userId, power, hr, cadence }   raw reading
//   { type:'devices', sessionId, userId, devices:[{id,kind,name,status,controllable}] }
//
// Server -> client messages:
//   { type:'session', session }        full session snapshot (state, devices, results)
//   { type:'tick', sessionId, ts, riders:[...] }   1 Hz: smoothed values, phase, trainer command
//   { type:'history', sessionId, riders:{userId:[[ts,power,hr]...]} }  recent smoothed history
//   { type:'sessionRemoved', id }
// ---------------------------------------------------------------------------

import { WebSocketServer } from 'ws';
import { sessions, publicSession } from './sessionManager.js';

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Broadcast helper: send to every client subscribed to a session (or all).
  function broadcast(sessionId, payload) {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState !== client.OPEN) continue;
      if (sessionId && client.sessionId && client.sessionId !== sessionId) continue;
      client.send(data);
    }
  }

  // Relay session-manager events to subscribed clients.
  sessions.on('session:updated', (s) => broadcast(s.id, { type: 'session', session: s }));
  sessions.on('session:tick', (t) => broadcast(t.sessionId, { type: 'tick', ...t }));
  sessions.on('session:created', (s) => broadcast(null, { type: 'session', session: s }));
  sessions.on('session:removed', ({ id }) => broadcast(null, { type: 'sessionRemoved', id }));

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handleMessage(ws, msg);
    });
  });

  // Heartbeat: drop dead connections so ghost participants disappear.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'subscribe': {
      ws.sessionId = msg.sessionId;
      const s = sessions.get(msg.sessionId);
      if (s) {
        ws.send(JSON.stringify({ type: 'session', session: publicSession(s) }));
        ws.send(JSON.stringify({ type: 'history', sessionId: s.id, riders: sessions.history(s.id) }));
      }
      break;
    }
    case 'telemetry':
      sessions.ingest(msg.sessionId, msg.userId, msg);
      break;
    case 'devices':
      sessions.setDevices(msg.sessionId, msg.userId, msg.devices);
      break;
    default:
      break;
  }
}
