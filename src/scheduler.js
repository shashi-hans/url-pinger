'use strict';

const logger = require('./logger');

// targetId -> { timer, intervalMs, nextAt, inFlight }. The single source of
// truth for live timers.
const entries = new Map();

function isRunning(id) {
  return entries.has(id);
}

function nextRunAt(id) {
  const entry = entries.get(id);
  return entry ? new Date(entry.nextAt).toISOString() : null;
}

// Always clears any existing timer for this id first, so an update or a toggle
// can never leak a stale timer that keeps firing the old configuration.
// onTick is awaited, and a tick is skipped while the previous one is still in
// flight, so a slow target cannot pile up overlapping requests.
function schedule(target, onTick) {
  unschedule(target.id);
  const intervalMs = target.intervalSeconds * 1000;
  const entry = { timer: null, intervalMs, nextAt: Date.now() + intervalMs, inFlight: false };

  entry.timer = setInterval(async () => {
    entry.nextAt = Date.now() + intervalMs;
    if (entry.inFlight) {
      logger.warn(`Skipped tick for target ${target.id}: previous hit still running`);
      return;
    }
    entry.inFlight = true;
    try {
      await onTick(target.id);
    } catch (err) {
      logger.error(`Tick failed for target ${target.id}`, err);
    } finally {
      entry.inFlight = false;
    }
  }, intervalMs);

  // Do not hold the process open on the timer alone.
  if (typeof entry.timer.unref === 'function') entry.timer.unref();

  entries.set(target.id, entry);
  logger.info(`Scheduled target ${target.id} ("${target.name}") every ${target.intervalSeconds}s`);
  return entry;
}

function unschedule(id) {
  const entry = entries.get(id);
  if (!entry) return;
  clearInterval(entry.timer);
  entries.delete(id);
  logger.info(`Unscheduled target ${id}`);
}

function unscheduleAll() {
  for (const id of Array.from(entries.keys())) unschedule(id);
}

module.exports = { schedule, unschedule, unscheduleAll, isRunning, nextRunAt };
