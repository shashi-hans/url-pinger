// Concurrent writes and the Supabase-mode load checks, run against the
// service with a fake store. Data below is synthetic.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

process.env.MAX_TARGETS = '3';

const { default: service } = await import('../src/targetsService.js');
const { default: rateLimit } = await import('../src/rateLimit.js');

const ALICE = { userId: 'a1', email: null, token: 'tok-a' };
const base = { name: 'n', url: 'https://example.com/', intervalSeconds: 60, enabled: false };

// In-memory store that answers after a delay, so unserialized writes would
// overlap.
function slowStore(rows = []) {
  const wait = () => new Promise((r) => setTimeout(r, 5));
  return {
    name: 'fake',
    persistsHits: true,
    rows,
    async loadTargets() { return this.rows.map((r) => ({ ...r })); },
    async insertTarget(t) { await wait(); this.rows.push({ ...t }); },
    async updateTarget(t) { await wait(); this.rows = this.rows.map((r) => (r.id === t.id ? { ...t } : r)); },
    async deleteTarget(t) { await wait(); this.rows = this.rows.filter((r) => r.id !== t.id); },
    async loadRecentHits() { return new Map(); },
    async listHits() { return null; },
    async recordHit() {},
    async pruneHits() { return 0; },
  };
}

let store;
beforeEach(() => {
  service._reset();
  store = slowStore();
  service._useStore(store);
});
afterEach(() => service.shutdown());

describe('serialized writes', () => {
  it('does not let parallel creates pass the per-user limit', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => service.create(ALICE, base)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(store.rows).toHaveLength(3);
  });

  it('keeps both of two overlapping updates', async () => {
    const { target } = await service.create(ALICE, base);
    await Promise.all([
      service.update(ALICE, target.id, { name: 'renamed' }),
      service.toggle(ALICE, target.id),
    ]);
    const saved = store.rows.find((r) => r.id === target.id);
    expect(saved.name).toBe('renamed');
    expect(saved.enabled).toBe(true);
  });

  it('cancels out two quick toggles instead of applying one twice', async () => {
    const { target } = await service.create(ALICE, base);
    await Promise.all([service.toggle(ALICE, target.id), service.toggle(ALICE, target.id)]);
    expect(store.rows.find((r) => r.id === target.id).enabled).toBe(false);
  });
});

describe('loading from Supabase', () => {
  const row = (extra) => ({ ...base, id: 'id-ok', userId: 'a1', method: 'GET', headers: {}, body: null,
    expectStatus: null, capturePreview: false, onlineFrom: null, onlineTo: null, offlineDays: [], ...extra });

  it('lists invalid rows without scheduling them, and drops rows with no owner', async () => {
    store.rows = [
      row({ enabled: true }),
      row({ id: 'id-fast', intervalSeconds: 0, enabled: true }),
      row({ id: 'id-orphan', userId: null }),
    ];
    await service.init();
    const listed = service.list(ALICE);
    expect(listed.map((t) => t.id)).toEqual(['id-ok', 'id-fast']);
    expect(listed[0]).toMatchObject({ scheduled: true });
    expect(listed[1]).toMatchObject({ scheduled: false });
    expect(listed[1].invalidReason).toMatch(/intervalSeconds/);
  });

  it('lets the owner fix or delete an invalid row, but not run it', async () => {
    store.rows = [
      row({ id: 'id-fast', intervalSeconds: 0, enabled: true }),
      row({ id: 'id-private', url: 'http://169.254.169.254/' }),
    ];
    await service.init();

    expect((await service.runNow(ALICE, 'id-fast')).status).toBe(409);
    expect((await service.update(ALICE, 'id-fast', { name: 'still bad' })).status).toBe(400);

    const fixed = await service.update(ALICE, 'id-fast', { intervalSeconds: 60 });
    expect(fixed.ok).toBe(true);
    expect(fixed.target.invalidReason).toBeUndefined();
    expect(fixed.target.scheduled).toBe(true);

    expect((await service.remove(ALICE, 'id-private')).status).toBe(204);
  });

  it('lists a row whose header value is not a string', async () => {
    store.rows = [row({ id: 'id-null-header', headers: { 'X-Token': null } })];
    await service.init();
    const [listed] = service.list(ALICE);
    expect(listed.invalidReason).toMatch(/headers/);
    expect(listed.headers['X-Token']).toBe('••••(0)');
  });

  it('lets the owner pause an invalid row', async () => {
    store.rows = [row({ id: 'id-private', url: 'http://169.254.169.254/', enabled: true })];
    await service.init();
    const paused = await service.toggle(ALICE, 'id-private');
    expect(paused.ok).toBe(true);
    expect(paused.target.enabled).toBe(false);
    expect(paused.target.invalidReason).toMatch(/private/);
    expect((await service.toggle(ALICE, 'id-private')).status).toBe(400);
  });

  it('counts invalid rows toward the account limit', async () => {
    store.rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', intervalSeconds: 0 }), row({ id: 'd' })];
    await service.init();
    expect(service.list(ALICE).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect((await service.create(ALICE, base)).status).toBe(409);
  });

  it('drops targets deleted in the database on the next sync', async () => {
    store.rows = [row({ enabled: true })];
    await service.init();
    expect(service.get(ALICE, 'id-ok').scheduled).toBe(true);

    store.rows = [];
    await service._syncFromStore();
    expect(service.get(ALICE, 'id-ok')).toBeNull();
  });

  it('picks up rows added in the database on the next sync', async () => {
    await service.init();
    store.rows = [row({ id: 'id-new' })];
    await service._syncFromStore();
    expect(service.list(ALICE).map((t) => t.id)).toEqual(['id-new']);
  });
});

describe('file mode', () => {
  it('pauses a stored target that fails the current rules', async () => {
    store = { ...slowStore([{ ...base, id: 'f1', url: 'http://169.254.169.254/', enabled: true, method: 'GET',
      headers: {}, body: null, expectStatus: null, capturePreview: false }]), persistsHits: false };
    service._useStore(store);
    const LOCAL = { userId: null, email: null, token: null };
    await service.init();
    expect(service.get(LOCAL, 'f1').scheduled).toBe(true);
    const paused = await service.toggle(LOCAL, 'f1');
    expect(paused.ok).toBe(true);
    expect(service.get(LOCAL, 'f1').scheduled).toBe(false);
  });
});

describe('rate limiter when full', () => {
  it('keeps active lockouts when a flood of new keys fills it', () => {
    const l = rateLimit.createLimiter({ limit: 2, windowMs: 1000, maxKeys: 5 });
    l.hit('victim', 0);
    l.hit('victim', 0);
    for (let i = 0; i < 20; i += 1) l.hit(`junk-${i}`, 1);
    expect(l.blocked('victim', 2)).toBe(true);
  });
});

describe('rate limiter', () => {
  it('allows `limit` hits per window, then blocks until it resets', () => {
    const l = rateLimit.createLimiter({ limit: 2, windowMs: 1000 });
    expect([l.hit('k', 0), l.hit('k', 1), l.hit('k', 2)]).toEqual([true, true, false]);
    expect(l.hit('k', 1000)).toBe(true);
    l.hit('j', 0);
    l.hit('j', 0);
    l.reset('j');
    expect(l.hit('j', 0)).toBe(true);
  });
});
