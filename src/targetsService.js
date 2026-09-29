'use strict';

const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const store = require('./store');
const history = require('./history');
const scheduler = require('./scheduler');
const runner = require('./runner');
const { validateTargetInput, BODYLESS_METHODS } = require('./validation');

// Gap between the one-off hits fired on boot.
const BOOT_HIT_SPACING_MS = 250;

let targets = [];

function findIndex(id) {
  return targets.findIndex((t) => t.id === id);
}

function find(id) {
  return targets.find((t) => t.id === id) || null;
}

// Header values can hold API tokens, so they are masked unless the operator
// opts in with REVEAL_HEADER_VALUES=true.
function maskHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = config.revealHeaderValues ? v : `••••(${v.length})`;
  }
  return out;
}

function toPublic(target) {
  const { headers, ...rest } = target;
  return {
    ...rest,
    headers: maskHeaders(headers),
    headerCount: Object.keys(headers || {}).length,
    scheduled: scheduler.isRunning(target.id),
    nextRunAt: scheduler.nextRunAt(target.id),
    stats: history.stats(target.id),
  };
}

function normalizeCreate(input) {
  const method = String(input.method || 'GET').toUpperCase();
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    url: input.url.trim(),
    method,
    headers: input.headers && typeof input.headers === 'object' ? { ...input.headers } : {},
    body: BODYLESS_METHODS.includes(method) ? null : (input.body ?? null) || null,
    intervalSeconds: Number(input.intervalSeconds),
    expectStatus: input.expectStatus != null ? Number(input.expectStatus) : null,
    enabled: input.enabled !== false,
    capturePreview: input.capturePreview === true,
    createdAt: now,
    updatedAt: now,
  };
}

function applyPatch(target, input) {
  const next = { ...target };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (has('name')) next.name = input.name.trim();
  if (has('url')) next.url = input.url.trim();
  if (has('method')) next.method = String(input.method || 'GET').toUpperCase();
  if (has('headers')) next.headers = input.headers ? { ...input.headers } : {};
  if (has('body')) next.body = input.body || null;
  if (has('intervalSeconds')) next.intervalSeconds = Number(input.intervalSeconds);
  if (has('expectStatus')) next.expectStatus = input.expectStatus != null ? Number(input.expectStatus) : null;
  if (has('enabled')) next.enabled = input.enabled;
  if (has('capturePreview')) next.capturePreview = input.capturePreview;

  if (BODYLESS_METHODS.includes(next.method)) next.body = null;
  next.updatedAt = new Date().toISOString();
  return next;
}

// Runs one hit and records it. Reads the target fresh each tick so an edit
// applied between ticks takes effect without recreating the timer.
async function tick(id) {
  const target = find(id);
  if (!target || !target.enabled) return null;
  const entry = await runner.hit(target);
  history.record(id, entry);
  const outcome = entry.ok ? 'ok' : `FAIL (${entry.error})`;
  logger.info(`HIT ${target.method} ${target.url} -> ${entry.status ?? '-'} ${entry.durationMs}ms ${outcome}`);
  return entry;
}

function applySchedule(target) {
  if (target.enabled) {
    scheduler.schedule(target, tick);
  } else {
    scheduler.unschedule(target.id);
  }
}

async function init() {
  targets = await store.loadTargets();
  scheduler.unscheduleAll();
  for (const target of targets) applySchedule(target);
  logger.info(`Loaded ${targets.length} target(s)`);

  // History lives in memory, so a restart leaves every row reading "never"
  // until its interval elapses, which is a day for a daily target. One hit
  // each on boot fills that in. They are spread out so a long list does not
  // fire every request in the same tick.
  targets
    .filter((t) => t.enabled)
    .forEach((target, index) => {
      const timer = setTimeout(() => {
        tick(target.id).catch((err) => logger.error(`Boot hit failed for target ${target.id}`, err));
      }, index * BOOT_HIT_SPACING_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });

  return targets;
}

function list() {
  return targets.map(toPublic);
}

function get(id) {
  const target = find(id);
  return target ? toPublic(target) : null;
}

async function create(input) {
  const check = validateTargetInput(input, { partial: false });
  if (!check.ok) return { ok: false, status: 400, errors: check.errors };
  if (targets.length >= config.maxTargets) {
    return { ok: false, status: 409, errors: [`target limit reached (max ${config.maxTargets})`] };
  }

  const target = normalizeCreate(input);
  targets.push(target);
  await store.saveTargets(targets);
  applySchedule(target);

  // First hit runs straight away, so a new target shows a result instead of
  // sitting on "waiting" for a whole interval. It is deliberately not awaited:
  // the response must not hang on a slow or timing-out endpoint.
  if (target.enabled) {
    tick(target.id).catch((err) => logger.error(`First hit failed for target ${target.id}`, err));
  }

  return { ok: true, status: 201, target: toPublic(target) };
}

async function update(id, input) {
  const index = findIndex(id);
  if (index === -1) return { ok: false, status: 404, errors: ['target not found'] };

  const check = validateTargetInput(input, { partial: true });
  if (!check.ok) return { ok: false, status: 400, errors: check.errors };

  const next = applyPatch(targets[index], input);
  targets[index] = next;
  await store.saveTargets(targets);
  applySchedule(next);
  return { ok: true, status: 200, target: toPublic(next) };
}

async function remove(id) {
  const index = findIndex(id);
  if (index === -1) return { ok: false, status: 404, errors: ['target not found'] };
  scheduler.unschedule(id);
  history.clear(id);
  targets.splice(index, 1);
  await store.saveTargets(targets);
  return { ok: true, status: 204 };
}

// Fires one hit immediately without disturbing the interval timer.
async function runNow(id) {
  const target = find(id);
  if (!target) return { ok: false, status: 404, errors: ['target not found'] };
  const entry = await runner.hit(target);
  history.record(id, entry);
  return { ok: true, status: 200, entry };
}

function getHistory(id, limit) {
  if (!find(id)) return null;
  return history.get(id, limit);
}

function shutdown() {
  scheduler.unscheduleAll();
}

// Test helper: drops in-memory state without touching the data file.
function _reset() {
  scheduler.unscheduleAll();
  history.clearAll();
  targets = [];
}

module.exports = {
  init,
  list,
  get,
  create,
  update,
  remove,
  runNow,
  getHistory,
  shutdown,
  _reset,
  _raw: () => targets,
};
