import { describe, it, expect } from 'vitest';
import { clampConfig, computeNextRun, randomDelay, isWithinSafeHours, sleep } from './timing';
import { DEFAULT_CONFIG } from './types';

describe('randomDelay', () => {
  it('returns a value within bounds', () => {
    for (let i = 0; i < 1000; i++) {
      const v = randomDelay(5, 15);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(15);
    }
  });
});

describe('isWithinSafeHours', () => {
  it('accepts 9am', () => {
    const d = new Date('2026-01-01T09:00:00');
    expect(isWithinSafeHours(d)).toBe(true);
  });

  it('rejects 3am', () => {
    const d = new Date('2026-01-01T03:00:00');
    expect(isWithinSafeHours(d)).toBe(false);
  });

  it('rejects exactly 22:00 (end exclusive)', () => {
    const d = new Date('2026-01-01T22:00:00');
    expect(isWithinSafeHours(d)).toBe(false);
  });

  it('accepts 21:59', () => {
    const d = new Date('2026-01-01T21:59:00');
    expect(isWithinSafeHours(d)).toBe(true);
  });
});

describe('clampConfig', () => {
  it('raises min below floor to the floor', () => {
    const out = clampConfig({ ...DEFAULT_CONFIG, minInterval: 1, maxInterval: 3 });
    expect(out.minInterval).toBeGreaterThanOrEqual(8);
  });

  it('ensures max is at least min + 5', () => {
    const out = clampConfig({ ...DEFAULT_CONFIG, minInterval: 10, maxInterval: 10 });
    expect(out.maxInterval).toBeGreaterThanOrEqual(out.minInterval + 5);
  });

  it('caps batchSize at the hard maximum', () => {
    const out = clampConfig({ ...DEFAULT_CONFIG, batchSize: 999 });
    expect(out.batchSize).toBeLessThanOrEqual(20);
  });

  it('enforces a minimum batchPause', () => {
    const out = clampConfig({ ...DEFAULT_CONFIG, batchPause: 1 });
    expect(out.batchPause).toBeGreaterThanOrEqual(60);
  });

  it('does not mutate the input', () => {
    const input = { ...DEFAULT_CONFIG, minInterval: 1 };
    clampConfig(input);
    expect(input.minInterval).toBe(1);
  });
});

describe('computeNextRun', () => {
  const base = new Date('2026-01-01T12:00:00');

  it('adds 1 day for daily', () => {
    expect(computeNextRun('daily', base).getDate()).toBe(2);
  });

  it('adds 3 days for every_3d', () => {
    expect(computeNextRun('every_3d', base).getDate()).toBe(4);
  });

  it('adds 7 days for every_7d', () => {
    expect(computeNextRun('every_7d', base).getDate()).toBe(8);
  });

  it('adds 30 days for every_30d', () => {
    expect(computeNextRun('every_30d', base).getDate()).toBe(31);
  });

  it('returns the same date for unknown recurrence', () => {
    const out = computeNextRun('unknown', base);
    expect(out.getTime()).toBe(base.getTime());
  });
});

describe('sleep', () => {
  it('resolves after the given time', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('rejects when aborted', async () => {
    const controller = new AbortController();
    const promise = sleep(1000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow('Dispatch aborted');
  });
});
