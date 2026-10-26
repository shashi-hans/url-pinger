'use strict';

const config = require('./config');

// Picks the storage backend. Both expose the same functions; see fileStore.js
// and supabaseStore.js.
module.exports = config.supabase.enabled ? require('./supabaseStore') : require('./fileStore');
