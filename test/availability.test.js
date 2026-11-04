import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import availability from '../src/availability.js';
import validation from '../src/validation.js';
import fileStore from '../src/fileStore.js';
import config from '../src/config.js';
import appModule from '../src/app.js';

const { isOffline, istMinutesOfDay, istDay, normalizeTime, format12 } = availability;
const { validateTargetInput } = validation;

// 2026-10-18 is a Sunday. 16:30 UTC is 22:00 IST the same day.
const at = (utc, day = '18') => new Date(`2026-10-${day}T${utc}:00Z`);

function hhmm(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

describe('time helpers', () => {
  it('converts UTC to IST minutes and weekday', () => {
    expect(istMinutesOfDay(at('16:30'))).toBe(22 * 60);
    expect(istMinutesOfDay(at('20:00'))).toBe(90); // 01:30 IST, Monday
    expect(istDay(at('16:30'))).toBe(0);
    expect(istDay(at('20:00'))).toBe(1);
  });

  it('accepts 24-hour and 12-hour input and formats as 12-hour', () => {
    expect(normalizeTime('09:05')).toBe('09:05');
    expect(normalizeTime('9:05 AM')).toBe('09:05');
    expect(normalizeTime('12:00 am')).toBe('00:00');
    expect(normalizeTime('12:30 PM')).toBe('12:30');
    expect(normalizeTime('7:00pm')).toBe('19:00');
    expect(normalizeTime('13:00 PM')).toBeNull();
    expect(format12('00:00')).toBe('12:00 AM');
    expect(format12('19:05')).toBe('7:05 PM');
  });
});

describe('isOffline', () => {
  it('is offline outside a same-day online window, start included and end excluded', () => {
    const t = { onlineFrom: '09:00', onlineTo: '19:00' };
    expect(isOffline(t, at('03:29', '19'))).toBe(true); // Mon 08:59 IST
    expect(isOffline(t, at('03:30', '19'))).toBe(false); // Mon 09:00 IST
    expect(isOffline(t, at('13:29', '19'))).toBe(false); // Mon 18:59 IST
    expect(isOffline(t, at('13:30', '19'))).toBe(true); // Mon 19:00 IST
  });

  it('handles an online window that crosses midnight', () => {
    const t = { onlineFrom: '21:00', onlineTo: '06:00' };
    expect(isOffline(t, at('16:30', '19'))).toBe(false); // Mon 22:00 IST
    expect(isOffline(t, at('20:00', '19'))).toBe(false); // Tue 01:30 IST
    expect(isOffline(t, at('06:30', '19'))).toBe(true); // Mon 12:00 IST
  });

  it('skips offline days by the current IST calendar day', () => {
    const t = { onlineFrom: '21:00', onlineTo: '06:00', offlineDays: [0] };
    expect(isOffline(t, at('16:30', '17'))).toBe(false); // Sat 22:00 IST
    expect(isOffline(t, at('20:00', '17'))).toBe(true); // Sun 01:30 IST, Saturday's tail
    expect(isOffline(t, at('16:30', '18'))).toBe(true); // Sun 22:00 IST
    expect(isOffline({ offlineDays: [0] }, at('06:30', '18'))).toBe(true);
    expect(isOffline({ offlineDays: [0] }, at('06:30', '19'))).toBe(false);
  });

  it('is always online with no window and no offline days', () => {
    expect(isOffline({ onlineFrom: null, onlineTo: null, offlineDays: [] }, at('16:30'))).toBe(false);
  });
});

describe('validation', () => {
  const base = { name: 'n', url: 'https://example.com/', intervalSeconds: 60 };
  const errorsFor = (extra) => validateTargetInput({ ...base, ...extra }).errors;

  it('accepts both times in either format, or both null', () => {
    expect(errorsFor({ onlineFrom: '9:00 AM', onlineTo: '19:00' })).toEqual([]);
    expect(errorsFor({ onlineFrom: null, onlineTo: null })).toEqual([]);
  });

  it('rejects half a window, bad formats and equal times', () => {
    expect(errorsFor({ onlineFrom: '09:00' })[0]).toMatch(/together/);
    expect(errorsFor({ onlineFrom: '09:00', onlineTo: null })[0]).toMatch(/both/);
    expect(errorsFor({ onlineFrom: '25:00', onlineTo: '06:00' })[0]).toMatch(/like/);
    expect(errorsFor({ onlineFrom: ['09:00'], onlineTo: ['10:00'] })[0]).toMatch(/like/);
    expect(errorsFor({ onlineFrom: '9:00 PM', onlineTo: '21:00' })[0]).toMatch(/differ/);
  });

  it('checks offline days', () => {
    expect(errorsFor({ offlineDays: [0, 6] })).toEqual([]);
    expect(errorsFor({ offlineDays: [7] })[0]).toMatch(/weekday/);
    expect(errorsFor({ offlineDays: ['0'] })[0]).toMatch(/weekday/);
    expect(errorsFor({ offlineDays: [1, 1] })[0]).toMatch(/repeat/);
    expect(errorsFor({ offlineDays: [0, 1, 2, 3, 4, 5, 6] })[0]).toMatch(/pause/);
  });
});

describe('file upgrade', () => {
  it('turns an old offline window into the matching online window', async () => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(
      config.targetsFile,
      JSON.stringify([{ id: 'x', name: 'n', url: 'https://example.com/', intervalSeconds: 60, offlineFrom: '18:00', offlineTo: '10:00' }])
    );
    const [t] = await fileStore.loadTargets();
    expect(t).toMatchObject({ onlineFrom: '10:00', onlineTo: '18:00' });
    expect(t).not.toHaveProperty('offlineFrom');
    const saved = JSON.parse(fs.readFileSync(config.targetsFile, 'utf8'));
    expect(saved[0]).not.toHaveProperty('offlineTo');
    fs.rmSync(path.join(config.targetsFile));
  });
});

