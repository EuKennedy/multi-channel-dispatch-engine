import type { MessagePayload, Recipient, SendResult } from '../types';
import type { ChannelProvider } from './types';

export interface MockProviderOptions {
  /** Simulated delay before returning a result (ms). */
  latencyMs?: number;
  /** Probability (0..1) of returning a TRANSIENT error. */
  failureRate?: number;
  /** Probability (0..1) of returning a RATE_LIMIT error. */
  rateLimitRate?: number;
  /** When true, `send()` throws instead of returning a result. */
  throwOnSend?: boolean;
}

/**
 * An in-memory provider used by tests and examples.
 * It records every send so tests can assert on what happened.
 */
export class MockProvider implements ChannelProvider {
  readonly name = 'mock';

  readonly sent: Array<{ recipient: Recipient; payload: MessagePayload; at: Date }> = [];

  private readonly opts: Required<MockProviderOptions>;

  constructor(opts: MockProviderOptions = {}) {
    this.opts = {
      latencyMs: opts.latencyMs ?? 0,
      failureRate: opts.failureRate ?? 0,
      rateLimitRate: opts.rateLimitRate ?? 0,
      throwOnSend: opts.throwOnSend ?? false,
    };
  }

  async send(recipient: Recipient, payload: MessagePayload): Promise<SendResult> {
    if (this.opts.throwOnSend) {
      throw new Error('MockProvider: send threw by configuration');
    }

    if (this.opts.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    }

    if (Math.random() < this.opts.rateLimitRate) {
      return { ok: false, errorCode: 'RATE_LIMIT', errorMessage: 'simulated rate limit' };
    }

    if (Math.random() < this.opts.failureRate) {
      return { ok: false, errorCode: 'TRANSIENT', errorMessage: 'simulated transient failure' };
    }

    this.sent.push({ recipient, payload, at: new Date() });
    return { ok: true, messageId: `mock_${this.sent.length}_${Date.now()}` };
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  reset(): void {
    this.sent.length = 0;
  }
}
