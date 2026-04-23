import {
  MIN_SAFE_INTERVAL,
  MIN_BATCH_PAUSE,
  MAX_BATCH_SIZE,
  SAFE_HOURS_START,
  SAFE_HOURS_END,
} from './constants';
import type { DispatchConfig } from './types';

/** Random integer in [min, max] (inclusive). */
export function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Abortable sleep. Resolves after `ms` milliseconds, or rejects immediately
 * with "Dispatch aborted" when the signal fires.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Dispatch aborted'));
    });
  });
}

/** True if current local time is inside SAFE_HOURS_START..SAFE_HOURS_END. */
export function isWithinSafeHours(now: Date = new Date()): boolean {
  const hour = now.getHours();
  return hour >= SAFE_HOURS_START && hour < SAFE_HOURS_END;
}

/**
 * Clamp user-provided dispatch config against the engine's safety floors.
 * Returns a new object; does not mutate the input.
 */
export function clampConfig(config: DispatchConfig): DispatchConfig {
  const minInterval = Math.max(config.minInterval, MIN_SAFE_INTERVAL);
  const maxInterval = Math.max(config.maxInterval, minInterval + 5);
  const batchSize = Math.min(Math.max(config.batchSize, 1), MAX_BATCH_SIZE);
  const batchPause = Math.max(config.batchPause, MIN_BATCH_PAUSE);

  return {
    ...config,
    minInterval,
    maxInterval,
    batchSize,
    batchPause,
  };
}

/**
 * Compute the next run date for a recurring step.
 * Returns a new Date; caller is responsible for persisting it.
 */
export function computeNextRun(
  recurrenceType: string,
  from: Date = new Date(),
): Date {
  const d = new Date(from);
  switch (recurrenceType) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'every_3d':
      d.setDate(d.getDate() + 3);
      break;
    case 'every_7d':
      d.setDate(d.getDate() + 7);
      break;
    case 'every_15d':
      d.setDate(d.getDate() + 15);
      break;
    case 'every_30d':
      d.setDate(d.getDate() + 30);
      break;
  }
  return d;
}
