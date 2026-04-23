/**
 * In-process registry of running dispatches.
 *
 * Each entry represents one step currently in the middle of its send loop.
 * The entry carries an AbortController (so we can stop the loop cleanly)
 * and a paused flag (so we can pause without aborting).
 *
 * This is intentionally NOT persisted — the engine is designed to survive
 * crashes, and the only durable truth is the DB. This map is just a handle
 * for runtime control (pause / resume / stop).
 */

export interface DispatchHandle {
  abortController: AbortController;
  isPaused: boolean;
  campaignId: string;
  stepId: string;
}

const active = new Map<string, DispatchHandle>();

export function register(handle: DispatchHandle): void {
  active.set(handle.stepId, handle);
}

export function unregister(stepId: string): void {
  active.delete(stepId);
}

export function get(stepId: string): DispatchHandle | undefined {
  return active.get(stepId);
}

export function hasActiveStep(stepId: string): boolean {
  return active.has(stepId);
}

/**
 * Find the active step (if any) belonging to the given campaign.
 * Useful when the caller only knows the campaignId (e.g. a pause API).
 */
export function findActiveStepOfCampaign(campaignId: string): string | undefined {
  let found: string | undefined;
  active.forEach((state, stepId) => {
    if (state.campaignId === campaignId) found = stepId;
  });
  return found;
}

/**
 * Iterate over all active handles whose campaignId matches.
 * Returns a defensive array copy so the caller can mutate the registry
 * during iteration (e.g. stopping all steps of a campaign).
 */
export function allStepsOfCampaign(campaignId: string): DispatchHandle[] {
  const out: DispatchHandle[] = [];
  active.forEach((h) => {
    if (h.campaignId === campaignId) out.push(h);
  });
  return out;
}

/** Test-only: reset the registry. */
export function __resetForTests(): void {
  active.clear();
}
