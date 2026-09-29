'use strict';

const express = require('express');
const service = require('../targetsService');
const views = require('../views');

const router = express.Router();

// Parses the headers textarea ("Name: value" per line) into an object.
// Returns { headers, errors } so a bad line is reported, not silently dropped.
function parseHeaderLines(text) {
  const headers = {};
  const errors = [];
  if (typeof text !== 'string') return { headers, errors };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 1) {
      errors.push(`header line "${line.slice(0, 40)}" must be in the form "Name: value"`);
      continue;
    }
    headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { headers, errors };
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// Maps the HTML form body onto the service input shape. Every field is
// re-validated in targetsService; this only reshapes.
// keepHeadersIfEmpty is used on edit: stored header values are masked in the
// form, so an empty box means "leave them alone", not "delete them". The
// clearHeaders checkbox is the explicit way to remove them.
function formToInput(body, { keepHeadersIfEmpty = false } = {}) {
  const { headers, errors } = parseHeaderLines(body.headers);
  const method = String(body.method || 'GET').toUpperCase();
  const clearHeaders = body.clearHeaders === 'true';
  const omitHeaders = keepHeadersIfEmpty && !clearHeaders && Object.keys(headers).length === 0;
  return {
    omitHeaders,
    input: {
      name: typeof body.name === 'string' ? body.name : '',
      url: typeof body.url === 'string' ? body.url : '',
      method,
      intervalSeconds: toNumberOrNull(body.intervalSeconds),
      expectStatus: toNumberOrNull(body.expectStatus),
      enabled: body.enabled === 'true',
      capturePreview: body.capturePreview === 'true',
      headers,
      body: typeof body.body === 'string' && body.body.trim() ? body.body : null,
    },
    errors,
  };
}

function listHtml() {
  return views.targetListFragment(service.list());
}

// Success and failure both return 200 with fragments: the list is swapped into
// #target-list, while errors and the reset form ride along as out-of-band
// swaps. That keeps typed input intact when validation fails.
function respond(res, { errors = [], resetForm = false } = {}) {
  const parts = [views.errorsFragment(errors), listHtml()];
  if (resetForm) parts.push(views.formFragment(null, { oob: true }));
  res.type('html').send(parts.join('\n'));
}

router.get('/targets', (req, res) => {
  res.type('html').send(listHtml());
});

router.post('/targets', async (req, res, next) => {
  try {
    const { input, errors } = formToInput(req.body);
    if (errors.length) return respond(res, { errors });
    const result = await service.create(input);
    return respond(res, { errors: result.ok ? [] : result.errors, resetForm: result.ok });
  } catch (err) {
    return next(err);
  }
});

router.put('/targets/:id', async (req, res, next) => {
  try {
    const { input, errors, omitHeaders } = formToInput(req.body, { keepHeadersIfEmpty: true });
    if (errors.length) return respond(res, { errors });
    if (omitHeaders) delete input.headers;
    const result = await service.update(req.params.id, input);
    return respond(res, { errors: result.ok ? [] : result.errors, resetForm: result.ok });
  } catch (err) {
    return next(err);
  }
});

router.delete('/targets/:id', async (req, res, next) => {
  try {
    const result = await service.remove(req.params.id);
    return respond(res, { errors: result.ok ? [] : result.errors });
  } catch (err) {
    return next(err);
  }
});

router.post('/targets/:id/run', async (req, res, next) => {
  try {
    const result = await service.runNow(req.params.id);
    return respond(res, { errors: result.ok ? [] : result.errors });
  } catch (err) {
    return next(err);
  }
});

router.post('/targets/:id/toggle', async (req, res, next) => {
  try {
    const target = service.get(req.params.id);
    if (!target) return respond(res, { errors: ['target not found'] });
    const result = await service.update(req.params.id, { enabled: !target.enabled });
    return respond(res, { errors: result.ok ? [] : result.errors });
  } catch (err) {
    return next(err);
  }
});

router.get('/targets/:id/history', (req, res) => {
  const target = service.get(req.params.id);
  const entries = service.getHistory(req.params.id);
  if (!target || entries === null) {
    return res.type('html').status(404).send('<p class="text-error text-sm">Target not found.</p>');
  }
  return res.type('html').send(views.historyFragment(target, entries));
});

router.get('/form', (req, res) => {
  res.type('html').send(views.formFragment(null));
});

router.get('/form/:id', (req, res) => {
  const target = service.get(req.params.id);
  if (!target) return res.type('html').status(404).send(views.formFragment(null));
  return res.type('html').send(views.formFragment(target));
});

router.get('/blank', (req, res) => {
  res.type('html').send('');
});

module.exports = router;
