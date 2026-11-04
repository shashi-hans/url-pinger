'use strict';

const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const history = require('./history');
const scheduler = require('./scheduler');
const runner = require('./runner');
const { isOffline, normalizeTime } = require('./availability');
const { validateTargetInput, BODYLESS_METHODS } = require('./validation');

// Gap between the one-off hits fired on boot.
const BOOT_HIT_SPACING_MS = 250;

let store = require('./store');

// Every target across all users, kept in memory because the scheduler needs
// them without a request. In file mode targets have no userId.
let targets = [];

// Supabase mode: an actor owns a target when the user ids match. File mode:
// both are null, so the single local actor owns everything.
function owns(actor, target) {
  return (target.userId || null) === (actor.userId || null);
}

function find(id) {
  return targets.find((t) => t.id === id) || null;
}

// Create, update, remove and the Supabase re-sync run one at a time. Each
// reads the in-memory list, awaits storage, then writes the list back, so two
// of them interleaving would lose a write or slip past the target limits.
let mutationChain = Promise.resolve();

function serialized(fn) {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.catch(() => {});
  return run;
}

// Ids already reported as skipped or invalid, so the periodic re-sync logs
// each once.
const reportedSkips = new Set();

function warnSkip(id, reason) {
  if (reportedSkips.has(id)) return;
  reportedSkips.add(id);
  logger.warn(`Ignoring stored target ${id}: ${reason}`);
}

// Prepares rows read from storage. File mode trusts targets.json; runner.js
// still applies the SSRF policy at hit time.
//
// Supabase rows can be written without going through this app, so each one
// gets the same checks as API input. A row that fails them, for example after
// MAX_INTERVAL_SECONDS was lowered, stays listed with `invalidReason` set so
// its owner can fix or delete it, but it is never scheduled. Rows are also
// held to the per-account and server-wide limits; rows arrive oldest first,
// so the newest rows over a limit are the ones dropped.
function loadable(rows) {
  const owned = rows.filter((t) => t && typeof t.id === 'string' && (!store.persistsHits || t.userId));
  if (!store.persistsHits) return owned;
  const perUser = new Map();
  const kept = [];
  for (const t of owned) {
    const check = validateTargetInput(t, { partial: false });
    if (check.ok) {
      delete t.invalidReason;
    } else {
      t.invalidReason = check.errors.join('; ');
      warnSkip(t.id, `not scheduled: ${t.invalidReason}`);
    }
    const count = perUser.get(t.userId) || 0;
    if (count >= config.maxTargets) {
      warnSkip(t.id, `account target limit reached (max ${config.maxTargets})`);
    } else if (kept.length >= config.maxTotalTargets) {
      warnSkip(t.id, `server target limit reached (max ${config.maxTotalTargets})`);
    } else {
      perUser.set(t.userId, count + 1);
      kept.push(t);
    }
  }
  return kept;
}

function findOwned(actor, id) {
  const target = find(id);
  return target && owns(actor, target) ? target : null;
}

// Header values can hold API tokens, so they are masked unless the operator
// opts in with REVEAL_HEADER_VALUES=true.
function maskHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    // A Supabase row written outside the app can hold a non-string value; it
    // is flagged invalid by loadable but must still render.
    out[k] = config.revealHeaderValues ? v : `••••(${typeof v === 'string' ? v.length : 0})`;
  }
  return out;
}

function toPublic(target) {
  const { headers, userId: _owner, ...rest } = target;
  return {
    ...rest,
    headers: maskHeaders(headers),
    headerCount: Object.keys(headers || {}).length,
    offlineNow: isOffline(target),
    scheduled: scheduler.isRunning(target.id),
    nextRunAt: scheduler.nextRunAt(target.id),
    stats: history.stats(target.id),
  };
}

function normalizeDays(days) {
  return Array.isArray(days) ? [...days].sort((a, b) => a - b) : [];
}

function normalizeCreate(actor, input) {
  const method = String(input.method || 'GET').toUpperCase();
  const now = new Date().toISOString();
  const target = {
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
    onlineFrom: normalizeTime(input.onlineFrom ?? null),
    onlineTo: normalizeTime(input.onlineTo ?? null),
    offlineDays: normalizeDays(input.offlineDays),
    createdAt: now,
    updatedAt: now,
  };
  if (actor.userId) target.userId = actor.userId;
  return target;
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
  if (has('onlineFrom')) next.onlineFrom = normalizeTime(input.onlineFrom ?? null);
  if (has('onlineTo')) next.onlineTo = normalizeTime(input.onlineTo ?? null);
  if (has('offlineDays')) next.offlineDays = normalizeDays(input.offlineDays);

  if (BODYLESS_METHODS.includes(next.method)) next.body = null;
  next.updatedAt = new Date().toISOString();
  return next;
}

// Keeps the hit in memory for the dashboard and, in Supabase mode, stores it.
// A storage failure is logged and does not fail the hit.
// A target removed while its hit was in flight records nothing: its history
// is already cleared and its row, with the hits foreign key, is gone.
async function record(target, entry) {
  if (!find(target.id)) return;
  history.record(target.id, entry);
  try {
    await store.recordHit(target, entry);
  } catch (err) {
    logger.error(`Could not store hit for target ${target.id}`, err.message);
  }
}

