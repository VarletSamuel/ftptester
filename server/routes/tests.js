// Stored (finished) tests: report data and TCX / GPX / Excel exports.
import { Router } from 'express';
import { store } from '../dataStore.js';
import { toTcx, toGpx, toXlsx, fileSafe } from '../export.js';

export const testsRouter = Router();

async function loadTest(req, res, next) {
  const record = await store.getTest(req.params.id);
  if (!record) return res.status(404).json({ error: 'Test not found' });
  req.record = record;
  next();
}

testsRouter.get('/', (req, res) => {
  res.json(store.listHistory());
});

// Full record for the report; add ?samples=1 to include the 1 Hz data.
testsRouter.get('/:id', loadTest, (req, res) => {
  const record = req.query.samples
    ? req.record
    : { ...req.record, riders: req.record.riders.map(({ samples, ...r }) => r) };
  res.json(record);
});

testsRouter.delete('/:id', async (req, res) => {
  const ok = await store.deleteTest(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Test not found' });
  res.status(204).end();
});

testsRouter.get('/:id/export.xlsx', loadTest, async (req, res) => {
  const buf = await toXlsx(req.record);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${fileSafe(req.record.name)}.xlsx"`,
  });
  res.send(Buffer.from(buf));
});

// GET /api/tests/:id/export/:userId.tcx  |  .gpx
testsRouter.get('/:id/export/:file', loadTest, (req, res) => {
  const m = /^(.+)\.(tcx|gpx)$/.exec(req.params.file);
  const rider = m && req.record.riders.find((r) => r.userId === m[1]);
  if (!rider) return res.status(404).json({ error: 'Rider or format not found' });
  const body = m[2] === 'tcx' ? toTcx(req.record, rider) : toGpx(req.record, rider);
  res.set({
    'Content-Type': m[2] === 'tcx' ? 'application/vnd.garmin.tcx+xml' : 'application/gpx+xml',
    'Content-Disposition': `attachment; filename="${fileSafe(`${req.record.name}_${rider.name}`)}.${m[2]}"`,
  });
  res.send(body);
});
