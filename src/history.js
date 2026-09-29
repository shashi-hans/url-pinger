'use strict';

const config = require('./config');

// In-memory, per-target capped hit history (newest first). Capped to
// config.historyLimit so a long-running server cannot grow unbounded.
// History is deliberately not persisted: response previews can contain
// personal data and should not outlive the process.
const byTarget = new Map();

function record(targetId, entry) {
  const list = byTarget.get(targetId) || [];
  list.unshift(entry);
  if (list.length > config.historyLimit) list.length = config.historyLimit;
  byTarget.set(targetId, list);
  return entry;
}

function get(targetId, limit) {
  const list = byTarget.get(targetId) || [];
  const copy = list.slice();
  return typeof limit === 'number' ? copy.slice(0, limit) : copy;
}

// Rolling counters over the retained window, used for the dashboard row.
function stats(targetId) {
  const list = byTarget.get(targetId) || [];
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

module.exports = { record, get, stats, clear, clearAll };
