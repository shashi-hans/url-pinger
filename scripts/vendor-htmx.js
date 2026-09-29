'use strict';

// Copies htmx from node_modules into public/vendor so the page loads it from
// the same origin. No CDN: the CSP only allows same-origin scripts, and a
// vendored copy pins the exact version that was tested.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'node_modules', 'htmx.org', 'dist', 'htmx.min.js');
const destDir = path.join(root, 'public', 'vendor');
const dest = path.join(destDir, 'htmx.min.js');

if (!fs.existsSync(source)) {
  console.error('htmx.org is not installed. Run npm install first.');
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(source, dest);

const version = require(path.join(root, 'node_modules', 'htmx.org', 'package.json')).version;
console.log(`Vendored htmx ${version} to public/vendor/htmx.min.js`);