// Runs one hit and records it. Reads the target fresh each tick so an edit
// applied between ticks takes effect without recreating the timer. Ticks
// outside the target's online window or on its offline days are skipped; this also covers the
// automatic hits on create and on boot.
async function tick(id) {
  const target = find(id);
  if (!target || !target.enabled || target.invalidReason || isOffline(target)) return null;
  const entry = await runner.hit(target);
  await record(target, entry);
  const outcome = entry.ok ? 'ok' : `FAIL (${entry.error})`;
  logger.info(`HIT ${target.method} ${target.url} -> ${entry.status ?? '-'} ${entry.durationMs}ms ${outcome}`);
  return entry;
}

function applySchedule(target) {
  if (target.enabled && !target.invalidReason) {
    scheduler.schedule(target, tick);
  } else {
    scheduler.unschedule(target.id);
  }
}

// Deletes stored hits past the retention window. Runs on boot, then daily.
const PRUNE_EVERY_MS = 86400 * 1000;
let pruneTimer = null;

async function prune() {
  try {
    const removed = await store.pruneHits(config.hitRetentionDays);
    if (removed) logger.info(`Pruned ${removed} hit(s) older than ${config.hitRetentionDays} days`);
  } catch (err) {
    logger.error('Hit pruning failed', err.message);
  }
}

// Supabase mode: picks up rows changed outside this process (a deleted user,
// an edit in the dashboard) without a restart. Only the timers whose interval
// or enabled flag changed are rebuilt.
let syncTimer = null;

function syncFromStore() {
  return serialized(async () => {
    const fresh = loadable(await store.loadTargets());
    const freshIds = new Set(fresh.map((t) => t.id));
    for (const old of targets) {
      if (!freshIds.has(old.id)) {
        scheduler.unschedule(old.id);
        history.clear(old.id);
      }
    }
    const byId = new Map(targets.map((t) => [t.id, t]));
    for (const t of fresh) {
      const old = byId.get(t.id);
      if (
        !old ||
        old.enabled !== t.enabled ||
        old.intervalSeconds !== t.intervalSeconds ||
        (old.invalidReason || null) !== (t.invalidReason || null)
      ) {
        applySchedule(t);
      }
    }
    targets = fresh;
  }).catch((err) => logger.error('Target sync failed', err.message));
}

