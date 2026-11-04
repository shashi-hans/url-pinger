'use strict';

const express = require('express');
const service = require('../targetsService');
const store = require('../store');
const { requireUser } = require('../auth');

const router = express.Router();

function sendResult(res, result, body) {
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  if (result.status === 204) return res.status(204).end();
  return res.status(result.status).json(body ?? result.target);
}

// Public liveness probe. It reports no per-user data.
router.get('/health', (req, res) => {
  res.json({ status: 'ok', storage: store.name });
});

router.use(requireUser('api'));

router.get('/targets', (req, res) => {
  res.json({ targets: service.list(req.actor) });
});

router.post('/targets', async (req, res, next) => {
  try {
    sendResult(res, await service.create(req.actor, req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/targets/:id', (req, res) => {
  const target = service.get(req.actor, req.params.id);
  if (!target) return res.status(404).json({ errors: ['target not found'] });
  return res.json(target);
});

router.patch('/targets/:id', async (req, res, next) => {
  try {
    sendResult(res, await service.update(req.actor, req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.delete('/targets/:id', async (req, res, next) => {
  try {
    sendResult(res, await service.remove(req.actor, req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/targets/:id/run', async (req, res, next) => {
  try {
    const result = await service.runNow(req.actor, req.params.id);
    sendResult(res, result, result.entry);
  } catch (err) {
    next(err);
  }
});

// Hits from the last HISTORY_WINDOW_HOURS, newest first, one page at a time.
// `limit` is accepted as another name for `pageSize`.
router.get('/targets/:id/history', async (req, res, next) => {
  try {
    const page = Number.parseInt(req.query.page, 10);
    const pageSize = Number.parseInt(req.query.pageSize ?? req.query.limit, 10);
    const result = await service.getHistory(req.actor, req.params.id, {
      page: Number.isFinite(page) ? page : undefined,
      pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
    });
    if (result === null) return res.status(404).json({ errors: ['target not found'] });
    const { entries, ...meta } = result;
    return res.json({ history: entries, ...meta });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
