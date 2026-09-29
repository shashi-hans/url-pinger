'use strict';

const fs = require('fs');
const fsp = fs.promises;
const config = require('./config');

async function ensureDir() {
  await fsp.mkdir(config.dataDir, { recursive: true });
}

// Loads the persisted target list. Missing file means a fresh install.
async function loadTargets() {
  await ensureDir();
  try {
    const raw = await fsp.readFile(config.targetsFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Writes are serialized through this promise chain so concurrent API calls
// cannot interleave and corrupt targets.json. Each write is atomic
// (write to a temp file, then rename).
let writeChain = Promise.resolve();

function saveTargets(targets) {
  writeChain = writeChain.then(async () => {
    await ensureDir();
    const tmp = `${config.targetsFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(targets, null, 2), 'utf8');
    // Owner-only: stored headers may carry API tokens.
    await fsp.chmod(tmp, 0o600).catch(() => {});
    await fsp.rename(tmp, config.targetsFile);
  });
  return writeChain;
}

module.exports = { loadTargets, saveTargets };
