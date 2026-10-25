import { Router } from 'express';
import { sessions, publicSession } from '../sessionManager.js';
import { store } from '../dataStore.js';

export const sessionsRouter = Router();

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });

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
    fail(res, err);
  }
});

sessionsRouter.post('/:id/leave', (req, res) => {
  sessions.leave(req.params.id, req.body?.userId);
  const s = sessions.get(req.params.id);
  res.json(s ? publicSession(s) : { ok: true });
});

// Start every ready rider together, or staggered: { staggerSeconds, userIds? }.
sessionsRouter.post('/:id/start', (req, res) => {
  try {
    res.json(publicSession(sessions.start(req.params.id, req.body || {})));
  } catch (err) {
    fail(res, err);
  }
});

sessionsRouter.post('/:id/finish', async (req, res) => {
  try {
    res.json(publicSession(await sessions.finish(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

// Per-rider controls: start (optionally delayed), stop, and resistance setting.
sessionsRouter.post('/:id/riders/:userId/start', (req, res) => {
  try {
    sessions.startRider(req.params.id, req.params.userId, req.body?.delaySeconds);
    res.json(publicSession(sessions.get(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

sessionsRouter.post('/:id/riders/:userId/stop', async (req, res) => {
  try {
    await sessions.stopRider(req.params.id, req.params.userId);
    res.json(publicSession(sessions.get(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

// { mode: 'percent'|'watts', percent?, watts? } — effort-phase resistance.
sessionsRouter.put('/:id/riders/:userId/control', (req, res) => {
  try {
    sessions.setControl(req.params.id, req.params.userId, req.body || {});
    res.json(publicSession(sessions.get(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

sessionsRouter.delete('/:id', (req, res) => {
  const ok = sessions.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Session not found' });
  res.status(204).end();
});
