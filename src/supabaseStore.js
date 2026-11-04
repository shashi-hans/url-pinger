'use strict';

const supabase = require('./supabaseClient');

// Supabase backend. Tables and Row Level Security policies are defined in
// supabase/migrations. Writes made on behalf of a user go through a client
// carrying that user's access token, so Postgres enforces ownership as well as
// the app. Background work (boot load, hits, pruning) uses the service role.

function toRow(t) {
  return {
    id: t.id,
    user_id: t.userId,
    name: t.name,
    url: t.url,
    method: t.method,
    headers: t.headers || {},
    body: t.body,
    interval_seconds: t.intervalSeconds,
    expect_status: t.expectStatus,
    enabled: t.enabled,
    capture_preview: t.capturePreview,
    online_from: t.onlineFrom ?? null,
    online_to: t.onlineTo ?? null,
    offline_days: t.offlineDays || [],
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

function fromRow(r) {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    url: r.url,
    method: r.method,
    headers: r.headers || {},
    body: r.body,
    intervalSeconds: r.interval_seconds,
    expectStatus: r.expect_status,
    enabled: r.enabled,
    capturePreview: r.capture_preview,
    onlineFrom: r.online_from ?? null,
    onlineTo: r.online_to ?? null,
    offlineDays: r.offline_days || [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Response previews are left out on purpose: they can hold personal data, so
// they stay in process memory only.
function hitToRow(target, entry) {
  return {
    target_id: target.id,
    user_id: target.userId,
    at: entry.at,
    ok: entry.ok,
    status: entry.status,
    duration_ms: entry.durationMs,
    bytes: entry.bytes,
    error: entry.error,
    error_kind: entry.errorKind,
  };
}

function hitFromRow(r) {
  return {
    at: new Date(r.at).toISOString(),
    ok: r.ok,
    status: r.status,
    durationMs: r.duration_ms,
    bytes: r.bytes,
    preview: null,
    error: r.error,
    errorKind: r.error_kind,
  };
}

function check(result, action) {
  if (result.error) {
    const err = new Error(`Supabase ${action} failed: ${result.error.message}`);
    err.cause = result.error;
    throw err;
  }
  return result;
}

// A missing row after an RLS-scoped write means the user does not own it.
function checkOneRow(result, action) {
  check(result, action);
  if (!result.data || result.data.length !== 1) {
    throw new Error(`Supabase ${action} affected ${result.data ? result.data.length : 0} rows, expected 1`);
  }
  return result;
}

// PostgREST caps one response at 1000 rows by default, so bulk reads page.
// `query(from, to)` builds one page request; callers order the rows so pages
// stay stable.
const PAGE = 1000;

async function readAllPages(query, action) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const res = check(await query(from, from + PAGE - 1), action);
    rows.push(...res.data);
    if (res.data.length < PAGE) return rows;
  }
}

// Deletes in batches through a SQL function that returns how many rows it
// removed, so a large backlog never becomes one statement long enough to hit
// the statement timeout. Returns the total removed.
const BATCH = 10000;
const MAX_BATCHES = 1000;

async function deleteInBatches(fn, args, action) {
  let removed = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const res = check(await supabase.service().rpc(fn, { ...args, batch_size: BATCH }), action);
    const n = Number(res.data) || 0;
    removed += n;
    if (n < BATCH) break;
  }
  return removed;
}

// Ordering ends on id so paging is stable when two rows share created_at.
async function loadTargets() {
  const rows = await readAllPages(
    (from, to) => supabase.service().from('targets').select('*').order('created_at').order('id').range(from, to),
    'load targets'
  );
  return rows.map(fromRow);
}

async function insertTarget(target, actor) {
  checkOneRow(await supabase.asUser(actor.token).from('targets').insert(toRow(target)).select('id'), 'insert target');
}

async function updateTarget(target, actor) {
  const { id, user_id: _owner, created_at: _created, ...fields } = toRow(target);
  checkOneRow(
    await supabase.asUser(actor.token).from('targets').update(fields).eq('id', id).select('id'),
    'update target'
  );
}

// A busy target can have hundreds of thousands of hits, and the cascade from
// one DELETE would run past the statement timeout. The hits are removed in
// batches first (service role; the caller has already checked ownership),
// then the target row is deleted as the user so Row Level Security applies.
async function deleteTarget(target, actor) {
  await deleteInBatches('delete_target_hits', { target: target.id }, 'delete target hits');
  checkOneRow(
    await supabase.asUser(actor.token).from('targets').delete().eq('id', target.id).select('id'),
    'delete target'
  );
}

// Newest `perTarget` hits for every target, via the recent_hits SQL function
// (one window query instead of one request per target).
async function loadRecentHits(perTarget) {
  const rows = await readAllPages(
    (from, to) => supabase.service().rpc('recent_hits', { per_target: perTarget }).range(from, to),
    'load recent hits'
  );
  const byTarget = new Map();
  for (const row of rows) {
    const list = byTarget.get(row.target_id) || [];
    list.push(hitFromRow(row));
    byTarget.set(row.target_id, list);
  }
  return byTarget;
}

// One page of a target's hits since `sinceIso`, newest first, read as the
// user so Row Level Security applies.
async function listHits(target, actor, { sinceIso, offset, limit }) {
  const query = (columns, options) =>
    supabase
      .asUser(actor.token)
      .from('hits')
      .select(columns, options)
      .eq('target_id', target.id)
      .gte('at', sinceIso);
  const res = await query('*', { count: 'exact' })
    .order('at', { ascending: false })
    .range(offset, offset + limit - 1);
  // PostgREST answers 416 (PGRST103) for an offset past the last row, e.g. a
  // page whose hits have aged out of the window. That is an empty page.
  if (res.error && res.error.code === 'PGRST103') {
    const counted = check(await query('id', { count: 'exact', head: true }), 'count hits');
    return { entries: [], total: counted.count || 0 };
  }
  check(res, 'list hits');
  return { entries: res.data.map(hitFromRow), total: res.count || 0 };
}

async function recordHit(target, entry) {
  check(await supabase.service().from('hits').insert(hitToRow(target, entry)), 'record hit');
}

async function pruneHits(days) {
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  return deleteInBatches('prune_hits', { cutoff }, 'prune hits');
}

module.exports = {
  name: 'supabase',
  persistsHits: true,
  loadTargets,
  insertTarget,
  updateTarget,
  deleteTarget,
  loadRecentHits,
  listHits,
  recordHit,
  pruneHits,
  _mapping: { toRow, fromRow, hitToRow, hitFromRow },
};
