import { describe, it, expect, afterEach, vi } from 'vitest';
import scheduler from '../src/scheduler.js';

const target = { id: 't1', name: 'demo', intervalSeconds: 1 };

afterEach(() => {
  scheduler.unscheduleAll();
  vi.useRealTimers();
});

describe('scheduler', () => {
  it('fires on the interval', async () => {
    vi.useFakeTimers();
    const onTick = vi.fn(async () => {});
    scheduler.schedule(target, onTick);

    await vi.advanceTimersByTimeAsync(3000);
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it('replaces an existing timer instead of leaking one', async () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    scheduler.schedule(target, first);
    scheduler.schedule(target, second);

    await vi.advanceTimersByTimeAsync(2000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while the previous hit is still running', async () => {
    vi.useFakeTimers();
    let release;
    const onTick = vi.fn(() => new Promise((resolve) => {
      release = resolve;
    }));
    scheduler.schedule(target, onTick);

    await vi.advanceTimersByTimeAsync(3000);
    expect(onTick).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it('stops firing after unschedule', async () => {
    vi.useFakeTimers();
    const onTick = vi.fn(async () => {});
    scheduler.schedule(target, onTick);
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.unschedule(target.id);
    await vi.advanceTimersByTimeAsync(5000);

    expect(onTick).toHaveBeenCalledTimes(1);
    expect(scheduler.isRunning(target.id)).toBe(false);
    expect(scheduler.nextRunAt(target.id)).toBeNull();
  });

  it('reports the next run time while scheduled', () => {
    scheduler.schedule(target, async () => {});
    expect(scheduler.isRunning(target.id)).toBe(true);
    expect(new Date(scheduler.nextRunAt(target.id)).getTime()).toBeGreaterThan(Date.now());
  });
});
