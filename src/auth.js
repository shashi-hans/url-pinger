'use strict';

const express = require('express');
const config = require('./config');
const logger = require('./logger');
const supabase = require('./supabaseClient');
const views = require('./views');
const { createLimiter } = require('./rateLimit');

// Session handling for Supabase mode. The browser holds the Supabase access
// and refresh tokens in httpOnly cookies; the server checks the access token
// with Supabase Auth and refreshes it when it expires. API clients can send
// `Authorization: Bearer <access token>` instead of cookies.
//
// In file mode there are no accounts: every request runs as LOCAL_ACTOR.

const ACCESS_COOKIE = 'sb_access';
const REFRESH_COOKIE = 'sb_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 86400 * 1000;
const LOCAL_ACTOR = Object.freeze({ userId: null, email: null, token: null });

// Verified tokens are cached briefly so HTMX polling does not cost one
// Supabase Auth round trip per request. Entries never outlive the token.
const TOKEN_CACHE_TTL_MS = 60 * 1000;
const TOKEN_CACHE_MAX = 1000;
const tokenCache = new Map();

// Concurrent requests holding the same expired token share one refresh call.
const refreshInFlight = new Map();

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    try {
      out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch (_) {
      /* malformed cookie value, ignore it */
    }
  }
  return out;
}

// Reads `exp` from a JWT without verifying it. Only used to bound the cache;
// the token itself is verified by Supabase Auth before it is cached.
function tokenExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch (_) {
    return 0;
  }
}

function cacheUser(token, user) {
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  const until = Math.min(Date.now() + TOKEN_CACHE_TTL_MS, tokenExpiryMs(token));
  if (until > Date.now()) tokenCache.set(token, { user, until });
}

async function verifyAccessToken(token) {
  if (!token) return null;
  const cached = tokenCache.get(token);
  if (cached && cached.until > Date.now()) return cached.user;
  tokenCache.delete(token);

  const { data, error } = await supabase.service().auth.getUser(token);
  if (error && isRetryable(error)) throw new Error(`Supabase token check failed: ${error.message}`);
  if (error || !data || !data.user) return null;
  cacheUser(token, data.user);
  return data.user;
}

// A network failure or a 5xx from Supabase Auth says nothing about the token,
// so it must not sign the user out.
function isRetryable(error) {
  return error.name === 'AuthRetryableFetchError' || error.status === 0 || error.status >= 500;
}

// Resolves to the new session, or null when the refresh token is rejected.
// Throws when Supabase Auth is unreachable, so the cookies are kept.
async function refresh(refreshToken) {
  if (!refreshInFlight.has(refreshToken)) {
    const call = supabase
      .anon()
      .auth.refreshSession({ refresh_token: refreshToken })
      .then(({ data, error }) => {
        if (error && isRetryable(error)) throw new Error(`Supabase session refresh failed: ${error.message}`);
        return error || !data || !data.session ? null : data.session;
      })
      .finally(() => refreshInFlight.delete(refreshToken));
    refreshInFlight.set(refreshToken, call);
  }
  return refreshInFlight.get(refreshToken);
}

function cookieOptions(maxAge) {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge };
}

function setSessionCookies(res, session) {
  res.cookie(ACCESS_COOKIE, session.access_token, cookieOptions(session.expires_in * 1000));
  res.cookie(REFRESH_COOKIE, session.refresh_token, cookieOptions(REFRESH_COOKIE_MAX_AGE_MS));
}

function clearSessionCookies(res) {
  const { maxAge: _unused, ...opts } = cookieOptions(0);
  res.clearCookie(ACCESS_COOKIE, opts);
  res.clearCookie(REFRESH_COOKIE, opts);
}

function actorFrom(user, token, viaCookie) {
  return { userId: user.id, email: user.email || null, token, viaCookie };
}

// Each unknown token costs one Supabase Auth call from this server's IP, so
// an IP that keeps sending rejected tokens is cut off for a while before it
// can use up the Auth rate limit that real users share.
const badTokensByIp = createLimiter({ limit: 30, windowMs: 15 * 60 * 1000 });

async function verifyFrom(req, token) {
  if (!token) return null;
  const ip = req.ip || 'unknown';
  if (!tokenCache.has(token) && badTokensByIp.blocked(ip)) return null;
  const user = await verifyAccessToken(token);
  if (!user) badTokensByIp.hit(ip);
  return user;
}

// Returns the signed-in actor, refreshing an expired cookie session, or null.
async function authenticate(req, res) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    const user = await verifyFrom(req, token);
    return user ? actorFrom(user, token, false) : null;
  }

  const cookies = parseCookies(req.headers.cookie);
  const access = cookies[ACCESS_COOKIE];
  const user = await verifyFrom(req, access);
  if (user) return actorFrom(user, access, true);

  const refreshToken = cookies[REFRESH_COOKIE];
  if (!refreshToken) return null;
  // A refresh costs one Supabase Auth call too, so rejected refresh tokens
  // count toward the same per-IP limit as rejected access tokens.
  const ip = req.ip || 'unknown';
  if (badTokensByIp.blocked(ip)) return null;
  const session = await refresh(refreshToken);
  if (!session) {
    badTokensByIp.hit(ip);
    clearSessionCookies(res);
    return null;
  }
  setSessionCookies(res, session);
  cacheUser(session.access_token, session.user);
  return actorFrom(session.user, session.access_token, true);
}

