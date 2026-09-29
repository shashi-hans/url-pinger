// Runs before every test file. Points the store at a throwaway directory so a
// test run never touches a real data/targets.json.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-pinger-test-'));

process.env.DATA_DIR = dir;
process.env.MIN_INTERVAL_SECONDS = '1';
process.env.REQUEST_TIMEOUT_MS = '1000';
process.env.HISTORY_LIMIT = '5';

// Creating a target fires a hit immediately, so an unstubbed test would reach
// the real network. This default keeps the suite offline; tests that care
// about the response stub fetch themselves.
globalThis.fetch = async () => new Response('', { status: 200 });
