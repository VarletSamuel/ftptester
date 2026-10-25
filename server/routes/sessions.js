import { Router } from 'express';
import { sessions, publicSession } from '../sessionManager.js';
import { store } from '../dataStore.js';
import { PROTOCOLS } from '../metrics.js';

export const sessionsRouter = Router();

sessionsRouter.get('/protocols', (req, res) => {
  res.json(Object.values(PROTOCOLS));
});

sessionsRouter.get('/history', (req, res) => {
  res.json(store.listHistory());
});

sessionsRouter.get('/', (req, res) => {
  res.json(sessions.list());
});

sessionsRouter.get('/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json(publicSession(s));
});

sessionsRouter.post('/', (req, res) => {
  const s = sessions.create(req.body || {});
  res.status(201).json(publicSession(s));
});

sessionsRouter.post('/:id/join', (req, res) => {
  const user = store.getUser(req.body?.userId);
  if (!user) return res.status(400).json({ error: 'Unknown userId' });
  try {
    sessions.join(req.params.id, user);
    res.json(publicSession(sessions.get(req.params.id)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

sessionsRouter.post('/:id/leave', (req, res) => {
  sessions.leave(req.params.id, req.body?.userId);
  res.json(publicSession(sessions.get(req.params.id)) || { ok: true });
});

sessionsRouter.post('/:id/start', (req, res) => {
  try {
    res.json(publicSession(sessions.start(req.params.id)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

sessionsRouter.post('/:id/finish', async (req, res) => {
  try {
    res.json(publicSession(await sessions.finish(req.params.id)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

sessionsRouter.delete('/:id', (req, res) => {
  const ok = sessions.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Session not found' });
  res.status(204).end();
});
