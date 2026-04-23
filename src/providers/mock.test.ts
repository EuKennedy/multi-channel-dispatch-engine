import { describe, it, expect } from 'vitest';
import { MockProvider } from './mock';

describe('MockProvider', () => {
  it('records successful sends', async () => {
    const p = new MockProvider();
    const res = await p.send(
      { id: 'r1', address: '+5511900000001' },
      { type: 'TEXT', text: 'hello' },
    );
    expect(res.ok).toBe(true);
    expect(res.messageId).toBeTruthy();
    expect(p.sent).toHaveLength(1);
  });

  it('returns RATE_LIMIT when configured', async () => {
    const p = new MockProvider({ rateLimitRate: 1 });
    const res = await p.send(
      { id: 'r1', address: '+5511900000001' },
      { type: 'TEXT', text: 'hi' },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('RATE_LIMIT');
  });

  it('returns TRANSIENT when failure rate is 1', async () => {
    const p = new MockProvider({ failureRate: 1 });
    const res = await p.send(
      { id: 'r1', address: '+5511900000001' },
      { type: 'TEXT', text: 'hi' },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('TRANSIENT');
  });

  it('throws when configured to throw', async () => {
    const p = new MockProvider({ throwOnSend: true });
    await expect(
      p.send({ id: 'r1', address: 'x' }, { type: 'TEXT' }),
    ).rejects.toThrow();
  });

  it('reset() clears the sent buffer', async () => {
    const p = new MockProvider();
    await p.send({ id: 'r1', address: 'x' }, { type: 'TEXT' });
    p.reset();
    expect(p.sent).toHaveLength(0);
  });

  it('isHealthy() is true by default', async () => {
    const p = new MockProvider();
    await expect(p.isHealthy()).resolves.toBe(true);
  });
});
