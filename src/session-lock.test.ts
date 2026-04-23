import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireSessionLock,
  releaseSessionLock,
  isSessionLocked,
  clearAllLocks,
} from './session-lock';

describe('session-lock', () => {
  beforeEach(() => {
    clearAllLocks();
  });

  it('acquires a free lock', () => {
    expect(acquireSessionLock('s1')).toBe(true);
    expect(isSessionLocked('s1')).toBe(true);
  });

  it('refuses to re-acquire a held lock', () => {
    expect(acquireSessionLock('s1')).toBe(true);
    expect(acquireSessionLock('s1')).toBe(false);
  });

  it('allows re-acquisition after release', () => {
    acquireSessionLock('s1');
    releaseSessionLock('s1');
    expect(acquireSessionLock('s1')).toBe(true);
  });

  it('isolates different sessions', () => {
    expect(acquireSessionLock('s1')).toBe(true);
    expect(acquireSessionLock('s2')).toBe(true);
    expect(isSessionLocked('s1')).toBe(true);
    expect(isSessionLocked('s2')).toBe(true);
  });

  it('releasing an unheld lock is a no-op', () => {
    expect(() => releaseSessionLock('never-held')).not.toThrow();
    expect(isSessionLocked('never-held')).toBe(false);
  });

  it('prevents a race: 100 parallel acquires, only one wins', () => {
    const results = Array.from({ length: 100 }, () => acquireSessionLock('racey'));
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it('clearAllLocks wipes state', () => {
    acquireSessionLock('a');
    acquireSessionLock('b');
    clearAllLocks();
    expect(isSessionLocked('a')).toBe(false);
    expect(isSessionLocked('b')).toBe(false);
  });
});
