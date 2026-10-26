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

const host = process.env.HOST || '127.0.0.1';
const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
const trustProxy = Math.max(0, intEnv(process.env.TRUST_PROXY, 0));

// Supabase mode turns on when all three values are set. Without them the app
// runs in local file mode: targets in targets.json, no login.
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const config = {
  port: intEnv(process.env.PORT, 3200),
  // Binds to loopback by default. In file mode the app has no authentication,
  // so exposing it on 0.0.0.0 hands anyone on the network a server-side
  // request engine.
  host,
  isLoopback,
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
  // Targets per account (the only account in file mode).
  maxTargets: Math.max(1, intEnv(process.env.MAX_TARGETS, 50)),
  // Targets across all accounts. One process runs every timer.
  maxTotalTargets: Math.max(1, intEnv(process.env.MAX_TOTAL_TARGETS, 500)),

  // Supabase mode: how often the target list is reloaded from the database
  // to pick up rows changed outside this process.
  targetSyncSeconds: Math.max(10, intEnv(process.env.TARGET_SYNC_SECONDS, 60)),

  // Number of reverse proxies in front of the app, for client IPs in the
  // login rate limit. 0 means the app is reached directly.
  trustProxy,

  // Per-hit network timeout.
  requestTimeoutMs: Math.max(1000, intEnv(process.env.REQUEST_TIMEOUT_MS, 10000)),

  // Newest hits per target used for the card stats and kept with previews.
  historyLimit: Math.max(1, intEnv(process.env.HISTORY_LIMIT, 100)),

  // The History panel lists hits from this many past hours, one page at a time.
  // Capped at 7 days: in file mode every hit in the window is held in memory.
  historyWindowHours: Math.min(168, Math.max(1, intEnv(process.env.HISTORY_WINDOW_HOURS, 24))),
  historyPageSize: Math.min(500, Math.max(1, intEnv(process.env.HISTORY_PAGE_SIZE, 100))),

  // Longest response body slice stored when a target opts into previews.
  previewLimit: Math.max(0, intEnv(process.env.PREVIEW_LIMIT, 500)),

  bodyLimit: process.env.BODY_LIMIT || '64kb',
  maxRequestBodyChars: Math.max(0, intEnv(process.env.MAX_REQUEST_BODY_CHARS, 10000)),

  // SSRF policy. When false, targets resolving to loopback, private ranges or
  // cloud metadata hostnames are rejected.
  allowPrivateTargets: boolEnv(process.env.ALLOW_PRIVATE_TARGETS, false),

  // When false, request header values are masked in API and UI responses.
  revealHeaderValues: boolEnv(process.env.REVEAL_HEADER_VALUES, false),

  supabase: {
    enabled: Boolean(supabaseUrl && supabaseAnonKey && supabaseServiceRoleKey),
    // Some but not all of the three values set: a configuration mistake.
    partial:
      Boolean(supabaseUrl || supabaseAnonKey || supabaseServiceRoleKey) &&
      !(supabaseUrl && supabaseAnonKey && supabaseServiceRoleKey),
    url: supabaseUrl,
    anonKey: supabaseAnonKey,
    // Bypasses Row Level Security. Server-side only: used by the scheduler,
    // which runs every user's targets without a user session.
    serviceRoleKey: supabaseServiceRoleKey,
  },

  // Stored hits older than this are deleted once on boot and then daily.
  hitRetentionDays: Math.max(1, intEnv(process.env.HIT_RETENTION_DAYS, 30)),

  // Session cookies carry the Supabase access token. Secure by default unless
  // the server only listens on loopback with no reverse proxy in front, where
  // plain http is the norm. A loopback app behind a proxy is usually served
  // over https.
  cookieSecure: boolEnv(process.env.COOKIE_SECURE, !isLoopback || trustProxy > 0),
};

module.exports = config;
