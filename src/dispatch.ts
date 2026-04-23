import type { PrismaClient } from '@prisma/client';
import {
  MAX_CONSECUTIVE_FAILS,
  RATE_LIMIT_COOLDOWN_MS,
  WARMUP_MESSAGES,
  WARMUP_MULTIPLIER,
} from './constants';
import * as registry from './dispatch-state';
import { acquireSessionLock, releaseSessionLock } from './session-lock';
import { clampConfig, computeNextRun, isWithinSafeHours, randomDelay, sleep } from './timing';
import type { MessagePayload, MessageType, Recipient, SendResult } from './types';
import type { ChannelProvider } from './providers/types';

export interface DispatchEngineOptions {
  prisma: PrismaClient;
  /**
   * Map of provider name -> implementation.
   * The engine picks the provider based on the session's `channel` field.
   */
  providers: Record<string, ChannelProvider>;
  /** Optional logger. Defaults to console. */
  logger?: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
}

/**
 * The dispatch engine.
 *
 * One instance manages N concurrent campaigns (but only one active campaign
 * per session, enforced by session locks). Call `startCampaign(id)` to begin,
 * `pause(id)` to pause, `resume(id)` to resume, `stop(id)` to abort.
 *
 * The engine is safe to restart — state lives in the DB, and each step
 * carries a `lastProcessedLogId` cursor that lets the loop resume exactly
 * where it left off.
 */
export class DispatchEngine {
  private readonly prisma: PrismaClient;
  private readonly providers: Record<string, ChannelProvider>;
  private readonly log: NonNullable<DispatchEngineOptions['logger']>;

  constructor(opts: DispatchEngineOptions) {
    this.prisma = opts.prisma;
    this.providers = opts.providers;
    this.log = opts.logger ?? {
      info: (m, meta) => console.log(`[dispatch] ${m}`, meta ?? ''),
      warn: (m, meta) => console.warn(`[dispatch] ${m}`, meta ?? ''),
      error: (m, meta) => console.error(`[dispatch] ${m}`, meta ?? ''),
    };
  }

  // ==========================================================================
  // Public control API
  // ==========================================================================

