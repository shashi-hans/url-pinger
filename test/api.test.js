import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import appModule from '../src/app.js';

const { createApp } = appModule;

const app = createApp();
const base = { name: 'health', url: 'https://example.com/health', intervalSeconds: 60 };

// Cleanup goes through the API so the test talks to the same module instance
// the app does. Importing the service here would load a second copy.
async function clearTargets() {
  const res = await request(app).get('/api/targets');
  for (const t of res.body.targets) {
    await request(app).delete(`/api/targets/${t.id}`);
  }
}

beforeEach(clearTargets);
afterEach(async () => {
  await clearTargets();
  vi.unstubAllGlobals();
});

describe('POST /api/targets', () => {
  it('creates a target and masks header values', async () => {
    const res = await request(app)
      .post('/api/targets')
      .send({ ...base, headers: { Authorization: 'Bearer abc123' } })
      .expect(201);

    expect(res.body.name).toBe('health');
    expect(res.body.headers.Authorization).not.toContain('abc123');
    expect(res.body.headerCount).toBe(1);
    expect(res.body.scheduled).toBe(true);
  });

  it('rejects a private target URL', async () => {
    const res = await request(app)
      .post('/api/targets')
      .send({ ...base, url: 'http://169.254.169.254/' })
      .expect(400);
    expect(res.body.errors[0]).toMatch(/SSRF/);
  });

  it('reports every validation error at once', async () => {
    const res = await request(app).post('/api/targets').send({}).expect(400);
    expect(res.body.errors.length).toBe(3);
  });

  it('fires one hit immediately, without waiting for the first interval', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    const created = await request(app).post('/api/targets').send(base).expect(201);

    // The first hit is not awaited by the create call, so poll briefly for it.
    let history = [];
    for (let i = 0; i < 20 && history.length === 0; i += 1) {
      const res = await request(app).get(`/api/targets/${created.body.id}/history`).expect(200);
      history = res.body.history;
      if (history.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(history).toHaveLength(1);
    expect(history[0].status).toBe(200);
  });

  it('does not hit a target created in the paused state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    const created = await request(app)
      .post('/api/targets')
      .send({ ...base, enabled: false })
      .expect(201);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await request(app).get(`/api/targets/${created.body.id}/history`).expect(200);
    expect(res.body.history).toHaveLength(0);
  });

  it('drops a request body on a GET target', async () => {
    const res = await request(app)
      .post('/api/targets')
      .send({ ...base, method: 'GET', body: '{"x":1}' })
      .expect(201);
    expect(res.body.body).toBeNull();
  });
});

describe('GET /api/targets', () => {
  it('lists created targets', async () => {
    await request(app).post('/api/targets').send(base).expect(201);
    const res = await request(app).get('/api/targets').expect(200);
    expect(res.body.targets).toHaveLength(1);
  });
});

describe('PATCH /api/targets/:id', () => {
  it('pauses a target and stops its schedule', async () => {
    const created = await request(app).post('/api/targets').send(base).expect(201);
    const res = await request(app)
      .patch(`/api/targets/${created.body.id}`)
      .send({ enabled: false })
      .expect(200);

    expect(res.body.enabled).toBe(false);
    expect(res.body.scheduled).toBe(false);
    expect(res.body.nextRunAt).toBeNull();
  });

  it('returns 404 for an unknown id', async () => {
    await request(app).patch('/api/targets/missing').send({ enabled: false }).expect(404);
  });
});

describe('DELETE /api/targets/:id', () => {
  it('removes the target', async () => {
    const created = await request(app).post('/api/targets').send(base).expect(201);
    await request(app).delete(`/api/targets/${created.body.id}`).expect(204);
    await request(app).get(`/api/targets/${created.body.id}`).expect(404);
  });
});

describe('POST /api/targets/:id/run', () => {
  it('records a successful hit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('pong', { status: 200, headers: { 'content-length': '4' } }))
    );

    const created = await request(app).post('/api/targets').send(base).expect(201);
    const res = await request(app).post(`/api/targets/${created.body.id}/run`).expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe(200);
    expect(typeof res.body.durationMs).toBe('number');
    expect(res.body.preview).toBeNull();
  });

  it('stores a response preview only when the target opts in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('pong', { status: 200 })));

    const created = await request(app)
      .post('/api/targets')
      .send({ ...base, capturePreview: true })
      .expect(201);
    const res = await request(app).post(`/api/targets/${created.body.id}/run`).expect(200);

    expect(res.body.preview).toBe('pong');
  });

  it('marks a hit as failed when the status does not match expectStatus', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    const created = await request(app)
      .post('/api/targets')
      .send({ ...base, expectStatus: 204 })
      .expect(201);
    const res = await request(app).post(`/api/targets/${created.body.id}/run`).expect(200);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/Unexpected HTTP 200/);
  });

  it('records a network failure instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'ENOTFOUND' };
        throw err;
      })
    );

    const created = await request(app).post('/api/targets').send(base).expect(201);
    const res = await request(app).post(`/api/targets/${created.body.id}/run`).expect(200);

    expect(res.body.ok).toBe(false);
    expect(res.body.errorKind).toBe('network');
    expect(res.body.error).toMatch(/ENOTFOUND/);
  });
});

describe('GET /api/targets/:id/history', () => {
  it('returns recorded hits newest first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const created = await request(app).post('/api/targets').send(base).expect(201);
    await request(app).post(`/api/targets/${created.body.id}/run`).expect(200);
    await request(app).post(`/api/targets/${created.body.id}/run`).expect(200);

    const res = await request(app).get(`/api/targets/${created.body.id}/history`).expect(200);
    // One automatic hit on create, plus the two run-now calls.
    expect(res.body.history).toHaveLength(3);
    expect(new Date(res.body.history[0].at) >= new Date(res.body.history[1].at)).toBe(true);
    expect(res.body).toMatchObject({ total: 3, page: 1, pages: 1, windowHours: 24 });
  });

  it('pages the history with page and pageSize', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const created = await request(app).post('/api/targets').send(base).expect(201);
    await request(app).post(`/api/targets/${created.body.id}/run`).expect(200);
    await request(app).post(`/api/targets/${created.body.id}/run`).expect(200);

    const res = await request(app)
      .get(`/api/targets/${created.body.id}/history?page=2&pageSize=2`)
      .expect(200);
    expect(res.body.history).toHaveLength(1);
    expect(res.body).toMatchObject({ total: 3, page: 2, pageSize: 2, pages: 2 });
  });
});

describe('error handling', () => {
  it('returns JSON for an unknown API path', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.errors[0]).toBe('Not found');
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/targets')
      .set('content-type', 'application/json')
      .send('{"name":')
      .expect(400);
    expect(res.body.errors[0]).toMatch(/Invalid JSON/);
  });
});
