'use strict';

const express = require('express');
const service = require('../targetsService');
const views = require('../views');
const { requireUser } = require('../auth');

const router = express.Router();
router.use(requireUser('ui'));

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

// Joins the hour/minute/AM-PM selects into "h:mm AM". An empty hour means no
// time. Malformed parts pass through and are rejected by validation.
function timeFromParts(body, prefix) {
  const hour = body[`${prefix}Hour`];
  if (typeof hour !== 'string' || !hour.trim()) return null;
  const minute = typeof body[`${prefix}Minute`] === 'string' ? body[`${prefix}Minute`] : '00';
  const period = typeof body[`${prefix}Period`] === 'string' ? body[`${prefix}Period`] : 'AM';
  return `${hour.trim()}:${minute.trim()} ${period.trim()}`;
}

// Checkbox values arrive as missing, one string, or a list of strings.
function daysFromForm(value) {
  const list = value === undefined ? [] : [].concat(value);
  return list.map((v) => (/^\d$/.test(String(v)) ? Number(v) : v));
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
      onlineFrom: timeFromParts(body, 'onlineFrom'),
      onlineTo: timeFromParts(body, 'onlineTo'),
      offlineDays: daysFromForm(body.offlineDays),
      headers,
      body: typeof body.body === 'string' && body.body.trim() ? body.body : null,
    },
    errors,
  };
}

function listHtml(actor) {
  return views.targetListFragment(service.list(actor));
}

// Success and failure both return 200 with fragments: the list is swapped into
// #target-list, while errors and the reset form ride along as out-of-band
// swaps. That keeps typed input intact when validation fails.
function respond(req, res, { errors = [], resetForm = false } = {}) {
  const parts = [views.errorsFragment(errors), listHtml(req.actor)];
  if (resetForm) parts.push(views.formFragment(null, { oob: true }));
  res.type('html').send(parts.join('\n'));
}

router.get('/targets', (req, res) => {
  res.type('html').send(listHtml(req.actor));
});

router.post('/targets', async (req, res, next) => {
  try {
    const { input, errors } = formToInput(req.body);
    if (errors.length) return respond(req, res, { errors });
    const result = await service.create(req.actor, input);
    return respond(req, res, { errors: result.ok ? [] : result.errors, resetForm: result.ok });
  } catch (err) {
    return next(err);
  }
});

router.put('/targets/:id', async (req, res, next) => {
  try {
    const { input, errors, omitHeaders } = formToInput(req.body, { keepHeadersIfEmpty: true });
    if (errors.length) return respond(req, res, { errors });
    if (omitHeaders) delete input.headers;
    const result = await service.update(req.actor, req.params.id, input);
    return respond(req, res, { errors: result.ok ? [] : result.errors, resetForm: result.ok });
  } catch (err) {
    return next(err);
  }
});

router.delete('/targets/:id', async (req, res, next) => {
  try {
    const result = await service.remove(req.actor, req.params.id);
    return respond(req, res, { errors: result.ok ? [] : result.errors });
  } catch (err) {
    return next(err);
  }
});

router.post('/targets/:id/run', async (req, res, next) => {
  try {
    const result = await service.runNow(req.actor, req.params.id);
    return respond(req, res, { errors: result.ok ? [] : result.errors });
  } catch (err) {
    return next(err);
  }
});

router.post('/targets/:id/toggle', async (req, res, next) => {
  try {
    const result = await service.toggle(req.actor, req.params.id);
    return respond(req, res, { errors: result.ok ? [] : result.errors });
  } catch (err) {
    return next(err);
  }
});

router.get('/targets/:id/history', async (req, res, next) => {
  try {
    const target = service.get(req.actor, req.params.id);
    const page = Number.parseInt(req.query.page, 10);
    const result = target
      ? await service.getHistory(req.actor, req.params.id, { page: Number.isFinite(page) ? page : undefined })
      : null;
    if (!target || result === null) {
      return res.type('html').status(404).send('<p class="text-error text-sm">Target not found.</p>');
    }
    return res.type('html').send(views.historyFragment(target, result));
  } catch (err) {
    return next(err);
  }
});

router.get('/form', (req, res) => {
  res.type('html').send(views.formFragment(null));
});

router.get('/form/:id', (req, res) => {
  const target = service.get(req.actor, req.params.id);
  if (!target) return res.type('html').status(404).send(views.formFragment(null));
  return res.type('html').send(views.formFragment(target));
});

// Signed-in email and a sign-out button. Empty in file mode.
router.get('/me', (req, res) => {
  res.type('html').send(views.userFragment(req.actor));
});

router.get('/blank', (req, res) => {
  res.type('html').send('');
});

module.exports = router;