  /**
   * Begin dispatching a campaign. Finds the next pending step and launches
   * its send loop in the background. Returns after the loop is kicked off —
   * it does NOT await completion.
   */
  async startCampaign(campaignId: string): Promise<void> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
        session: true,
      },
    });

    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
    if (campaign.status === 'RUNNING') {
      throw new Error('Campaign is already running');
    }

    if (!acquireSessionLock(campaign.sessionId)) {
      throw new Error(
        'Another campaign is already running on this session. ' +
          'Only one concurrent dispatch per session is allowed.',
      );
    }

    // Double-check the DB while holding the lock — defends against a
    // crashed process that left RUNNING state behind.
    const conflict = await this.prisma.campaign.findFirst({
      where: {
        sessionId: campaign.sessionId,
        status: 'RUNNING',
        id: { not: campaignId },
      },
    });
    if (conflict) {
      releaseSessionLock(campaign.sessionId);
      throw new Error('Another campaign is already RUNNING on this session');
    }

    const nextStep = campaign.steps.find(
      (s) => s.status === 'DRAFT' || s.status === 'SCHEDULED' || s.status === 'PAUSED',
    );
    if (!nextStep) {
      releaseSessionLock(campaign.sessionId);
      throw new Error('No pending step to start');
    }

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'RUNNING', startedAt: campaign.startedAt ?? new Date() },
    });

    await this.startStep(nextStep.id, campaign.sessionId);
  }

  /**
   * Pause the currently running step of a campaign.
   * The send loop will stop at its next safe point (between sends).
   */
  async pauseCampaign(campaignId: string): Promise<void> {
    const activeStepId = registry.findActiveStepOfCampaign(campaignId);
    if (activeStepId) {
      const h = registry.get(activeStepId);
      if (h) h.isPaused = true;
      await this.prisma.campaignStep.update({
        where: { id: activeStepId },
        data: { status: 'PAUSED' },
      });
    }
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'PAUSED' },
    });

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { sessionId: true },
    });
    if (campaign) releaseSessionLock(campaign.sessionId);
  }

  /**
   * Resume a paused campaign. If a step is still registered in memory we
   * flip its paused flag; otherwise we start fresh from the paused step.
   */
  async resumeCampaign(campaignId: string): Promise<void> {
    const activeStepId = registry.findActiveStepOfCampaign(campaignId);
    if (activeStepId) {
      const handle = registry.get(activeStepId);
      if (!handle) return;

      const campaign = await this.prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { sessionId: true },
      });
      if (campaign && !acquireSessionLock(campaign.sessionId)) {
        throw new Error('Session is busy with another campaign');
      }

      handle.isPaused = false;
      await this.prisma.$transaction([
        this.prisma.campaignStep.update({ where: { id: activeStepId }, data: { status: 'RUNNING' } }),
        this.prisma.campaign.update({ where: { id: campaignId }, data: { status: 'RUNNING' } }),
      ]);
      return;
    }

    await this.startCampaign(campaignId);
  }

  /**
   * Hard-stop a campaign. Aborts all running steps, marks them FAILED,
   * and releases the session lock.
   */
  async stopCampaign(campaignId: string): Promise<void> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { sessionId: true },
    });

    const handles = registry.allStepsOfCampaign(campaignId);
    for (const h of handles) {
      h.abortController.abort();
      registry.unregister(h.stepId);
      await this.prisma.campaignStep.update({
        where: { id: h.stepId },
        data: { status: 'FAILED' },
      });
    }

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'FAILED' },
    });

    if (campaign) releaseSessionLock(campaign.sessionId);
  }

  // ==========================================================================
  // Step-level lifecycle
  // ==========================================================================

  /**
   * Start a single step. This is also the entry point for the scheduler
   * when a recurring step fires.
   */
  async startStep(stepId: string, sessionIdHint?: string): Promise<void> {
    const step = await this.prisma.campaignStep.findUnique({
      where: { id: stepId },
      include: {
        campaign: {
          include: {
            session: true,
            recipients: { orderBy: { order: 'asc' } },
          },
        },
      },
    });

    if (!step) throw new Error(`Step ${stepId} not found`);

    const sessionId = sessionIdHint ?? step.campaign.sessionId;

    // If the caller (startCampaign) already holds the lock, we won't be able
    // to re-acquire — so only acquire if it's genuinely free.
    let lockAcquiredHere = false;
    if (!registry.findActiveStepOfCampaign(step.campaignId)) {
      if (!acquireSessionLock(sessionId)) {
        throw new Error('Session is busy with another campaign');
      }
      lockAcquiredHere = true;
    }

    const abortController = new AbortController();
    registry.register({
      abortController,
      isPaused: false,
      campaignId: step.campaignId,
      stepId,
    });

    // Atomically flip the step to RUNNING, ensure the campaign is RUNNING,
    // and materialize the dispatch queue for any recipients that don't
    // already have a log row. If this transaction throws, we must unwind
    // both the registry entry and the session lock — otherwise the session
    // stays permanently blocked until the next process restart.
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.campaignStep.update({
          where: { id: stepId },
          data: { status: 'RUNNING', startedAt: new Date() },
        });
        await tx.campaign.update({
          where: { id: step.campaignId },
          data: {
            status: 'RUNNING',
            startedAt: step.campaign.startedAt ?? new Date(),
            totalRecipients: step.campaign.recipients.length,
          },
        });

        const existing = await tx.dispatchLog.findMany({
          where: { campaignId: step.campaignId, stepId },
          select: { recipientId: true, status: true },
        });
        const alreadyQueued = new Set(
          existing.filter((l) => l.status !== 'FAILED').map((l) => l.recipientId),
        );

        const toCreate = step.campaign.recipients
          .filter((r) => !alreadyQueued.has(r.id))
          .map((r) => ({
            campaignId: step.campaignId,
            stepId,
            recipientId: r.id,
            status: 'PENDING' as const,
          }));

        if (toCreate.length > 0) {
          await tx.dispatchLog.createMany({ data: toCreate });
        }
      });
    } catch (err) {
      registry.unregister(stepId);
      if (lockAcquiredHere) releaseSessionLock(sessionId);
      throw err;
    }

    // Non-blocking send loop. Errors are caught and logged — never thrown
    // back to the caller, since this returns after kickoff.
    this.runStepLoop(stepId, sessionId, abortController.signal).catch((err) => {
      this.log.error(`step ${stepId} loop crashed`, err);
      registry.unregister(stepId);
      if (lockAcquiredHere) releaseSessionLock(sessionId);
    });
  }

  // ==========================================================================
  // Send loop (the heart of the engine)
  // ==========================================================================

  private async runStepLoop(
    stepId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const step = await this.prisma.campaignStep.findUnique({
      where: { id: stepId },
      include: {
        campaign: { include: { session: true } },
      },
    });
    if (!step) return;

    const config = clampConfig({
      minInterval: step.campaign.minInterval,
      maxInterval: step.campaign.maxInterval,
      batchSize: step.campaign.batchSize,
      batchPause: step.campaign.batchPause,
    });

    // Resume from cursor when present. Prisma `cursor + skip: 1` gives us
    // "everything strictly after this id" cheaply.
    const pending = await this.prisma.dispatchLog.findMany({
      where: {
        campaignId: step.campaignId,
        stepId,
        status: { in: ['PENDING', 'SENDING'] },
      },
      include: { recipient: true },
      orderBy: { createdAt: 'asc' },
      ...(step.lastProcessedLogId
        ? { cursor: { id: step.lastProcessedLogId }, skip: 1 }
        : {}),
    });

    const provider = this.providers[step.campaign.session.channel];
    if (!provider) {
      this.log.error(`no provider registered for channel "${step.campaign.session.channel}"`);
      await this.abortStep(stepId, step.campaignId, sessionId);
      return;
    }

    let totalSent = step.sentCount;
    let totalFailed = step.failedCount;
    let sentInBatch = 0;
    let consecutiveFails = 0;
    let processed = 0;

    for (const log of pending) {
      if (signal.aborted) return;

      // Respect pause — this is the only pause point inside the loop.
      const handle = registry.get(stepId);
      while (handle?.isPaused && !signal.aborted) {
        await sleep(1000, signal).catch((e) => {
          if (e instanceof Error && e.message !== 'Dispatch aborted') throw e;
        });
      }
      if (signal.aborted) return;

      if (!config.allowOutsideSafeHours && !isWithinSafeHours()) {
        this.log.warn('dispatching outside safe hours — higher detection risk');
      }

      await this.prisma.dispatchLog.update({
        where: { id: log.id },
        data: { status: 'SENDING' },
      });

      const payload = this.buildPayload(step);
      const recipient: Recipient = {
        id: log.recipient.id,
        address: log.recipient.address,
        metadata: parseMetadata(log.recipient.metadata),
      };

      let result: SendResult;
      try {
        result = await provider.send(recipient, payload);
      } catch (err) {
        result = {
          ok: false,
          errorCode: 'TRANSIENT',
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }

      if (result.ok) {
        await this.prisma.dispatchLog.update({
          where: { id: log.id },
          data: {
            status: 'SENT',
            messageId: result.messageId,
            sentAt: new Date(),
          },
        });
        totalSent++;
        consecutiveFails = 0;
      } else if (result.errorCode === 'RATE_LIMIT') {
        this.log.warn('rate limited — cooling down');
        await this.prisma.dispatchLog.update({
          where: { id: log.id },
          data: { status: 'PENDING' },
        });
        await sleep(RATE_LIMIT_COOLDOWN_MS, signal).catch((e) => {
          if (e instanceof Error && e.message !== 'Dispatch aborted') throw e;
        });
        if (signal.aborted) return;
        continue; // retry the same log
      } else if (result.errorCode === 'DISCONNECTED') {
        this.log.error('session disconnected — pausing step');
        await this.prisma.dispatchLog.update({
          where: { id: log.id },
          data: { status: 'PENDING' },
        });
        await this.prisma.$transaction([
          this.prisma.campaignStep.update({
            where: { id: stepId },
            data: {
              status: 'PAUSED',
              sentCount: totalSent,
              failedCount: totalFailed,
              lastProcessedLogId: log.id,
            },
          }),
          this.prisma.campaign.update({
            where: { id: step.campaignId },
            data: { status: 'PAUSED' },
          }),
        ]);
        registry.unregister(stepId);
        releaseSessionLock(sessionId);
        return;
      } else {
        await this.prisma.dispatchLog.update({
          where: { id: log.id },
          data: {
            status: 'FAILED',
            errorCode: result.errorCode,
            errorMsg: result.errorMessage,
          },
        });
        totalFailed++;
        consecutiveFails++;

        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          this.log.error(`${MAX_CONSECUTIVE_FAILS} consecutive failures — auto-pausing`);
          await this.prisma.$transaction([
            this.prisma.campaignStep.update({
              where: { id: stepId },
              data: {
                status: 'PAUSED',
                sentCount: totalSent,
                failedCount: totalFailed,
                lastProcessedLogId: log.id,
              },
            }),
            this.prisma.campaign.update({
              where: { id: step.campaignId },
              data: { status: 'PAUSED' },
            }),
          ]);
          registry.unregister(stepId);
          releaseSessionLock(sessionId);
          return;
        }
      }

      processed++;

      // Checkpoint every 5 sends so a crash doesn't force us to resend much.
      if (processed % 5 === 0 || processed === pending.length) {
        await this.prisma.campaignStep.update({
          where: { id: stepId },
          data: {
            sentCount: totalSent,
            failedCount: totalFailed,
            lastProcessedLogId: log.id,
          },
        });
        await this.rollUpCampaignCounters(step.campaignId);
      }

      sentInBatch++;
      if (sentInBatch >= config.batchSize) {
        this.log.info(`batch of ${config.batchSize} complete — pausing ${config.batchPause}s`);
        await sleep(config.batchPause * 1000, signal).catch((e) => {
          if (e instanceof Error && e.message !== 'Dispatch aborted') throw e;
        });
        sentInBatch = 0;
      } else {
        const base = randomDelay(config.minInterval, config.maxInterval);
        const delay =
          processed <= WARMUP_MESSAGES ? Math.round(base * WARMUP_MULTIPLIER) : base;
        await sleep(delay * 1000, signal).catch((e) => {
          if (e instanceof Error && e.message !== 'Dispatch aborted') throw e;
        });
      }
    }

    if (!signal.aborted) {
      await this.prisma.campaignStep.update({
        where: { id: stepId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          sentCount: totalSent,
          failedCount: totalFailed,
          lastProcessedLogId: null,
        },
      });
      await this.handleStepCompletion(stepId, step.campaignId, sessionId);
    }

    registry.unregister(stepId);
    releaseSessionLock(sessionId);
  }

  // ==========================================================================
  // After a step finishes
  // ==========================================================================

  private async handleStepCompletion(
    stepId: string,
    campaignId: string,
    sessionId: string,
  ): Promise<void> {
    const step = await this.prisma.campaignStep.findUnique({
      where: { id: stepId },
    });
    if (!step) return;

    // Recurrence — reset the step and schedule its next run.
    if (step.recurrenceType) {
      const nextRunAt = computeNextRun(step.recurrenceType);
      this.log.info(`step "${step.name}" recurs — next run ${nextRunAt.toISOString()}`);
      await this.prisma.$transaction([
        this.prisma.campaignStep.update({
          where: { id: stepId },
          data: {
            status: 'SCHEDULED',
            nextRunAt,
            recurrenceCount: { increment: 1 },
            sentCount: 0,
            failedCount: 0,
            startedAt: null,
            completedAt: null,
            lastProcessedLogId: null,
          },
        }),
        this.prisma.dispatchLog.deleteMany({ where: { stepId } }),
      ]);
    }

    const allSteps = await this.prisma.campaignStep.findMany({
      where: { campaignId },
      orderBy: { stepOrder: 'asc' },
    });

    const allDone = allSteps.every((s) => s.status === 'COMPLETED' && !s.recurrenceType);
    const hasRecurring = allSteps.some((s) => !!s.recurrenceType);
    const nextPending = allSteps.find(
      (s) => s.status === 'DRAFT' || (s.status === 'SCHEDULED' && !s.nextRunAt),
    );

    if (allDone) {
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      await this.rollUpCampaignCounters(campaignId);
    } else if (hasRecurring && !nextPending) {
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'SCHEDULED' },
      });
      await this.rollUpCampaignCounters(campaignId);
    } else if (nextPending) {
      try {
        await this.startStep(nextPending.id, sessionId);
      } catch (err) {
        this.log.error(`failed to start next step ${nextPending.id}`, err);
      }
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private buildPayload(step: {
    messageType: string;
    messageText: string | null;
    mediaUrl: string | null;
    mediaCaption: string | null;
    templateName: string | null;
    templateLanguage: string | null;
    templateComponents: string | null;
  }): MessagePayload {
    const p: MessagePayload = { type: step.messageType as MessageType };
    if (step.messageText) p.text = step.messageText;
    if (step.mediaUrl) p.mediaUrl = step.mediaUrl;
    if (step.mediaCaption) p.mediaCaption = step.mediaCaption;
    if (step.templateName) p.templateName = step.templateName;
    if (step.templateLanguage) p.templateLanguage = step.templateLanguage;
    if (step.templateComponents) {
      try {
        p.templateComponents = JSON.parse(step.templateComponents);
      } catch {
        // ignore malformed template components
      }
    }
    return p;
  }

  /**
   * Aggregate per-campaign counters from the dispatch log table.
   *
   * Earlier versions summed `step.sentCount` / `step.failedCount`, but those
   * are per-step caches updated on a 5-send interval. When two steps of the
   * same campaign are running (sequentially but overlapping at the edges)
   * the sum-of-cached-counters can lag reality. DispatchLog is the ground
   * truth: one row per (step, recipient), status updated in-transaction
   * with the send.
   */
  private async rollUpCampaignCounters(campaignId: string): Promise<void> {
    const [sentCount, failedCount] = await Promise.all([
      this.prisma.dispatchLog.count({ where: { campaignId, status: 'SENT' } }),
      this.prisma.dispatchLog.count({ where: { campaignId, status: 'FAILED' } }),
    ]);
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { sentCount, failedCount },
    });
  }

  private async abortStep(
    stepId: string,
    campaignId: string,
    sessionId: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.campaignStep.update({
        where: { id: stepId },
        data: { status: 'FAILED' },
      }),
      this.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'FAILED' },
      }),
    ]);
    registry.unregister(stepId);
    releaseSessionLock(sessionId);
  }
}

/**
 * Safely parse opaque JSON metadata stored against a recipient.
 * Bad JSON must never crash the dispatch loop — a single malformed row
 * would take down every future send of the step.
 */
function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
