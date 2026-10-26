'use strict';

const config = require('./config');

// Loaded on first use, so file mode never loads the Supabase SDK.
function createClient(...args) {
  return require('@supabase/supabase-js').createClient(...args);
}

// Server-side clients never persist or auto-refresh a session: sessions live
// in the browser's cookies, and one shared client must not hold any user's
// session.
const SERVER_AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

// supabase-js sets no request timeout, and undici waits up to 300 s for a
// hung response. Every Supabase call gets a bound, so a stuck database write
// cannot hold a scheduler tick or the mutation lock open.
const SUPABASE_TIMEOUT_MS = 15000;

function timedFetch(input, init = {}) {
  return fetch(input, { ...init, signal: init.signal || AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
}

let serviceClient = null;

// Service-role client. Bypasses Row Level Security. It is used for work that
// spans every account (boot load, re-sync, hit inserts, pruning) and for
// deleting a target's hits after the service has checked ownership.
function service() {
  if (!serviceClient) {
    serviceClient = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: SERVER_AUTH,
      global: { fetch: timedFetch },
    });
  }
  return serviceClient;
}

// Fresh anon client for one auth call (sign-in, refresh). signInWithPassword
// and refreshSession store the session on the client instance, so a shared
// instance would leak one user's session into another request.
function anon() {
  return createClient(config.supabase.url, config.supabase.anonKey, { auth: SERVER_AUTH, global: { fetch: timedFetch } });
}

// Client acting as the signed-in user. Row Level Security applies, so a query
// can only touch that user's rows even if the app-level filter is missed.
// Clients are reused per token (a token lives about an hour), so History
// paging and edits do not build a new client each call.
const USER_CLIENT_MAX = 200;
const userClients = new Map();

function asUser(accessToken) {
  let client = userClients.get(accessToken);
  if (!client) {
    if (userClients.size >= USER_CLIENT_MAX) userClients.delete(userClients.keys().next().value);
    client = createClient(config.supabase.url, config.supabase.anonKey, {
      auth: SERVER_AUTH,
      global: { fetch: timedFetch, headers: { Authorization: `Bearer ${accessToken}` } },
    });
    userClients.set(accessToken, client);
  }
  return client;
}

module.exports = { service, anon, asUser };
