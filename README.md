# multi-channel-dispatch-engine

A production-grade dispatch engine for sending messages at scale across any
channel (WhatsApp, SMS, Email, Telegram, custom internal queues) with built-in
anti-ban protections, concurrency control, and crash recovery.

Written in TypeScript. Uses Prisma + PostgreSQL as the durable store.
Extracted from a messaging SaaS that has been running this pattern in
production.

```
┌────────────┐        ┌───────────────┐        ┌────────────────┐
│ Scheduler  │──────▶│ DispatchEngine │──────▶│ ChannelProvider │──▶ WhatsApp / SMS / Email / …
└────────────┘        └───────┬───────┘        └────────────────┘
                              │
                              ▼
                      ┌───────────────┐
                      │  PostgreSQL   │  ← single source of truth
                      └───────────────┘
```

## Why this exists

Every time you build a feature that sends messages in bulk, you end up
rediscovering the same handful of traps:

- Concurrent campaigns on the same number get the number banned.
- A burst of messages right after reconnecting gets the session flagged.
- If the process crashes mid-campaign, you either lose progress or re-send
  everything.
- A rate-limit signal from the provider, handled naively, gets the
  session flagged faster than if you'd ignored it.
- Manually paging through 50k recipients doesn't scale.

This engine solves those once so you don't solve them again.

## Features

- **One campaign per session, guaranteed.** Atomic in-process lock with
  a DB double-check; safe to swap for Redis / Postgres advisory locks
  for multi-instance deployments.
- **Warmup, batching, safe hours.** First N sends are slower, batches
  of ≤20 with mandatory pauses, warnings outside business hours.
- **Error classification.** Rate limits cool down and retry the same
  message. Disconnections pause the campaign. Fatal errors skip. A run
  of `MAX_CONSECUTIVE_FAILS` auto-pauses.
- **Crash recovery.** Every 5 sends the engine checkpoints its cursor
  (`lastProcessedLogId`). On boot, `recoverStuckWork()` marks orphaned
  runs as PAUSED; resuming them continues from the last checkpoint.
- **Scheduler with overlap guard.** Polls for due work, claims items
  idempotently, skips its own tick if the previous one is still in
  flight.
- **Channel-agnostic.** Implement the `ChannelProvider` interface and
  wire it in — WhatsApp (WAHA or Cloud API), SMS (Twilio, SMSDev), email,
  Slack, Telegram, your own internal queue. Same engine.
- **Sequential steps with recurrence.** A campaign is a list of steps;
  each step can carry its own message and schedule, and can recur daily
  / 3d / 7d / 15d / 30d.

## Install

```bash
npm install multi-channel-dispatch-engine @prisma/client
```

You also need the engine's schema merged into your Prisma schema
(`prisma/schema.prisma` in this repo is the canonical source).

## Quick start

```ts
import { PrismaClient } from '@prisma/client';
import {
  DispatchEngine,
  Scheduler,
  MockProvider,
  recoverStuckWork,
} from 'multi-channel-dispatch-engine';

const prisma = new PrismaClient();

// 1. Implement or import a provider
const whatsapp = new MockProvider(); // replace with a real one for production

// 2. Boot the engine
await recoverStuckWork({ prisma });
const engine = new DispatchEngine({
  prisma,
  providers: { whatsapp },
});

// 3. Start the scheduler (for scheduled / recurring campaigns)
new Scheduler({ prisma, engine, tickMs: 30_000 }).start();

// 4. Send
await engine.startCampaign(campaignId);
```

See [`examples/basic`](./examples/basic) for a runnable end-to-end demo.

## Building a provider

