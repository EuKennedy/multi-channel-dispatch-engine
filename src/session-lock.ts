/**
 * Session-level locking.
 *
 * WHY THIS EXISTS
 * Running two campaigns concurrently against the same session is the #1 way
 * to get a session flagged / banned. Even if the user manages to start two
 * dispatches from the UI, the engine must guarantee only one campaign per
 * session is active at any given moment.
 *
 * The naive approach — "check the DB, then start if no RUNNING campaign" —
 * is racy: two concurrent starts both see an empty table and both proceed.
 *
 * This module gives us an in-process atomic check+set. For multi-instance
 * deployments you'd back it with Redis or a Postgres advisory lock; the API
 * stays the same.
 */

const locks = new Set<string>();

/**
 * Atomically acquire a lock on the given sessionId.
 * Returns true if the lock was granted, false if it was already held.
 */
export function acquireSessionLock(sessionId: string): boolean {
  if (locks.has(sessionId)) return false;
  locks.add(sessionId);
  return true;
}

/**
 * Release a previously acquired lock. Always safe to call — releasing a
 * lock that isn't held is a no-op.
 */
export function releaseSessionLock(sessionId: string): void {
  locks.delete(sessionId);
}

/**
 * Returns true if the given session is currently locked.
 */
export function isSessionLocked(sessionId: string): boolean {
  return locks.has(sessionId);
}

/**
 * Release every lock. Used on shutdown and in the recovery routine to
 * guarantee a clean slate when the engine boots.
 */
export function clearAllLocks(): void {
  locks.clear();
}
