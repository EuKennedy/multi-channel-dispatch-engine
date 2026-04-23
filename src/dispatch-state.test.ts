import { describe, it, expect, beforeEach } from 'vitest';
import {
  register,
  unregister,
  get,
  hasActiveStep,
  findActiveStepOfCampaign,
  allStepsOfCampaign,
  __resetForTests,
  type DispatchHandle,
} from './dispatch-state';

function handle(stepId: string, campaignId: string): DispatchHandle {
  return {
    abortController: new AbortController(),
    isPaused: false,
    campaignId,
    stepId,
  };
}

describe('dispatch-state', () => {
  beforeEach(() => {
    __resetForTests();
  });

  describe('register / get / unregister', () => {
    it('stores a handle and retrieves it by stepId', () => {
      const h = handle('step-1', 'camp-1');
      register(h);
      expect(get('step-1')).toBe(h);
      expect(hasActiveStep('step-1')).toBe(true);
    });

    it('unregister removes the handle', () => {
      register(handle('step-1', 'camp-1'));
      unregister('step-1');
      expect(get('step-1')).toBeUndefined();
      expect(hasActiveStep('step-1')).toBe(false);
    });

    it('unregister of a never-registered step is a no-op', () => {
      expect(() => unregister('ghost')).not.toThrow();
    });

    it('re-registering the same stepId overwrites', () => {
      const first = handle('step-1', 'camp-1');
      const second = handle('step-1', 'camp-1');
      register(first);
      register(second);
      expect(get('step-1')).toBe(second);
    });
  });

  describe('findActiveStepOfCampaign', () => {
    it('returns the stepId when the campaign has a registered step', () => {
      register(handle('step-1', 'camp-1'));
      expect(findActiveStepOfCampaign('camp-1')).toBe('step-1');
    });

    it('returns undefined when the campaign has no active steps', () => {
      register(handle('step-1', 'camp-1'));
      expect(findActiveStepOfCampaign('other-campaign')).toBeUndefined();
    });

    it('ignores steps of other campaigns', () => {
      register(handle('step-a', 'camp-A'));
      register(handle('step-b', 'camp-B'));
      expect(findActiveStepOfCampaign('camp-A')).toBe('step-a');
      expect(findActiveStepOfCampaign('camp-B')).toBe('step-b');
    });
  });

  describe('allStepsOfCampaign', () => {
    it('returns every handle belonging to a campaign', () => {
      register(handle('s1', 'camp-1'));
      register(handle('s2', 'camp-1'));
      register(handle('s3', 'camp-2'));

      const result = allStepsOfCampaign('camp-1');
      expect(result).toHaveLength(2);
      expect(result.map((h) => h.stepId).sort()).toEqual(['s1', 's2']);
    });

    it('returns an empty array for a campaign with no steps', () => {
      expect(allStepsOfCampaign('nothing')).toEqual([]);
    });

    it('returned array is a defensive copy — safe to unregister while iterating', () => {
      register(handle('s1', 'camp-1'));
      register(handle('s2', 'camp-1'));
      const handles = allStepsOfCampaign('camp-1');
      // Unregistering from inside a loop must not throw because of iterator mutation
      for (const h of handles) {
        unregister(h.stepId);
      }
      expect(allStepsOfCampaign('camp-1')).toEqual([]);
    });
  });
});
