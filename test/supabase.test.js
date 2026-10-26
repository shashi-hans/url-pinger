// Supabase mode against a fake Supabase: every outbound fetch is answered
// in-process, so the suite stays offline. Users, emails and tokens below are
// synthetic.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';

const SUPABASE_URL = 'https://fake-project.supabase.co';
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_ANON_KEY = 'anon-key-placeholder';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-placeholder';

const USERS = {
  'tok-alice': { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.test' },
  'tok-bob': { id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.test' },
};
const PASSWORDS = { 'alice@example.test': 'correct-horse', 'bob@example.test': 'battery-staple' };
const REFRESH = { 'ref-alice': 'tok-alice' };

const calls = [];
const storedHits = [];
const pruneBatches = [];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function session(token) {
  return {
    access_token: token,
    refresh_token: `ref-${USERS[token].email.split('@')[0]}`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { ...USERS[token], aud: 'authenticated', role: 'authenticated' },
  };
}

// Installed before the app loads, because supabase-js captures fetch when a
// client is created.
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  const body = typeof init.body === 'string' ? init.body : null;

  if (url.origin !== SUPABASE_URL) return new Response('', { status: 200 });
  calls.push({ path: url.pathname, search: url.search, method, auth: headers.get('authorization'), body });

  if (url.pathname === '/auth/v1/user') {
    const token = (headers.get('authorization') || '').replace(/^Bearer /, '');
    const user = USERS[token];
    return user ? json({ ...user, aud: 'authenticated' }) : json({ msg: 'invalid JWT' }, 401);
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    const { email, password } = JSON.parse(body);
    if (PASSWORDS[email] !== password) {
      return json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400);
    }
    const token = Object.keys(USERS).find((t) => USERS[t].email === email);
    return json(session(token));
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    const token = REFRESH[JSON.parse(body).refresh_token];
    return token ? json(session(token)) : json({ error: 'invalid_grant' }, 400);
  }
  if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
  if (url.pathname === '/rest/v1/targets') {
    const id = body ? JSON.parse(body).id : url.searchParams.get('id').replace('eq.', '');
    return json([{ id }], method === 'POST' ? 201 : 200);
  }
  if (url.pathname === '/rest/v1/hits' && method === 'GET') {
    const targetId = url.searchParams.get('target_id').replace('eq.', '');
    const rows = storedHits.filter((h) => h.target_id === targetId);
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-range': `0-${rows.length - 1}/${rows.length}` },
    });
  }
  if (url.pathname === '/rest/v1/hits') {
    storedHits.unshift(JSON.parse(body));
    return new Response(null, { status: 201 });
  }
  if (url.pathname === '/rest/v1/rpc/recent_hits') return json([]);
  if (url.pathname === '/rest/v1/rpc/delete_target_hits') return json(0);
  if (url.pathname === '/rest/v1/rpc/prune_hits') return json(pruneBatches.shift() ?? 0);
  return json({ message: 'unexpected call' }, 500);
};

let app;
const base = { name: 'health', url: 'https://example.com/health', intervalSeconds: 60 };
const asAlice = { Authorization: 'Bearer tok-alice' };
const asBob = { Authorization: 'Bearer tok-bob' };

beforeAll(async () => {
  const { createApp } = (await import('../src/app.js')).default;
  app = createApp();
});

beforeEach(async () => {
  calls.length = 0;
  storedHits.length = 0;
  for (const who of [asAlice, asBob]) {
    const res = await request(app).get('/api/targets').set(who);
    for (const t of res.body.targets) await request(app).delete(`/api/targets/${t.id}`).set(who);
  }
  calls.length = 0;
});

function cookieValue(res, name) {
  const line = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return line ? line.split(';')[0].slice(name.length + 1) : null;
}

describe('unauthenticated requests', () => {
  it('redirects the page shell to /login', async () => {
    const res = await request(app).get('/').expect(302);
    expect(res.headers.location).toBe('/login');
  });

  it('answers the JSON API with 401', async () => {
    await request(app).get('/api/targets').expect(401);
  });

  it('tells HTMX to go to /login', async () => {
    const res = await request(app).get('/ui/targets').expect(401);
    expect(res.headers['hx-redirect']).toBe('/login');
  });

  it('keeps the health probe public', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', storage: 'supabase' });
  });
});

describe('login', () => {
  it('rejects a wrong password with a generic message', async () => {
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ email: 'alice@example.test', password: 'wrong' })
      .expect(401);
    expect(res.text).toContain('Invalid email or password.');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('sets httpOnly session cookies and redirects home', async () => {
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ email: 'alice@example.test', password: 'correct-horse' })
      .expect(303);
    expect(res.headers.location).toBe('/');
    const access = res.headers['set-cookie'].find((c) => c.startsWith('sb_access='));
    expect(access).toMatch(/HttpOnly/);
    expect(access).toMatch(/SameSite=Lax/);
  });

  it('locks an email out after 5 failed attempts', async () => {
    const attempt = () => request(app)
      .post('/login')
      .type('form')
      .send({ email: 'bob@example.test', password: 'wrong' });
    for (let i = 0; i < 5; i += 1) await attempt().expect(401);
    const res = await attempt().expect(429);
    expect(res.text).toContain('Too many sign-in attempts');

    // The correct password is refused too, without reaching Supabase Auth.
    calls.length = 0;
    await request(app)
      .post('/login')
      .type('form')
      .send({ email: 'bob@example.test', password: 'battery-staple' })
      .expect(429);
    expect(calls.some((c) => c.search.includes('grant_type=password'))).toBe(false);
  });

  it('refreshes an expired access cookie with the refresh cookie', async () => {
    const res = await request(app)
      .get('/ui/targets')
      .set('Cookie', 'sb_access=expired; sb_refresh=ref-alice')
      .expect(200);
    expect(cookieValue(res, 'sb_access')).toBe('tok-alice');
  });
});

