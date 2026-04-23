import type { PrismaClient } from '@prisma/client';
import { clearAllLocks } from './session-lock';

export interface RecoveryOptions {
  prisma: PrismaClient;
  logger?: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
  };
}

/**
 * Called on engine startup.
 *
 * After a crash / restart, the DB may still have rows in RUNNING or SENDING
 * state that no process is actually working on. This routine:
 *
 *  1. Clears all in-memory session locks (the process that held them is gone).
 *  2. Flips orphaned RUNNING campaigns back to PAUSED so an operator can
 *     explicitly resume them.
 *  3. Flips orphaned RUNNING steps back to PAUSED.
 *  4. Resets any stuck SENDING dispatch logs back to PENDING — the send may
 *     have actually succeeded at the provider, so on resume we might send
 *     a duplicate. That's the conservative trade-off; prefer double-send
 *     over silent drop for idempotent messaging channels.
 *
 * Recovery is idempotent: running it multiple times is safe.
 */
export async function recoverStuckWork(opts: RecoveryOptions): Promise<{
  campaignsPaused: number;
  stepsPaused: number;
  logsReset: number;
}> {
  const { prisma } = opts;
  const log = opts.logger ?? {
    info: (m, meta) => console.log(`[recovery] ${m}`, meta ?? ''),
    warn: (m, meta) => console.warn(`[recovery] ${m}`, meta ?? ''),
  };

  clearAllLocks();

  const stuckCampaigns = await prisma.campaign.findMany({
    where: { status: 'RUNNING' },
    select: { id: true, name: true },
  });

  for (const c of stuckCampaigns) {
    log.warn(`recovering stuck campaign ${c.id} (${c.name})`);
    await prisma.campaign.update({
      where: { id: c.id },
      data: { status: 'PAUSED' },
    });
  }

  const stuckSteps = await prisma.campaignStep.findMany({
    where: { status: 'RUNNING' },
    select: { id: true, name: true },
  });

  let logsReset = 0;
  for (const s of stuckSteps) {
    log.warn(`recovering stuck step ${s.id} (${s.name ?? 'unnamed'})`);
    const result = await prisma.$transaction([
      prisma.campaignStep.update({
        where: { id: s.id },
        data: { status: 'PAUSED' },
      }),
      prisma.dispatchLog.updateMany({
        where: { stepId: s.id, status: 'SENDING' },
        data: { status: 'PENDING' },
      }),
    ]);
    logsReset += result[1].count;
  }

  const out = {
    campaignsPaused: stuckCampaigns.length,
    stepsPaused: stuckSteps.length,
    logsReset,
  };

  if (out.campaignsPaused || out.stepsPaused || out.logsReset) {
    log.info('recovery complete', out);
  }

  return out;
}
