'use strict';

const config = require('./config');

// In-memory, per-target hit history (newest first).
//
// File mode: this is the only copy, so it keeps every hit inside the history
// window (HISTORY_WINDOW_HOURS). Supabase mode: the database holds the window,
// so memory keeps only the newest HISTORY_LIMIT hits for the card stats.
//
// History is deliberately not persisted by this module: response previews can
// contain personal data and should not outlive the process. Previews are kept
// only on the newest HISTORY_LIMIT entries, which bounds the memory they use.
const byTarget = new Map();

function windowStartMs() {
  return Date.now() - config.historyWindowHours * 3600 * 1000;
}

function record(targetId, entry) {
  const list = byTarget.get(targetId) || [];
  list.unshift(entry);

  if (list.length > config.historyLimit) list[config.historyLimit].preview = null;

  if (config.supabase.enabled) {
    if (list.length > config.historyLimit) list.length = config.historyLimit;
  } else {
    const start = windowStartMs();
    while (list.length && new Date(list[list.length - 1].at).getTime() < start) list.pop();
  }

  byTarget.set(targetId, list);
  return entry;
}

// Newest `limit` entries, for warm-up checks and preview lookups.
function recent(targetId, limit) {
  const list = byTarget.get(targetId) || [];
  return typeof limit === 'number' ? list.slice(0, limit) : list.slice();
}

// One page of the hits inside the history window, newest first. Entries are
// filtered at read time too, because a paused target records nothing and so
// never prunes.
function page(targetId, { offset, limit }) {
  const start = windowStartMs();
  const inWindow = (byTarget.get(targetId) || []).filter((h) => new Date(h.at).getTime() >= start);
  return { entries: inWindow.slice(offset, offset + limit), total: inWindow.length };
}

// Rolling counters over the newest HISTORY_LIMIT hits, used for the card.
function stats(targetId) {
  const list = (byTarget.get(targetId) || []).slice(0, config.historyLimit);
  if (list.length === 0) {
    return { hits: 0, okCount: 0, successRate: null, avgDurationMs: null, last: null };
  }
  const okCount = list.filter((h) => h.ok).length;
  const total = list.reduce((sum, h) => sum + (h.durationMs || 0), 0);
  return {
    hits: list.length,
    okCount,
    successRate: Math.round((okCount / list.length) * 1000) / 10,
    avgDurationMs: Math.round(total / list.length),
    last: list[0],
  };
}

function clear(targetId) {
  byTarget.delete(targetId);
}

function clearAll() {
  byTarget.clear();
}

module.exports = { windowStartMs, record, recent, page, stats, clear, clearAll };