describe('page shell', () => {
  it('guards an encoded path to index.html too', async () => {
    const res = await request(app).get('/%69ndex.html').expect(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('per-user isolation', () => {
  it('hides one user\'s targets from another', async () => {
    const created = await request(app).post('/api/targets').set(asAlice).send(base).expect(201);
    const id = created.body.id;
    expect(created.body.userId).toBeUndefined();

    const bobList = await request(app).get('/api/targets').set(asBob).expect(200);
    expect(bobList.body.targets).toEqual([]);
    await request(app).get(`/api/targets/${id}`).set(asBob).expect(404);
    await request(app).patch(`/api/targets/${id}`).set(asBob).send({ name: 'x' }).expect(404);
    await request(app).delete(`/api/targets/${id}`).set(asBob).expect(404);
    await request(app).get(`/api/targets/${id}/history`).set(asBob).expect(404);

    const aliceList = await request(app).get('/api/targets').set(asAlice).expect(200);
    expect(aliceList.body.targets.map((t) => t.id)).toEqual([id]);
  });

  it('removes a target\'s hits in batches before deleting the row', async () => {
    const created = await request(app).post('/api/targets').set(asAlice).send(base).expect(201);
    calls.length = 0;
    await request(app).delete(`/api/targets/${created.body.id}`).set(asAlice).expect(204);
    const order = calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('POST /rest/v1/rpc/delete_target_hits')).toBeLessThan(order.indexOf('DELETE /rest/v1/targets'));
    expect(calls.find((c) => c.path === '/rest/v1/targets' && c.method === 'DELETE').auth).toBe('Bearer tok-alice');
  });

  it('writes targets with the user\'s token so Row Level Security applies', async () => {
    await request(app).post('/api/targets').set(asAlice).send(base).expect(201);
    const insert = calls.find((c) => c.path === '/rest/v1/targets' && c.method === 'POST');
    expect(insert.auth).toBe('Bearer tok-alice');
    expect(JSON.parse(insert.body).user_id).toBe(USERS['tok-alice'].id);
  });

  it('stores hits without the response preview', async () => {
    const created = await request(app)
      .post('/api/targets')
      .set(asAlice)
      .send({ ...base, capturePreview: true })
      .expect(201);
    await request(app).post(`/api/targets/${created.body.id}/run`).set(asAlice).expect(200);
    const hit = calls.find((c) => c.path === '/rest/v1/hits' && c.method === 'POST');
    const row = JSON.parse(hit.body);
    expect(row.user_id).toBe(USERS['tok-alice'].id);
    expect(row).not.toHaveProperty('preview');
  });
});

describe('pruning', () => {
  it('deletes old hits in batches until a short batch', async () => {
    const { default: store } = await import('../src/supabaseStore.js');
    pruneBatches.push(10000, 10000, 5);
    calls.length = 0;
    expect(await store.pruneHits(30)).toBe(20005);
    expect(calls.filter((c) => c.path === '/rest/v1/rpc/prune_hits')).toHaveLength(3);
  });
});

describe('history', () => {
  it('reads the last 24 hours from the database as the user, with memory previews', async () => {
    const created = await request(app)
      .post('/api/targets')
      .set(asAlice)
      .send({ ...base, capturePreview: true })
      .expect(201);
    await request(app).post(`/api/targets/${created.body.id}/run`).set(asAlice).expect(200);

    const res = await request(app).get(`/api/targets/${created.body.id}/history`).set(asAlice).expect(200);
    const read = calls.find((c) => c.path === '/rest/v1/hits' && c.method === 'GET');
    expect(read.auth).toBe('Bearer tok-alice');
    expect(read.search).toMatch(/at=gte\./);
    expect(res.body.total).toBe(storedHits.length);
    expect(res.body.history[0].preview).toBe('');
  });
});

describe('CSRF guard', () => {
  it('rejects a cookie-authenticated write without the HX-Request header', async () => {
    await request(app)
      .post('/ui/targets')
      .set('Cookie', 'sb_access=tok-alice')
      .type('form')
      .send({ name: 'x', url: 'https://example.com/', intervalSeconds: '60' })
      .expect(403);
  });

  it('accepts the same write from HTMX', async () => {
    const res = await request(app)
      .post('/ui/targets')
      .set('Cookie', 'sb_access=tok-alice')
      .set('HX-Request', 'true')
      .type('form')
      .send({ name: 'x', url: 'https://example.com/', intervalSeconds: '60', enabled: 'true' })
      .expect(200);
    expect(res.text).toContain('x');
  });

  it('signs out and clears the cookies', async () => {
    const res = await request(app)
      .post('/logout')
      .set('Cookie', 'sb_access=tok-alice; sb_refresh=ref-alice')
      .set('HX-Request', 'true')
      .expect(204);
    expect(res.headers['hx-redirect']).toBe('/login');
    expect(cookieValue(res, 'sb_access')).toBe('');
  });
});

// Last on purpose: it blocks the test IP for the rest of the file.
describe('bad tokens', () => {
  it('stops asking Supabase Auth after 30 rejected tokens from one IP', async () => {
    for (let i = 0; i < 30; i += 1) {
      await request(app).get('/api/targets').set('Authorization', `Bearer junk-${i}`).expect(401);
    }
    calls.length = 0;
    await request(app).get('/api/targets').set('Authorization', 'Bearer junk-more').expect(401);
    expect(calls.filter((c) => c.path === '/auth/v1/user')).toHaveLength(0);
  });
});
