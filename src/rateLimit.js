'use strict';

// Fixed-window counter per key, in memory. Enough for one process; several
// instances would each keep their own counts.
function createLimiter({ limit, windowMs, maxKeys = 10000 }) {
  const buckets = new Map();

  function prune(now) {
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
    // Still full after pruning: evict keys that are not locked out, oldest
    // first. Clearing everything would let a flood of new keys reset the
    // lockouts it is meant to protect.
    for (const [key, b] of buckets) {
      if (buckets.size < maxKeys) return;
      if (b.count < limit) buckets.delete(key);
    }
    // Every remaining key is locked out: drop the oldest to stay bounded.
    for (const key of buckets.keys()) {
      if (buckets.size < maxKeys) return;
      buckets.delete(key);
    }
  }

  // Counts one attempt. Returns false once the key is over the limit.
  function hit(key, now = Date.now()) {
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      if (buckets.size >= maxKeys) prune(now);
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    return b.count <= limit;
  }

  // True while the key has used up its limit in the current window. Does not
  // count an attempt.
  function blocked(key, now = Date.now()) {
    const b = buckets.get(key);
    return Boolean(b && b.resetAt > now && b.count >= limit);
  }

  function reset(key) {
    buckets.delete(key);
  }

  return { hit, blocked, reset };
}

module.exports = { createLimiter };
