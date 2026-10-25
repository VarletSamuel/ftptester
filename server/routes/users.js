import { Router } from 'express';
import { store } from '../dataStore.js';
import { createUser } from '../models.js';
import { powerZones, hrZones } from '../metrics.js';

export const usersRouter = Router();

usersRouter.get('/', (req, res) => {
  res.json(store.listUsers());
});

usersRouter.get('/:id', (req, res) => {
  const user = store.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// Zones derived from the user's FTP / max HR.
usersRouter.get('/:id/zones', (req, res) => {
  const user = store.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ power: powerZones(user.ftp), hr: hrZones(user.maxHr) });
});

usersRouter.post('/', async (req, res) => {
  const user = createUser(req.body || {});
  await store.saveUser(user);
  res.status(201).json(user);
});

usersRouter.put('/:id', async (req, res) => {
  const existing = store.getUser(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  const updated = createUser({ ...existing, ...req.body, id: existing.id, createdAt: existing.createdAt });
  await store.saveUser(updated);
  res.json(updated);
});

usersRouter.delete('/:id', async (req, res) => {
  const ok = await store.deleteUser(req.params.id);
  if (!ok) return res.status(404).json({ error: 'User not found' });
  res.status(204).end();
});
