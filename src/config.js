'use strict';

// Load .env if present. Never throws when the file is missing.
try {
  require('dotenv').config();
} catch (_) {
  /* dotenv is optional at runtime */
}

const path = require('path');

function boolEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function intEnv(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const projectRoot = path.join(__dirname, '..');
const dataDir = process.env.DATA_DIR
  ? path.resolve(projectRoot, process.env.DATA_DIR)
  : path.join(projectRoot, 'data');

const config = {
  port: intEnv(process.env.PORT, 3200),
  // Binds to loopback by default. The app has no authentication, so exposing
  // it on 0.0.0.0 hands anyone on the network a server-side request engine.
  host: process.env.HOST || '127.0.0.1',
  dataDir,
  targetsFile: path.join(dataDir, 'targets.json'),

  // Smallest interval a target may use. Guards against one target saturating
  // the event loop or hammering a third party.
  minIntervalSeconds: Math.max(1, intEnv(process.env.MIN_INTERVAL_SECONDS, 5)),
  // Capped at 24 days because setInterval stores its delay in a signed 32-bit
  // integer of milliseconds and wraps above that.
  maxIntervalSeconds: Math.min(
    2073600,
    Math.max(60, intEnv(process.env.MAX_INTERVAL_SECONDS, 604800))
  ),
  maxTargets: Math.max(1, intEnv(process.env.MAX_TARGETS, 50)),

  // Per-hit network timeout.
  requestTimeoutMs: Math.max(1000, intEnv(process.env.REQUEST_TIMEOUT_MS, 10000)),

  // Hits kept in memory per target (newest first).
  historyLimit: Math.max(1, intEnv(process.env.HISTORY_LIMIT, 100)),

  // Longest response body slice stored when a target opts into previews.
  previewLimit: Math.max(0, intEnv(process.env.PREVIEW_LIMIT, 500)),

  bodyLimit: process.env.BODY_LIMIT || '64kb',
  maxRequestBodyChars: Math.max(0, intEnv(process.env.MAX_REQUEST_BODY_CHARS, 10000)),

  // SSRF policy. When false, targets resolving to loopback, private ranges or
  // cloud metadata hostnames are rejected.
  allowPrivateTargets: boolEnv(process.env.ALLOW_PRIVATE_TARGETS, false),

  // When false, request header values are masked in API and UI responses.
  revealHeaderValues: boolEnv(process.env.REVEAL_HEADER_VALUES, false),
};

module.exports = config;
