# Architecture

This document covers the moving parts, why they exist, and how they fit
together. Read this after the README if you want to understand or extend
the engine.

## Domain model

```
Session 1 ─────< Campaign 1 ─────< CampaignStep 1 ─────< DispatchLog
                         └────< CampaignRecipient ─────< DispatchLog
```

- **Session** — a channel identity (a WhatsApp number, an SMS sender id,
  an email from-address). The engine guarantees only one active campaign
  per session at any time.
- **Campaign** — the top-level unit of work. Holds anti-ban config and
  cached counters.
- **CampaignStep** — a stage. Steps run sequentially by `stepOrder`, can
  have their own message and schedule, and can recur.
- **CampaignRecipient** — the target list, stored separately so multiple
  steps reference the same recipient without duplication.
- **DispatchLog** — one row per (step, recipient). This is both the audit
  trail and the queue: `PENDING` logs are the work yet to be done.

## The send loop

The loop is the heart of the engine. Given a running step, it:

1. Loads `PENDING` and `SENDING` logs in FIFO order.
2. For each log:
   - Respects a pause flag (checks every second).
   - Logs a warning if outside safe hours (does not block unless configured).
   - Flips the log to `SENDING`, calls `provider.send()`, flips to `SENT` or
     `FAILED` based on the outcome.
   - Classifies the error code:
     - `RATE_LIMIT` → cooldown for 5 min, retry the same log.
     - `DISCONNECTED` → pause the step and the campaign, release the lock.
     - `FATAL` / `INVALID_RECIPIENT` → mark the log failed, move on.
     - `TRANSIENT` → mark failed, increment consecutive-fail counter.
   - After `MAX_CONSECUTIVE_FAILS` in a row, auto-pauses.
3. Every 5 sends, persists `sentCount`, `failedCount`, and
   `lastProcessedLogId` (the resume cursor).
4. Between sends, sleeps a randomized delay. The first
   `WARMUP_MESSAGES` sends use a multiplier to avoid a burst right after
   the session wakes up.
5. Between batches of `batchSize`, sleeps `batchPause` seconds.

All sleeps honor an `AbortSignal` so `stopCampaign()` unblocks immediately.

## Concurrency model

### Session lock

A per-session, in-process `Set<string>` gives atomic acquire/release.
Attempting to start a second campaign on a locked session throws.

This is deliberately in-memory. For multi-instance deployments replace
the backing store with Redis `SETNX` or a Postgres advisory lock — the
API stays the same; only `session-lock.ts` changes.

### Overlap-safe scheduler

The scheduler polls every 30s. It guards against its own overlap with a
`running` flag (a tick in progress skips the next one), and guards
against double-processing of the same step across ticks with an
idempotent claim (`updateMany` with a status condition).

For multi-instance deployments, replace the claim with
`SELECT ... FOR UPDATE SKIP LOCKED` or a lease table.

## Crash recovery

The engine writes its cursor to the DB every 5 sends. On boot:

1. `recoverStuckWork()` clears in-memory locks, flips orphaned RUNNING
   campaigns/steps to PAUSED, and resets stuck `SENDING` logs to
   `PENDING`.
2. Nothing restarts automatically — that decision is left to the
   operator (via an API call or a manual retry). This is on purpose:
   silently resuming a campaign that failed for a real reason (banned
   session, expired token, etc.) makes things worse.

Resetting `SENDING` back to `PENDING` is the only non-idempotent step:
the provider *may* have accepted the message before the crash, so a
resume can double-send. For any messaging channel that has retries
built in (WhatsApp, Twilio), this is the safer trade-off. If you need
exactly-once semantics for the last-in-flight message, add a
pre-send dedupe key and check the provider's status API before retrying.

## State machines

### Campaign

```
DRAFT ─────startCampaign────▶ RUNNING
  │                            │
  │                    pauseCampaign
  │                            ▼
  └──scheduler sets────▶ SCHEDULED ────startCampaign────▶ RUNNING
                                                          │    │
                            stopCampaign ◀────┬───────────┘    │
                                              │       all steps done
                                              ▼               │
                                           FAILED          COMPLETED
```

### Step

```
DRAFT ─────startStep────▶ RUNNING ────all logs sent────▶ COMPLETED
  │                         │  │                          │
  │                  disconnection                   recurrence?
  │                  or 5 fails in a row                  │
  │                         │  │                          │
  └──scheduler sets──▶ SCHEDULED ◀──────────────────────  │
                            ▲                              │
                            └──── nextRunAt set ───────────┘
```

## Extension points

- **New channel**: implement `ChannelProvider`, register it in the
  `providers` map when constructing the engine, and set
  `session.channel` to the provider's name.
- **Different queue store**: replace the DB reads in `runStepLoop` with
  your queue of choice; keep the checkpoint write so crash recovery
  still works.
- **Custom pre/post hooks**: wrap the `DispatchEngine` methods in your
  application layer. The engine does not provide hooks internally — if
  you need them often, a PR is welcome.
