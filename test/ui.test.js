import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import appModule from '../src/app.js';

const { createApp } = appModule;

const app = createApp();

// State is read and cleared over HTTP so the test talks to the same module
// instance the app does. Importing the service here would load a second copy.
async function listTargets() {
  const res = await request(app).get('/api/targets').expect(200);
  return res.body.targets;
}

async function clearTargets() {
  for (const t of await listTargets()) {
    await request(app).delete(`/api/targets/${t.id}`);
  }
}

async function onlyTarget() {
  const targets = await listTargets();
  expect(targets).toHaveLength(1);
  return targets[0];
}

beforeEach(clearTargets);
afterEach(clearTargets);

function createForm(overrides = {}) {
  return {
    name: 'health',
    url: 'https://example.com/health',
    intervalSeconds: '30',
    method: 'GET',
    enabled: 'true',
    headers: 'Accept: application/json',
    ...overrides,
  };
}

describe('POST /ui/targets', () => {
  it('creates a target and returns the refreshed list', async () => {
    const res = await request(app).post('/ui/targets').type('form').send(createForm()).expect(200);

    expect(res.text).toContain('health');
    expect(res.text).toContain('every 30s');
    // An empty error block plus a reset form ride along as out-of-band swaps.
    expect(res.text).toContain('id="form-errors" hx-swap-oob="true"></div>');
    expect(res.text).toContain('hx-swap-oob="true"');
    expect(await listTargets()).toHaveLength(1);
  });

  it('reports a bad header line without creating the target', async () => {
    const res = await request(app)
      .post('/ui/targets')
      .type('form')
      .send(createForm({ headers: 'not-a-header-line' }))
      .expect(200);

    expect(res.text).toMatch(/must be in the form/);
    expect(await listTargets()).toHaveLength(0);
  });

  it('reports a blocked URL without creating the target', async () => {
    const res = await request(app)
      .post('/ui/targets')
      .type('form')
      .send(createForm({ url: 'http://127.0.0.1:8080/' }))
      .expect(200);

    expect(res.text).toMatch(/SSRF/);
    expect(await listTargets()).toHaveLength(0);
  });

  it('escapes HTML in a target name', async () => {
    await request(app)
      .post('/ui/targets')
      .type('form')
      .send(createForm({ name: '<img src=x onerror=alert(1)>' }))
      .expect(200);

    const res = await request(app).get('/ui/targets').expect(200);
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('&lt;img src=x');
  });
});

describe('PUT /ui/targets/:id', () => {
  it('keeps stored headers when the headers box is left empty', async () => {
    await request(app).post('/ui/targets').type('form').send(createForm()).expect(200);
    const { id } = await onlyTarget();

    await request(app)
      .put(`/ui/targets/${id}`)
      .type('form')
      .send(createForm({ name: 'renamed', headers: '' }))
      .expect(200);

    const updated = await onlyTarget();
    expect(updated.name).toBe('renamed');
    expect(updated.headerCount).toBe(1);
  });

  it('removes stored headers when the clear box is ticked', async () => {
    await request(app).post('/ui/targets').type('form').send(createForm()).expect(200);
    const { id } = await onlyTarget();

    await request(app)
      .put(`/ui/targets/${id}`)
      .type('form')
      .send(createForm({ headers: '', clearHeaders: 'true' }))
      .expect(200);

    expect((await onlyTarget()).headerCount).toBe(0);
  });
});

describe('POST /ui/targets/:id/toggle', () => {
  it('flips the enabled flag', async () => {
    await request(app).post('/ui/targets').type('form').send(createForm()).expect(200);
    const { id } = await onlyTarget();

    await request(app).post(`/ui/targets/${id}/toggle`).expect(200);
    expect((await onlyTarget()).enabled).toBe(false);

    await request(app).post(`/ui/targets/${id}/toggle`).expect(200);
    expect((await onlyTarget()).enabled).toBe(true);
  });
});

describe('GET /ui/form/:id', () => {
  it('renders an edit form without leaking stored header values', async () => {
    await request(app)
      .post('/ui/targets')
      .type('form')
      .send(createForm({ headers: 'Authorization: Bearer secret-token' }))
      .expect(200);
    const { id } = await onlyTarget();

    const res = await request(app).get(`/ui/form/${id}`).expect(200);
    expect(res.text).toContain('Save changes');
    expect(res.text).not.toContain('secret-token');
    expect(res.text).toContain('saved header(s) hidden');
  });
});

describe('GET /ui/targets/:id/history', () => {
  it('returns 404 markup for an unknown target', async () => {
    const res = await request(app).get('/ui/targets/missing/history').expect(404);
    expect(res.text).toMatch(/Target not found/);
  });
});
