// ---------------------------------------------------------------------------
// Server entry point. Wires up static hosting, the REST API, and the
// WebSocket telemetry channel, then loads persisted data and listens.
// ---------------------------------------------------------------------------

import http from 'node:http';
import express from 'express';
import { config, PUBLIC_DIR } from './config.js';
import { store } from './dataStore.js';
import { usersRouter } from './routes/users.js';
import { sessionsRouter } from './routes/sessions.js';
import { integrationsRouter } from './routes/integrations.js';
import { attachWebSocket } from './websocket.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// REST API (Phase 4).
app.use('/api/users', usersRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/integrations', integrationsRouter);
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Frontend (Phase 1) served statically.
app.use(express.static(PUBLIC_DIR));

// SPA fallback: send index.html for any non-API GET.
app.get(/^\/(?!api|ws).*/, (req, res) => {
  res.sendFile('index.html', { root: PUBLIC_DIR });
});

const server = http.createServer(app);
attachWebSocket(server); // Phase 3 middleware.

await store.load();
server.listen(config.port, () => {
  console.log(`FTP-tester running at http://localhost:${config.port}`);
});
