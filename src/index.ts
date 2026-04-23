/**
 * multi-channel-dispatch-engine
 *
 * Public entry point. Consumers should import from here.
 */

export { DispatchEngine } from './dispatch';
export type { DispatchEngineOptions } from './dispatch';

export { Scheduler } from './scheduler';
export type { SchedulerOptions } from './scheduler';

export { recoverStuckWork } from './recovery';
export type { RecoveryOptions } from './recovery';

export {
  acquireSessionLock,
  releaseSessionLock,
  isSessionLocked,
  clearAllLocks,
} from './session-lock';

export type { ChannelProvider } from './providers/types';
export { MockProvider } from './providers/mock';
export type { MockProviderOptions } from './providers/mock';

export type {
  CampaignStatus,
  StepStatus,
  DispatchStatus,
  MessageType,
  RecurrenceType,
  Recipient,
  MessagePayload,
  SendResult,
  DispatchConfig,
} from './types';

export { DEFAULT_CONFIG } from './types';

export {
  MIN_SAFE_INTERVAL,
  MAX_CONSECUTIVE_FAILS,
  WARMUP_MESSAGES,
  WARMUP_MULTIPLIER,
  SAFE_HOURS_START,
  SAFE_HOURS_END,
  MAX_BATCH_SIZE,
  MIN_BATCH_PAUSE,
  RATE_LIMIT_COOLDOWN_MS,
} from './constants';