```ts
import type { ChannelProvider, Recipient, MessagePayload, SendResult } from 'multi-channel-dispatch-engine';

export class MyProvider implements ChannelProvider {
  readonly name = 'my-provider';

  async send(recipient: Recipient, payload: MessagePayload): Promise<SendResult> {
    try {
      const res = await fetch('https://api.example.com/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.MY_TOKEN}` },
        body: JSON.stringify({ to: recipient.address, text: payload.text }),
      });

      if (res.status === 429) return { ok: false, errorCode: 'RATE_LIMIT' };
      if (res.status === 401) return { ok: false, errorCode: 'DISCONNECTED' };
      if (!res.ok) return { ok: false, errorCode: 'TRANSIENT', errorMessage: await res.text() };

      const { id } = await res.json();
      return { ok: true, messageId: id };
    } catch (err) {
      return { ok: false, errorCode: 'TRANSIENT', errorMessage: String(err) };
    }
  }
}
```

The error-code classification drives everything — see
[`docs/anti-ban.md`](./docs/anti-ban.md) for the full table.

## Control API

```ts
await engine.startCampaign(id);   // begin (and lock the session)
await engine.pauseCampaign(id);   // stop cleanly at the next send boundary
await engine.resumeCampaign(id);  // pick up from the last checkpoint
await engine.stopCampaign(id);    // abort (AbortController + mark FAILED)
```

Multi-step campaigns chain automatically: when a step completes, the next
pending step (by `stepOrder`) starts.

## Recurrence

Set a step's `recurrenceType` to one of `daily`, `every_3d`, `every_7d`,
`every_15d`, `every_30d`. When the step completes, the engine:

1. Resets its counters.
2. Computes `nextRunAt = now + interval`.
3. Marks it `SCHEDULED`.

The scheduler picks it up on the next tick after `nextRunAt`.

## Anti-ban defaults

Any user config below these floors is silently raised:

| Setting                 | Floor / ceiling     |
|-------------------------|---------------------|
| `minInterval`           | ≥ 8 s               |
| `maxInterval`           | ≥ `minInterval + 5` |
| `batchSize`             | ≤ 20                |
| `batchPause`            | ≥ 60 s              |
| Warmup multiplier       | 2.5× for first 5 sends |
| Consecutive fail pause  | 5                   |
| Rate-limit cooldown     | 5 minutes           |

See [`docs/anti-ban.md`](./docs/anti-ban.md) for the reasoning.

## Data model

```
Session        one per channel identity (a WhatsApp number, an SMS sender id, …)
Campaign       one per send campaign; owns anti-ban config
CampaignStep   one per stage; carries the message, schedule, recurrence
CampaignRecipient  the target list (addresses + metadata)
DispatchLog    one per (step, recipient); audit trail AND queue
```

Full schema: [`prisma/schema.prisma`](./prisma/schema.prisma).

## Scaling to multiple instances

The codebase is ready for it with two swaps:

1. Replace `src/session-lock.ts` with a Redis `SETNX` or Postgres advisory
   lock. Keep the same function signatures.
2. Replace the scheduler's `updateMany` claim with
   `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction (or a lease
   table with TTL).

Everything else — the dispatch loop, recovery, state machine — already
treats the DB as the source of truth.

## Design decisions (why the engine looks the way it looks)

Every choice in this codebase was made against a specific production failure.
The deep rationale lives in [`docs/anti-ban.md`](./docs/anti-ban.md) and
[`docs/architecture.md`](./docs/architecture.md); the short version:

- **Single-writer per identity.** Two concurrent campaigns on the same
  WhatsApp number is the #1 cause of banned sessions in the SaaS this was
  extracted from. Enforced by an atomic in-process lock with a DB
  double-check.
- **Randomized intervals, always.** Uniform timing is the cheapest
  bot-detection signal. Every send waits `random(minInterval, maxInterval)`;
  `minInterval` has an 8s hard floor regardless of user config.
- **Warmup window on every step.** The first 5 sends after a step starts
  use a 2.5× multiplier. Full-speed bursts right after a reconnect are the
  most recognizable bot pattern.
- **Mandatory pause between batches.** Continuous streams trip
  volume-over-window heuristics even at slow rates. Defaults: pause 120s
  after every 10 sends; hard cap 20 per batch, hard floor 60s pause.
- **Safe-hours awareness.** Warn (or optionally block) sends outside
  07:00–22:00 local. Off-hours volume is a heuristic signal on its own.
- **Rate-limit cooldown = 5 minutes.** Shorter cooldowns make bans
  faster, not slower. When the platform asks you to slow down, you
  overshoot the request.
- **Auto-pause after 5 consecutive failures.** Five in a row almost
  always means the identity is unhealthy. Resume is manual — no silent
  retry loop.
- **Disconnection = pause the campaign, not the message.** Queued sends
  on a disconnected session turn into a burst on reconnect, which is
  exactly the pattern we're trying to avoid.
- **Progress checkpoint every 5 sends.** Survives crashes, deploys,
  container restarts. Resume picks up from `lastProcessedLogId`, not
  from zero.
- **DB is the source of truth.** In-memory state (session locks,
  dispatch handles) is rebuilt on boot via `recoverStuckWork()`. No
  magic state lives outside the database.

Most of these sit behind named constants at the top of
[`src/constants.ts`](./src/constants.ts). The numbers aren't arbitrary —
they're the product of lost identities.

## Status

MIT licensed. Used in production for bulk WhatsApp campaigns sending
~10k+ messages/day. API is considered stable at 1.x; breaking changes
will ship as 2.x.

Issues and PRs welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Documentation

- [**Anti-ban controls**](./docs/anti-ban.md) — the 8 principles behind
  the engine, with problem/solution/trade-off for each. **Start here**
  to understand the "why".
- [Architecture](./docs/architecture.md) — moving parts, state machines,
  extension points.
- [Basic example](./examples/basic) — runnable end-to-end demo.

## License

MIT — see [LICENSE](./LICENSE).