async function init() {
  targets = loadable(await store.loadTargets());
  shutdown();
  history.clearAll();
  for (const target of targets) applySchedule(target);
  logger.info(`Loaded ${targets.length} target(s) from ${store.name} storage`);

  if (store.persistsHits) {
    syncTimer = setInterval(syncFromStore, config.targetSyncSeconds * 1000);
    if (typeof syncTimer.unref === 'function') syncTimer.unref();

    // Card stats warm-up only. A failure here leaves the cards empty until
    // new hits arrive; it does not stop the server from starting.
    try {
      const recent = await store.loadRecentHits(config.historyLimit);
      // Oldest first, because history.record puts each entry at the front.
      for (const [targetId, entries] of recent) {
        for (const entry of entries.slice().reverse()) history.record(targetId, entry);
      }
    } catch (err) {
      logger.error('Could not load recent hits', err.message);
    }
    // Not awaited: a large backlog takes many batches and must not hold up
    // the server start. prune() logs its own failures.
    prune();
    pruneTimer = setInterval(prune, PRUNE_EVERY_MS);
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
  }

  // A target with no recorded hit would read "never" until its interval
  // elapses, which is a day for a daily target. One hit each on boot fills
  // that in. They are spread out so a long list does not fire every request
  // in the same tick.
  targets
    .filter((t) => t.enabled && !history.stats(t.id).last)
    .forEach((target, index) => {
      const timer = setTimeout(() => {
        tick(target.id).catch((err) => logger.error(`Boot hit failed for target ${target.id}`, err));
      }, index * BOOT_HIT_SPACING_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });

  return targets;
}

// Every public function takes the acting user first and only ever sees that
// user's targets. Another user's target id answers 404, the same as a missing
// one, so ids cannot be probed.
function list(actor) {
  return targets.filter((t) => owns(actor, t)).map(toPublic);
}

function get(actor, id) {
  const target = findOwned(actor, id);
  return target ? toPublic(target) : null;
}

function create(actor, input) {
  return serialized(() => createNow(actor, input));
}

async function createNow(actor, input) {
  const check = validateTargetInput(input, { partial: false });
  if (!check.ok) return { ok: false, status: 400, errors: check.errors };
  if (targets.filter((t) => owns(actor, t)).length >= config.maxTargets) {
    return { ok: false, status: 409, errors: [`target limit reached (max ${config.maxTargets})`] };
  }
  // One process runs every account's timers, so the server has its own cap.
  if (targets.length >= config.maxTotalTargets) {
    return { ok: false, status: 409, errors: ['server target limit reached, contact the operator'] };
  }

  const target = normalizeCreate(actor, input);
  await store.insertTarget(target, actor);
  targets.push(target);
  applySchedule(target);

  // First hit runs straight away, so a new target shows a result instead of
  // sitting on "waiting" for a whole interval. It is deliberately not awaited:
  // the response must not hang on a slow or timing-out endpoint.
  if (target.enabled) {
    tick(target.id).catch((err) => logger.error(`First hit failed for target ${target.id}`, err));
  }

  return { ok: true, status: 201, target: toPublic(target) };
}

function update(actor, id, input) {
  return serialized(() => updateNow(actor, id, input));
}

async function updateNow(actor, id, input) {
  const current = findOwned(actor, id);
  if (!current) return { ok: false, status: 404, errors: ['target not found'] };

  const check = validateTargetInput(input, { partial: true });
  if (!check.ok) return { ok: false, status: 400, errors: check.errors };

  const next = applyPatch(current, input);
  // The merged target must pass as a whole too: a stored target can be
  // invalid (see loadable, or a file-mode target saved under an older
  // policy), and a patch that leaves it invalid is refused. Pausing is the
  // exception, so a target that fails the current rules can still be stopped.
  const whole = validateTargetInput(next, { partial: false });
  const pauseOnly = Object.keys(input).length === 1 && input.enabled === false;
  if (!whole.ok && !pauseOnly) return { ok: false, status: 400, errors: whole.errors };
  if (whole.ok) delete next.invalidReason;
  await store.updateTarget(next, actor);
  targets = targets.map((t) => (t.id === id ? next : t));
  applySchedule(next);
  return { ok: true, status: 200, target: toPublic(next) };
}

function remove(actor, id) {
  return serialized(() => removeNow(actor, id));
}

async function removeNow(actor, id) {
  const target = findOwned(actor, id);
  if (!target) return { ok: false, status: 404, errors: ['target not found'] };
  await store.deleteTarget(target, actor);
  scheduler.unschedule(id);
  history.clear(id);
  targets = targets.filter((t) => t.id !== id);
  return { ok: true, status: 204 };
}

// Flips enabled inside the lock, so two quick clicks cannot both read the
// same state and cancel out.
function toggle(actor, id) {
  return serialized(() => {
    const current = findOwned(actor, id);
    if (!current) return { ok: false, status: 404, errors: ['target not found'] };
    return updateNow(actor, id, { enabled: !current.enabled });
  });
}

// Fires one hit immediately without disturbing the interval timer.
async function runNow(actor, id) {
  const target = findOwned(actor, id);
  if (!target) return { ok: false, status: 404, errors: ['target not found'] };
  if (target.invalidReason) return { ok: false, status: 409, errors: [`fix this target first: ${target.invalidReason}`] };
  const entry = await runner.hit(target);
  await record(target, entry);
  return { ok: true, status: 200, entry };
}

// One page of the hits inside the history window, newest first. Supabase mode
// reads the database; previews, which are never stored there, are filled in
// from memory for the newest hits. File mode reads memory.
async function getHistory(actor, id, { page = 1, pageSize = config.historyPageSize } = {}) {
  const target = findOwned(actor, id);
  if (!target) return null;

  const size = Math.min(config.historyPageSize, Math.max(1, Math.floor(pageSize) || config.historyPageSize));
  // Capped so the offset stays a plain integer; a huge page number would
  // otherwise reach PostgREST as "1e+300" and fail instead of reading empty.
  const pageNo = Math.min(Math.floor(Number.MAX_SAFE_INTEGER / size), Math.max(1, Math.floor(page) || 1));
  const offset = (pageNo - 1) * size;
  const sinceIso = new Date(history.windowStartMs()).toISOString();

  let result = await store.listHits(target, actor, { sinceIso, offset, limit: size });
  if (result) {
    const previews = new Map(history.recent(id).filter((h) => h.preview != null).map((h) => [h.at, h.preview]));
    result = {
      ...result,
      entries: result.entries.map((e) => (previews.has(e.at) ? { ...e, preview: previews.get(e.at) } : e)),
    };
  } else {
    result = history.page(id, { offset, limit: size });
  }

  return {
    entries: result.entries,
    total: result.total,
    page: pageNo,
    pageSize: size,
    pages: Math.max(1, Math.ceil(result.total / size)),
    windowHours: config.historyWindowHours,
  };
}

function shutdown() {
  scheduler.unscheduleAll();
  if (pruneTimer) clearInterval(pruneTimer);
  if (syncTimer) clearInterval(syncTimer);
  pruneTimer = null;
  syncTimer = null;
}

// Test helper: drops in-memory state without touching the data file.
function _reset() {
  shutdown();
  history.clearAll();
  targets = [];
  if (typeof store._reset === 'function') store._reset();
}

// Test helper: swaps the storage backend.
function _useStore(next) {
  store = next;
}

module.exports = {
  init,
  list,
  get,
  create,
  update,
  remove,
  toggle,
  runNow,
  getHistory,
  shutdown,
  _reset,
  _useStore,
  _syncFromStore: syncFromStore,
  _raw: () => targets,
};