function rejectUnauthenticated(req, res, kind) {
  if (kind === 'api') return res.status(401).json({ errors: ['Not signed in'] });
  if (kind === 'ui') return res.status(401).set('HX-Redirect', '/login').send('');
  return res.redirect(302, '/login');
}

// Gate for a group of routes. kind is 'api', 'ui' or 'page' and picks how an
// unauthenticated request is answered.
// CSRF guard: state-changing requests must carry the HX-Request header. A
// cross-site form cannot set custom headers, and a cross-site fetch that sets
// one needs a CORS preflight this server never approves.
function missingHxHeader(req) {
  return UNSAFE_METHODS.has(req.method) && req.get('hx-request') !== 'true';
}

function rejectCsrf(res) {
  return res.status(403).json({ errors: ['Missing HX-Request header'] });
}

function requireUser(kind) {
  return async (req, res, next) => {
    if (!config.supabase.enabled) {
      // File mode has no login, so any page the local user opens could post
      // a plain form to /ui. The UI always sends HX-Request; the JSON API
      // only parses application/json, which a cross-site form cannot send.
      if (kind === 'ui' && missingHxHeader(req)) return rejectCsrf(res);
      req.actor = LOCAL_ACTOR;
      return next();
    }
    try {
      const actor = await authenticate(req, res);
      if (!actor) return rejectUnauthenticated(req, res, kind);

      // Cookie sessions only. Bearer-token clients are not affected.
      if (actor.viaCookie && missingHxHeader(req)) return rejectCsrf(res);

      req.actor = actor;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

const EMAIL_MAX = 254;
const PASSWORD_MAX = 256;

// Login throttling, so the app stays well under Supabase Auth's per-IP limits
// (every sign-in comes from this server's IP) and slows password guessing.
// Per IP counts every attempt; per email counts failures only.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginByIp = createLimiter({ limit: 20, windowMs: LOGIN_WINDOW_MS });
// Keyed by email and IP together, so a stranger cannot lock someone else out
// by guessing wrong passwords for their email from another address.
const loginFailuresByEmail = createLimiter({ limit: 5, windowMs: LOGIN_WINDOW_MS });
const TOO_MANY = 'Too many sign-in attempts. Try again in 15 minutes.';

function createAuthRouter() {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (!config.supabase.enabled) return res.redirect(302, '/');
    return res.type('html').send(views.loginPage());
  });

  router.post('/login', async (req, res, next) => {
    if (!config.supabase.enabled) return res.redirect(302, '/');
    // Login CSRF guard: a cross-site form must not sign the browser into
    // another account. Browsers that send Sec-Fetch-Site mark such posts.
    if (req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).type('html').send(views.loginPage({ error: 'Sign in from this site.' }));
    }
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!email || !password || email.length > EMAIL_MAX || password.length > PASSWORD_MAX) {
      return res.status(400).type('html').send(views.loginPage({ error: 'Enter your email and password.', email }));
    }
    const emailKey = `${email.toLowerCase()}|${req.ip || 'unknown'}`;
    // A locked email is refused before the password is tried, so a correct
    // guess after the lockout does not sign in.
    if (!loginByIp.hit(req.ip || 'unknown') || loginFailuresByEmail.blocked(emailKey)) {
      return res.status(429).type('html').send(views.loginPage({ error: TOO_MANY, email }));
    }
    try {
      const { data, error } = await supabase.anon().auth.signInWithPassword({ email, password });
      // An unreachable or failing Supabase Auth says nothing about the
      // password, so it neither counts toward the lockout nor reads as one.
      if (error && isRetryable(error)) {
        logger.warn('Supabase sign-in unavailable', error.message);
        return res
          .status(503)
          .type('html')
          .send(views.loginPage({ error: 'Sign-in is unavailable right now. Try again shortly.', email }));
      }
      if (error || !data || !data.session) {
        loginFailuresByEmail.hit(emailKey);
        // One message for every failure, so the page does not reveal which
        // emails have accounts.
        return res.status(401).type('html').send(views.loginPage({ error: 'Invalid email or password.', email }));
      }
      loginFailuresByEmail.reset(emailKey);
      setSessionCookies(res, data.session);
      cacheUser(data.session.access_token, data.session.user);
      return res.redirect(303, '/');
    } catch (err) {
      return next(err);
    }
  });

  // Called from the page with hx-post, so it passes the CSRF guard above.
  // Cookies are cleared even when the Supabase call fails, so the browser
  // always ends up signed out.
  router.post('/logout', requireUser('ui'), async (req, res) => {
    if (req.actor.token) {
      tokenCache.delete(req.actor.token);
      try {
        const { error } = await supabase.service().auth.admin.signOut(req.actor.token, 'local');
        if (error) logger.warn('Supabase sign-out failed', error.message);
      } catch (err) {
        logger.warn('Supabase sign-out failed', err.message);
      }
    }
    clearSessionCookies(res);
    return res.set('HX-Redirect', '/login').status(204).end();
  });

  return router;
}

module.exports = { requireUser, createAuthRouter, LOCAL_ACTOR, _parseCookies: parseCookies };
