import { describe, it, expect, beforeEach } from 'vitest';
import history from '../src/history.js';

// File mode, HISTORY_LIMIT=5 (see setup.js), 24-hour window.
const HOUR = 3600 * 1000;

function entry(msAgo, extra = {}) {
  return { at: new Date(Date.now() - msAgo).toISOString(), ok: true, status: 200, durationMs: 10, preview: 'p', ...extra };
}

beforeEach(() => history.clearAll());

describe('history window', () => {
  it('lists only hits from the last 24 hours, newest first', () => {
    history.record('t', entry(25 * HOUR));
    history.record('t', entry(2 * HOUR));
    history.record('t', entry(1 * HOUR));

    const { entries, total } = history.page('t', { offset: 0, limit: 100 });
    expect(total).toBe(2);
    expect(new Date(entries[0].at) > new Date(entries[1].at)).toBe(true);
  });

  it('keeps more than HISTORY_LIMIT hits inside the window and pages them', () => {
    for (let i = 12; i >= 1; i -= 1) history.record('t', entry(i * 60 * 1000));

    expect(history.page('t', { offset: 0, limit: 100 }).total).toBe(12);
    const second = history.page('t', { offset: 5, limit: 5 });
    expect(second.entries).toHaveLength(5);
    expect(history.page('t', { offset: 10, limit: 5 }).entries).toHaveLength(2);
  });

  it('keeps previews only on the newest HISTORY_LIMIT hits', () => {
    for (let i = 8; i >= 1; i -= 1) history.record('t', entry(i * 60 * 1000));
    const all = history.recent('t');
    expect(all.slice(0, 5).every((h) => h.preview === 'p')).toBe(true);
    expect(all.slice(5).every((h) => h.preview === null)).toBe(true);
  });

  it('computes card stats over the newest HISTORY_LIMIT hits only', () => {
    for (let i = 8; i >= 6; i -= 1) history.record('t', entry(i * 60 * 1000, { ok: false }));
    for (let i = 5; i >= 1; i -= 1) history.record('t', entry(i * 60 * 1000));
    const s = history.stats('t');
    expect(s.hits).toBe(5);
    expect(s.successRate).toBe(100);
  });
});
