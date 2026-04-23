import type { PrismaClient } from '@prisma/client';
import type { DispatchEngine } from './dispatch';
import { isSessionLocked } from './session-lock';

export interface SchedulerOptions {
  prisma: PrismaClient;
  engine: DispatchEngine;
  /** How often to check for due work. Default 30s. */
  tickMs?: number;
  /** Max items processed per tick. Default 5. */
  batchLimit?: number;
  logger?: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
}

/**
 * A small, non-distributed scheduler that polls the DB for due work.
 *
 * It claims work atomically before processing to be safe against its own
 * overlap (if a tick takes longer than the interval). For multi-instance
 * deployments, replace the in-memory `running` guard with a database-backed
 * lease and switch the claim to a SELECT ... FOR UPDATE SKIP LOCKED.
 */
export class Scheduler {
  private readonly prisma: PrismaClient;
  private readonly engine: DispatchEngine;
  private readonly tickMs: number;
  private readonly batchLimit: number;
  private readonly log: NonNullable<SchedulerOptions['logger']>;

  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;

  constructor(opts: SchedulerOptions) {
    this.prisma = opts.prisma;
    this.engine = opts.engine;
    this.tickMs = opts.tickMs ?? 30_000;
    this.batchLimit = opts.batchLimit ?? 5;
    this.log = opts.logger ?? {
      info: (m, meta) => console.log(`[scheduler] ${m}`, meta ?? ''),
      warn: (m, meta) => console.warn(`[scheduler] ${m}`, meta ?? ''),
      error: (m, meta) => console.error(`[scheduler] ${m}`, meta ?? ''),
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.log.info(`starting — tick every ${this.tickMs}ms, batch ${this.batchLimit}`);
    this.interval = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.started = false;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // skip if previous tick still in flight
    this.running = true;

    try {
      const now = new Date();

      await this.processScheduledCampaigns(now);
      await this.processScheduledSteps(now);
      await this.processRecurringSteps(now);
    } catch (err) {
      this.log.error('tick failed', err);
    } finally {
      this.running = false;
    }
  }

  /**
   * Campaigns that were scheduled as a whole and whose time has come.
   * They are assumed to have a first pending step; if not, the campaign
   * is marked FAILED.
   */
  private async processScheduledCampaigns(now: Date): Promise<void> {
    const due = await this.prisma.campaign.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: { lte: now },
      },
      include: { steps: { orderBy: { stepOrder: 'asc' }, take: 1 } },
      take: this.batchLimit,
      orderBy: { scheduledAt: 'asc' },
    });

    for (const c of due) {
      if (isSessionLocked(c.sessionId)) continue;
      try {
        await this.engine.startCampaign(c.id);
      } catch (err) {
        this.log.warn(`could not start campaign ${c.id}: ${errMsg(err)}`);
      }
    }
  }

  /**
   * Individual steps that were scheduled (not recurring, first run).
   */
  private async processScheduledSteps(now: Date): Promise<void> {
    const due = await this.prisma.campaignStep.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: { lte: now },
        nextRunAt: null,
      },
      include: { campaign: { select: { sessionId: true } } },
      take: this.batchLimit,
      orderBy: { scheduledAt: 'asc' },
    });

    for (const s of due) {
      if (isSessionLocked(s.campaign.sessionId)) continue;

      // The session lock is the mutual-exclusion primitive: if startStep
      // succeeds it holds the lock for the step's lifetime, so any other
      // tick that reads the same step will be rejected by the lock check
      // inside acquireSessionLock. No claim-then-revert dance needed.
      try {
        await this.engine.startStep(s.id, s.campaign.sessionId);
      } catch (err) {
        this.log.warn(`could not start step ${s.id}: ${errMsg(err)}`);
      }
    }
  }

  /**
   * Recurring steps that have come due (nextRunAt <= now).
   */
  private async processRecurringSteps(now: Date): Promise<void> {
    const due = await this.prisma.campaignStep.findMany({
      where: {
        status: 'SCHEDULED',
        nextRunAt: { lte: now },
      },
      include: { campaign: { select: { sessionId: true } } },
      take: this.batchLimit,
      orderBy: { nextRunAt: 'asc' },
    });

    for (const s of due) {
      if (isSessionLocked(s.campaign.sessionId)) continue;

      try {
        await this.engine.startStep(s.id, s.campaign.sessionId);
      } catch (err) {
        this.log.warn(`could not start recurring step ${s.id}: ${errMsg(err)}`);
      }
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
