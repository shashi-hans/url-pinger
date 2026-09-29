'use strict';

const config = require('./config');
const { validateTargetUrl, BODYLESS_METHODS } = require('./validation');

// Performs one HTTP hit for a target and returns a history entry.
// Never throws: transport failures are recorded as entries with ok=false.
async function hit(target) {
  const startedAt = new Date();
  const t0 = Date.now();

  // Re-validate at execution time. The stored config is treated as untrusted
  // and the SSRF policy may have changed since the target was saved.
  const check = validateTargetUrl(target.url);
  if (!check.ok) {
    return failure(startedAt, Date.now() - t0, check.error, 'blocked');
  }

  const method = (target.method || 'GET').toUpperCase();
  const headers = { ...(target.headers || {}) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const init = {
      method,
      headers,
      signal: controller.signal,
      // Redirects are reported, not followed: following one would let a 302
      // point the request at an address the SSRF guard already rejected.
      redirect: 'manual',
    };
    if (!BODYLESS_METHODS.includes(method) && target.body != null && target.body !== '') {
      init.body = target.body;
      const hasType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type');
      if (!hasType) headers['content-type'] = 'application/json';
    }

    const res = await fetch(target.url, init);
    const durationMs = Date.now() - t0;

    let preview = null;
    let bytes = null;
    if (target.capturePreview && config.previewLimit > 0) {
      try {
        const text = await res.text();
        bytes = Buffer.byteLength(text);
        preview = text.slice(0, config.previewLimit);
      } catch (_) {
        /* reading the body is best-effort */
      }
    } else {
      // Drain the socket so the connection is released.
      if (res.body && typeof res.body.cancel === 'function') {
        await res.body.cancel().catch(() => {});
      }
      const len = Number(res.headers.get('content-length'));
      bytes = Number.isFinite(len) ? len : null;
    }

    const ok = target.expectStatus
      ? res.status === target.expectStatus
      : res.status >= 200 && res.status < 400;

    return {
      at: startedAt.toISOString(),
      ok,
      status: res.status,
      durationMs,
      bytes,
      preview,
      error: ok ? null : `Unexpected HTTP ${res.status}`,
      errorKind: ok ? null : 'status',
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    if (err.name === 'AbortError') {
      return failure(startedAt, durationMs, `Timed out after ${config.requestTimeoutMs}ms`, 'timeout');
    }
    // fetch wraps DNS, TLS and connection problems in a generic TypeError.
    const detail = err.cause && err.cause.code ? `${err.message} (${err.cause.code})` : err.message;
    return failure(startedAt, durationMs, detail, 'network');
  } finally {
    clearTimeout(timer);
  }
}

function failure(startedAt, durationMs, error, errorKind) {
  return {
    at: startedAt.toISOString(),
    ok: false,
    status: null,
    durationMs,
    bytes: null,
    preview: null,
    error,
    errorKind,
  };
}

module.exports = { hit };
