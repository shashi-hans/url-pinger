'use strict';

const config = require('./config');
const { normalizeTime } = require('./availability');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODYLESS_METHODS = ['GET', 'HEAD'];
const MAX_HEADERS = 25;
const MAX_HEADER_NAME = 128;
const MAX_HEADER_VALUE = 2048;
const MAX_URL_LENGTH = 2048;

// Literal-hostname SSRF guard. It does not resolve DNS, so a public hostname
// that resolves to a private address (DNS rebinding) is not caught here. That
// residual risk is documented in the README.
function isPrivateHostname(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]' || h === '::') return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === 'metadata.google.internal') return true;

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return true; // malformed, so block
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local and cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  // Bare or bracketed IPv6 unique-local and link-local ranges.
  const v6 = h.replace(/^\[|\]$/g, '');
  if (/^(fc|fd|fe8|fe9|fea|feb)/.test(v6)) return true;
  return false;
}

function validateTargetUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, error: 'url is required' };
  }
  if (url.length > MAX_URL_LENGTH) {
    return { ok: false, error: `url is too long (max ${MAX_URL_LENGTH})` };
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch (_) {
    return { ok: false, error: 'url is not a valid URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'url must use http or https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'url must not embed credentials' };
  }
  if (!config.allowPrivateTargets && isPrivateHostname(parsed.hostname)) {
    return {
      ok: false,
      error:
        'url points at a private or internal address (blocked for SSRF protection). ' +
        'Set ALLOW_PRIVATE_TARGETS=true to allow internal targets.',
    };
  }
  return { ok: true };
}

function validateHeaders(headers) {
  const errors = [];
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    return ['headers must be an object of string values'];
  }
  const keys = Object.keys(headers);
  if (keys.length > MAX_HEADERS) {
    errors.push(`too many headers (max ${MAX_HEADERS})`);
  }
  for (const key of keys) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || key.length > MAX_HEADER_NAME) {
      errors.push(`header name "${key.slice(0, 40)}" is not a valid HTTP header name`);
      break;
    }
    const value = headers[key];
    if (typeof value !== 'string') {
      errors.push('headers values must be strings');
      break;
    }
    if (value.length > MAX_HEADER_VALUE) {
      errors.push(`header "${key}" value is too long (max ${MAX_HEADER_VALUE})`);
      break;
    }
    if (/[\r\n]/.test(value)) {
      errors.push(`header "${key}" value must not contain line breaks`);
      break;
    }
  }
  return errors;
}

function validateInterval(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return 'intervalSeconds must be a whole number of seconds';
  if (n < config.minIntervalSeconds) {
    return `intervalSeconds must be at least ${config.minIntervalSeconds}`;
  }
  if (n > config.maxIntervalSeconds) {
    return `intervalSeconds must be at most ${config.maxIntervalSeconds}`;
  }
  return null;
}

// Validates a create (partial false) or patch (partial true) payload.
// Returns the errors only; normalization happens in targetsService.
function validateTargetInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['request body must be a JSON object'] };
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const errors = [];

  if (!partial || has('name')) {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      errors.push('name is required');
    } else if (input.name.length > 120) {
      errors.push('name is too long (max 120)');
    }
  }

  if (!partial || has('url')) {
    const r = validateTargetUrl(input.url);
    if (!r.ok) errors.push(r.error);
  }

  if (!partial || has('intervalSeconds')) {
    const err = validateInterval(input.intervalSeconds);
    if (err) errors.push(err);
  }

  if (has('method') && input.method != null) {
    if (!HTTP_METHODS.includes(String(input.method).toUpperCase())) {
      errors.push(`method must be one of: ${HTTP_METHODS.join(', ')}`);
    }
  }

  if (has('headers') && input.headers != null) {
    errors.push(...validateHeaders(input.headers));
  }

  if (has('body') && input.body != null) {
    if (typeof input.body !== 'string') {
      errors.push('body must be a string');
    } else if (input.body.length > config.maxRequestBodyChars) {
      errors.push(`body is too long (max ${config.maxRequestBodyChars} characters)`);
    }
  }

  if (has('expectStatus') && input.expectStatus != null) {
    const n = Number(input.expectStatus);
    if (!Number.isInteger(n) || n < 100 || n > 599) {
      errors.push('expectStatus must be an HTTP status code between 100 and 599');
    }
  }

  // Online window: both times, as "HH:MM" or "h:mm AM/PM" (IST), or both
  // null for always online. They are sent together so a patch cannot leave
  // half a window.
  if (has('onlineFrom') || has('onlineTo')) {
    const from = input.onlineFrom ?? null;
    const to = input.onlineTo ?? null;
    if (!has('onlineFrom') || !has('onlineTo')) {
      errors.push('onlineFrom and onlineTo must be sent together');
    } else if ((from === null) !== (to === null)) {
      errors.push('set both online times, or clear both');
    } else if (from !== null && (normalizeTime(from) === null || normalizeTime(to) === null)) {
      errors.push('online times must be like 09:00 or 9:00 AM');
    } else if (from !== null && normalizeTime(from) === normalizeTime(to)) {
      errors.push('online start and end must differ');
    }
  }

  if (has('offlineDays') && input.offlineDays != null) {
    const days = input.offlineDays;
    if (!Array.isArray(days) || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      errors.push('offlineDays must be a list of weekday numbers, 0 (Sunday) to 6 (Saturday)');
    } else if (new Set(days).size !== days.length) {
      errors.push('offlineDays must not repeat a day');
    } else if (days.length === 7) {
      errors.push('offlineDays cannot cover every day; pause the target instead');
    }
  }

  for (const flag of ['enabled', 'capturePreview']) {
    if (has(flag) && typeof input[flag] !== 'boolean') {
      errors.push(`${flag} must be a boolean`);
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  HTTP_METHODS,
  BODYLESS_METHODS,
  isPrivateHostname,
  validateTargetUrl,
  validateHeaders,
  validateInterval,
  validateTargetInput,
};
