'use strict';

const express = require('express');
const service = require('../targetsService');

const router = express.Router();

function sendResult(res, result, body) {
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  if (result.status === 204) return res.status(204).end();
  return res.status(result.status).json(body ?? result.target);
}

router.get('/health', (req, res) => {
  res.json({ status: 'ok', targets: service.list().length });
});

router.get('/targets', (req, res) => {
  res.json({ targets: service.list() });
});

router.post('/targets', async (req, res, next) => {
  try {
    sendResult(res, await service.create(req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/targets/:id', (req, res) => {
  const target = service.get(req.params.id);
  if (!target) return res.status(404).json({ errors: ['target not found'] });
  return res.json(target);
});

router.patch('/targets/:id', async (req, res, next) => {
  try {
    sendResult(res, await service.update(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.delete('/targets/:id', async (req, res, next) => {
  try {
    sendResult(res, await service.remove(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/targets/:id/run', async (req, res, next) => {
  try {
    const result = await service.runNow(req.params.id);
    sendResult(res, result, result.entry);
  } catch (err) {
    next(err);
  }
});

router.get('/targets/:id/history', (req, res) => {
  const limit = Number.parseInt(req.query.limit, 10);
  const entries = service.getHistory(req.params.id, Number.isFinite(limit) ? limit : undefined);
  if (entries === null) return res.status(404).json({ errors: ['target not found'] });
  return res.json({ history: entries });
});

module.exports = router;
