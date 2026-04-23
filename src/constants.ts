/**
 * Hard safety limits enforced by the dispatch loop regardless of user config.
 * These are the product of painful lessons — do not relax without cause.
 */

/** Minimum seconds between two outbound messages on the same session. */
export const MIN_SAFE_INTERVAL = 8;

/** After this many consecutive failures, auto-pause the step and the campaign. */
export const MAX_CONSECUTIVE_FAILS = 5;

/**
 * Number of initial messages that use the slower "warmup" interval.
 * Sending a burst at full speed right after reconnecting is a great way
 * to get a session flagged.
 */
export const WARMUP_MESSAGES = 5;

/** Multiplier applied to min/max interval during warmup. */
export const WARMUP_MULTIPLIER = 2.5;

/** Safe sending window (local time), inclusive start, exclusive end. */
export const SAFE_HOURS_START = 7;
export const SAFE_HOURS_END = 22;

/** Maximum messages allowed in a single batch. */
export const MAX_BATCH_SIZE = 20;

/** Minimum pause (seconds) between batches. */
export const MIN_BATCH_PAUSE = 60;

/** Pause duration after receiving a rate-limit signal from the provider. */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
