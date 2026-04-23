/**
 * Public types for the dispatch engine.
 *
 * A Campaign is the top-level unit of work. It has one or more Steps
 * (each with its own message content and schedule), and each Step spawns
 * DispatchLogs — one per recipient.
 */

export type CampaignStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED';

export type StepStatus = CampaignStatus;

export type DispatchStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';

export type MessageType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'TEMPLATE';

export type RecurrenceType =
  | 'daily'
  | 'every_3d'
  | 'every_7d'
  | 'every_15d'
  | 'every_30d';

/**
 * A recipient is anything that can receive a message.
 * The provider decides how to interpret `address` (phone, email, chat id, etc).
 */
export interface Recipient {
  id: string;
  address: string;
  /** Optional metadata forwarded to the provider (e.g. name, tags). */
  metadata?: Record<string, unknown>;
}

/**
 * Message payload, channel-agnostic.
 * Providers are responsible for mapping this into their native format.
 */
export interface MessagePayload {
  type: MessageType;
  text?: string;
  mediaUrl?: string;
  mediaCaption?: string;
  /** Used by providers that support approved templates (e.g. WhatsApp Cloud API). */
  templateName?: string;
  templateLanguage?: string;
  templateComponents?: unknown;
}

/**
 * Result returned by a provider after attempting to send a message.
 */
export interface SendResult {
  ok: boolean;
  /** Provider-assigned message id (if the send succeeded). */
  messageId?: string;
  /** Error classification — drives retry behavior. */
  errorCode?: 'RATE_LIMIT' | 'DISCONNECTED' | 'INVALID_RECIPIENT' | 'TRANSIENT' | 'FATAL';
  errorMessage?: string;
}

/**
 * Anti-ban configuration applied to every campaign.
 * All values have hard minimums enforced at dispatch time.
 */
export interface DispatchConfig {
  /** Minimum seconds between two messages (hard floor: 8). */
  minInterval: number;
  /** Maximum seconds between two messages (auto-adjusted to be >= min + 5). */
  maxInterval: number;
  /** Messages per batch before the long pause kicks in (hard cap: 20). */
  batchSize: number;
  /** Seconds to wait between batches (hard floor: 60). */
  batchPause: number;
  /** If true, dispatch loop warns when outside SAFE_HOURS but keeps going. */
  allowOutsideSafeHours?: boolean;
}

export const DEFAULT_CONFIG: DispatchConfig = {
  minInterval: 8,
  maxInterval: 25,
  batchSize: 10,
  batchPause: 120,
  allowOutsideSafeHours: false,
};
