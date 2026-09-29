'use strict';

// Fills a running server with ten demo targets so the list UI can be checked
// with realistic states: healthy, failing, redirecting, slow, paused, and a
// name that tries to inject markup.
//
// Usage: npm run seed:demo            (against http://127.0.0.1:3200)
//        BASE_URL=... npm run seed:demo
//        npm run seed:demo -- --reset (delete existing targets first)
//
// Every URL below is a public test endpoint. No customer data, no credentials.

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3200';
const reset = process.argv.includes('--reset');

const demoTargets = [
  { name: 'Example Domain', url: 'https://example.com/', intervalSeconds: 60 },
  { name: 'httpbin healthy', url: 'https://httpbin.org/status/200', intervalSeconds: 30 },
  { name: 'httpbin server error', url: 'https://httpbin.org/status/500', intervalSeconds: 45 },
  { name: 'httpbin missing page', url: 'https://httpbin.org/status/404', intervalSeconds: 120 },
  { name: 'httpbin redirect', url: 'https://httpbin.org/redirect/1', intervalSeconds: 90 },
  {
    name: 'httpbin slow endpoint',
    url: 'https://httpbin.org/delay/3',
    intervalSeconds: 300,
    capturePreview: true,
  },
  { name: 'Unresolvable host', url: 'https://no-such-host.invalid/', intervalSeconds: 60 },
  {
    name: 'Strict status check',
    url: 'https://example.com/',
    intervalSeconds: 600,
    expectStatus: 204,
  },
  {
    name: 'POST with headers',
    url: 'https://httpbin.org/post',
    method: 'POST',
    intervalSeconds: 3600,
    headers: { 'X-Demo': 'seed', Accept: 'application/json' },
    body: '{"ping":true}',
  },
  {
    name: 'Weekly check <b>escaped</b>',
    url: 'https://example.com/robots.txt',
    intervalSeconds: 604800,
    enabled: false,
  },
];

async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { status: res.status, body };
}

async function main() {
  const health = await api('/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`No server answering at ${BASE_URL}. Start it with "npm start" first.`);
    process.exit(1);
  }

  if (reset) {
    const { body } = await api('/api/targets');
    for (const t of body.targets) {
      await api(`/api/targets/${t.id}`, { method: 'DELETE' });
    }
    console.log(`Deleted ${body.targets.length} existing target(s)`);
  }

  const created = [];
  for (const target of demoTargets) {
    const { status, body } = await api('/api/targets', {
      method: 'POST',
      body: JSON.stringify(target),
    });
    if (status !== 201) {
      console.error(`Failed: ${target.name} -> ${JSON.stringify(body.errors)}`);
      continue;
    }
    created.push(body);
    console.log(`Created ${target.name}`);
  }

  // One immediate hit each, so the list shows real statuses and timings
  // instead of ten "waiting" rows. Enabled targets only.
  console.log('Running one hit per enabled target...');
  await Promise.all(
    created
      .filter((t) => t.enabled)
      .map((t) => api(`/api/targets/${t.id}/run`, { method: 'POST' }).catch(() => null))
  );

  console.log(`\nDone. ${created.length} target(s) on ${BASE_URL}`);
}

main().catch((err) => {
  console.error('Seeding failed', err);
  process.exit(1);
});
