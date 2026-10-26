'use strict';

const fs = require('fs');
const fsp = fs.promises;
const config = require('./config');

// Local file backend: the whole target list lives in targets.json. Hits are
// not persisted, because response previews can contain personal data and
// should not outlive the process.

let targets = [];

async function ensureDir() {
  await fsp.mkdir(config.dataDir, { recursive: true });
}

// An offline window [offlineFrom, offlineTo) is the same schedule as the
// online window [offlineTo, offlineFrom), so older entries convert exactly.
// Returns true when the target was changed.
function upgradeOfflineWindow(target) {
  if (!('offlineFrom' in target) && !('offlineTo' in target)) return false;
  const { offlineFrom = null, offlineTo = null } = target;
  delete target.offlineFrom;
  delete target.offlineTo;
  if (target.onlineFrom == null && offlineFrom && offlineTo) {
    target.onlineFrom = offlineTo;
    target.onlineTo = offlineFrom;
  }
  return true;
}

// Loads the persisted target list. Missing file means a fresh install.
async function loadTargets() {
  await ensureDir();
  try {
    const raw = await fsp.readFile(config.targetsFile, 'utf8');
    const parsed = JSON.parse(raw);
    targets = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    targets = [];
  }
  const upgraded = targets.map(upgradeOfflineWindow).some(Boolean);
  if (upgraded) await save();
  return targets.map((t) => ({ ...t }));
}

// Writes are serialized through this promise chain so concurrent API calls
// cannot interleave and corrupt targets.json. Each write is atomic
// (write to a temp file, then rename).
let writeChain = Promise.resolve();

function save(list = targets) {
  const snapshot = JSON.stringify(list, null, 2);
  const run = writeChain.then(async () => {
    await ensureDir();
    const tmp = `${config.targetsFile}.tmp`;
    await fsp.writeFile(tmp, snapshot, 'utf8');
    // Owner-only: stored headers may carry API tokens.
    await fsp.chmod(tmp, 0o600).catch(() => {});
    await fsp.rename(tmp, config.targetsFile);
  });
  // The caller sees this write's failure; later writes still run.
  writeChain = run.catch(() => {});
  return run;
}

// Each change is applied to the in-memory list only after its write
// succeeds, so a failed write cannot ride along with the next one.
async function commit(next) {
  await save(next);
  targets = next;
}

function insertTarget(target) {
  return commit([...targets, target]);
}

function updateTarget(target) {
  return commit(targets.map((t) => (t.id === target.id ? target : t)));
}

function deleteTarget(target) {
  return commit(targets.filter((t) => t.id !== target.id));
}

async function loadRecentHits() {
  return new Map();
}

// File mode keeps hits in memory only; the service reads them from history.js.
async function listHits() {
  return null;
}

async function recordHit() {}

async function pruneHits() {
  return 0;
}

module.exports = {
  name: 'file',
  persistsHits: false,
  loadTargets,
  insertTarget,
  updateTarget,
  deleteTarget,
  loadRecentHits,
  listHits,
  recordHit,
  pruneHits,
  // Test helper: forgets the loaded list without touching the file.
  _reset: () => {
    targets = [];
  },
};
