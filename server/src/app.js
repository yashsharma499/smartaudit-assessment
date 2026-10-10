import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { HttpError } from './lib/errors.js';

// Express 4 doesn't forward rejected promises to the error handler; this does.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp({ controller, aiService, worker }) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, ai: aiService.mode, workerRunning: Boolean(worker?.running), db: mongoose.connection.readyState === 1 ? 'connected' : 'down' });
  });

  const r = express.Router();
  r.post('/', wrap(controller.create));
  r.get('/', wrap(controller.list));
  r.get('/:id', wrap(controller.get));
  r.put('/:id', wrap(controller.update));
  r.post('/:id/similar', wrap(controller.similar));
  r.post('/:id/retry', wrap(controller.retry));
  app.use('/api/audit-entries', r);

  app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err instanceof mongoose.Error.ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof mongoose.Error.CastError) return res.status(400).json({ error: `Invalid value for ${err.path}` });
    if (err?.code === 11000) return res.status(409).json({ error: 'An entry with this evidenceId already exists for this tenant' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
