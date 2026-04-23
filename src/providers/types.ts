import type { MessagePayload, Recipient, SendResult } from '../types';

/**
 * A channel provider — implement this to integrate any messaging channel
 * (WhatsApp via WAHA, WhatsApp Cloud API, Twilio SMS, a transactional
 * email provider, a custom internal queue, etc).
 *
 * The engine treats providers as opaque: it only calls `send()`, looks at
 * the returned `SendResult`, and decides what to do based on the error code.
 *
 * Keep implementations idempotent — the engine can retry a send after a
 * rate-limit cooldown, so a second call with the same recipient must not
 * produce two deliveries.
 */
export interface ChannelProvider {
  /** Unique name used in logs and config (e.g. "waha", "twilio-sms", "mailgun"). */
  readonly name: string;

  /**
   * Deliver a single message to a recipient.
   *
   * Implementations should:
   *  - Return `{ ok: true, messageId }` on success.
   *  - Return `{ ok: false, errorCode: 'RATE_LIMIT', ... }` when throttled.
   *    The engine will pause the step and retry the same log after cooldown.
   *  - Return `{ ok: false, errorCode: 'DISCONNECTED', ... }` when the
   *    underlying session is unhealthy. The engine will pause the campaign.
   *  - Return `{ ok: false, errorCode: 'FATAL' | 'INVALID_RECIPIENT' }` for
   *    errors that should not trigger a retry.
   *  - Return `{ ok: false, errorCode: 'TRANSIENT' }` for everything else —
   *    the engine will count it toward the consecutive-failure limit.
   */
  send(recipient: Recipient, payload: MessagePayload): Promise<SendResult>;

  /**
   * Optional: return true if the underlying session/connection is healthy.
   * When provided, the engine can skip sends if the check fails.
   */
  isHealthy?(): Promise<boolean>;
}