describe('timer hits outside the online window', () => {
  const app = appModule.createApp();
  afterEach(() => vi.unstubAllGlobals());

  it('skips the automatic hit but still allows Run now', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const now = istMinutesOfDay();
    const created = await request(app)
      .post('/api/targets')
      .send({
        name: 'quiet',
        url: 'https://example.com/',
        intervalSeconds: 60,
        onlineFrom: hhmm(now + 60),
        onlineTo: hhmm(now + 120),
      })
      .expect(201);
    expect(created.body.offlineNow).toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();

    await request(app).post(`/api/targets/${created.body.id}/run`).expect(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await request(app).delete(`/api/targets/${created.body.id}`).expect(204);
  });

  it('builds the times and days from the HTML form', async () => {
    const res = await request(app)
      .post('/ui/targets').set('HX-Request', 'true')
      .type('form')
      .send('name=form&url=https%3A%2F%2Fexample.com%2F&intervalSeconds=60&enabled=true'
        + '&onlineFromHour=9&onlineFromMinute=30&onlineFromPeriod=AM'
        + '&onlineToHour=7&onlineToMinute=00&onlineToPeriod=PM&offlineDays=0&offlineDays=6')
      .expect(200);
    expect(res.text).toContain('online: 9:30 AM&ndash;7:00 PM IST');
    expect(res.text).toContain('off: Sat, Sun');
    const form = (await request(app).get('/ui/form')).text;
    const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => form.indexOf(`>${d}</span>`));
    expect(order.every((pos, i) => pos > 0 && (i === 0 || pos > order[i - 1]))).toBe(true);
    const list = await request(app).get('/api/targets');
    const t = list.body.targets.find((x) => x.name === 'form');
    expect(t).toMatchObject({ onlineFrom: '09:30', onlineTo: '19:00', offlineDays: [0, 6] });
    await request(app).delete(`/api/targets/${t.id}`).expect(204);
  });
});
