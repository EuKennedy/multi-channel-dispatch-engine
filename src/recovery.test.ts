import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recoverStuckWork } from './recovery';
import {
  acquireSessionLock,
  isSessionLocked,
  clearAllLocks,
} from './session-lock';

/**
 * A hand-rolled minimal Prisma mock.
 *
 * We don't use a real DB here because recovery's contract is simple enough
 * to express with an in-memory fake, and keeping tests DB-less lets them
 * run in CI without any infra.
 */
function buildMockPrisma(seed: {
  campaigns?: Array<{ id: string; name: string; status: string }>;
  steps?: Array<{ id: string; name: string | null; status: string }>;
  sendingLogsByStepId?: Record<string, number>;
}) {
  const campaigns = [...(seed.campaigns ?? [])];
  const steps = [...(seed.steps ?? [])];
  const sendingLogs = { ...(seed.sendingLogsByStepId ?? {}) };

  const calls = {
    campaignFindMany: vi.fn(),
    campaignUpdates: [] as Array<{ id: string; status: string }>,
    stepFindMany: vi.fn(),
    stepUpdates: [] as Array<{ id: string; status: string }>,
    logResets: [] as Array<{ stepId: string; count: number }>,
  };

  const prisma = {
    campaign: {
      findMany: async ({ where }: { where: { status: string } }) => {
        calls.campaignFindMany();
        return campaigns.filter((c) => c.status === where.status);
      },
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
        calls.campaignUpdates.push({ id: where.id, status: data.status });
        const c = campaigns.find((x) => x.id === where.id);
        if (c) c.status = data.status;
        return c;
      },
    },
    campaignStep: {
      findMany: async ({ where }: { where: { status: string } }) => {
        calls.stepFindMany();
        return steps.filter((s) => s.status === where.status);
      },
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
        calls.stepUpdates.push({ id: where.id, status: data.status });
        const s = steps.find((x) => x.id === where.id);
        if (s) s.status = data.status;
        return s;
      },
    },
    dispatchLog: {
      updateMany: async ({ where }: { where: { stepId: string; status: string } }) => {
        const count = sendingLogs[where.stepId] ?? 0;
        calls.logResets.push({ stepId: where.stepId, count });
        sendingLogs[where.stepId] = 0;
        return { count };
      },
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };

  return { prisma, calls, state: { campaigns, steps, sendingLogs } };
}

describe('recoverStuckWork', () => {
  beforeEach(() => {
    clearAllLocks();
  });

  it('flips orphaned RUNNING campaigns to PAUSED', async () => {
    const { prisma, calls, state } = buildMockPrisma({
      campaigns: [
        { id: 'c1', name: 'stuck', status: 'RUNNING' },
        { id: 'c2', name: 'stuck2', status: 'RUNNING' },
        { id: 'c3', name: 'ok', status: 'COMPLETED' },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await recoverStuckWork({ prisma: prisma as any });

    expect(result.campaignsPaused).toBe(2);
    expect(calls.campaignUpdates).toEqual([
      { id: 'c1', status: 'PAUSED' },
      { id: 'c2', status: 'PAUSED' },
    ]);
    expect(state.campaigns.find((c) => c.id === 'c3')!.status).toBe('COMPLETED');
  });

  it('flips orphaned RUNNING steps to PAUSED and resets SENDING logs', async () => {
    const { prisma, calls } = buildMockPrisma({
      steps: [
        { id: 's1', name: 'first', status: 'RUNNING' },
        { id: 's2', name: null, status: 'RUNNING' },
      ],
      sendingLogsByStepId: { s1: 3, s2: 1 },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await recoverStuckWork({ prisma: prisma as any });

    expect(result.stepsPaused).toBe(2);
    expect(result.logsReset).toBe(4);
    expect(calls.stepUpdates.map((u) => u.status)).toEqual(['PAUSED', 'PAUSED']);
  });

  it('clears in-memory session locks on every run', async () => {
    acquireSessionLock('session-a');
    acquireSessionLock('session-b');
    expect(isSessionLocked('session-a')).toBe(true);
    expect(isSessionLocked('session-b')).toBe(true);

    const { prisma } = buildMockPrisma({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recoverStuckWork({ prisma: prisma as any });

    expect(isSessionLocked('session-a')).toBe(false);
    expect(isSessionLocked('session-b')).toBe(false);
  });

  it('is idempotent — running twice produces the same terminal state', async () => {
    const { prisma } = buildMockPrisma({
      campaigns: [{ id: 'c1', name: 'x', status: 'RUNNING' }],
      steps: [{ id: 's1', name: 'x', status: 'RUNNING' }],
      sendingLogsByStepId: { s1: 2 },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await recoverStuckWork({ prisma: prisma as any });
    expect(first.campaignsPaused).toBe(1);
    expect(first.stepsPaused).toBe(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await recoverStuckWork({ prisma: prisma as any });
    expect(second.campaignsPaused).toBe(0);
    expect(second.stepsPaused).toBe(0);
    expect(second.logsReset).toBe(0);
  });

  it('returns zeroed counts when nothing is stuck', async () => {
    const { prisma } = buildMockPrisma({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await recoverStuckWork({ prisma: prisma as any });
    expect(result).toEqual({
      campaignsPaused: 0,
      stepsPaused: 0,
      logsReset: 0,
    });
  });
});
