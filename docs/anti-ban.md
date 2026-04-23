# Anti-ban: principles, trade-offs, and why the numbers are the numbers

Any channel that runs on top of a consumer-grade platform (WAHA on top of
WhatsApp Web, third-party SMS brokers with aggressive trunking policies,
unofficial APIs in general) treats "looks automated" as a ban-worthy
signal. The platforms don't tell you their heuristics, so the only defense
is to behave like a human would — consistently, at every point in the
pipeline.

This document is opinionated. The numbers and defaults are the result of
burning real numbers in production. Lowering them without a concrete
reason will eventually cost you an identity.

---

## The mental model

Every anti-ban control in this engine answers one of two questions:

1. **Does this look like a human?** Humans are slow, irregular, and take
   breaks. Bots are fast, uniform, and never stop.
2. **Does this look like a healthy account?** Healthy accounts don't
   burst right after reconnecting, don't hammer when the platform says
   "slow down", and don't continue after failures.

If a control doesn't serve one of those two, it doesn't belong here.

---

## Principle 1 — Single-writer per identity (session lock)

### The problem

Two campaigns dispatching from the same WhatsApp number simultaneously
produce overlapping send patterns. Even if each campaign respects every
other control in this doc, the combined output has:

- Random-looking timing, but with a suspiciously bimodal distribution.
- Simultaneous "typing" events from the same session.
- Bursts that exceed the per-session batch limits.

WhatsApp (and every other platform with heuristics) catches this fast.
In production on the SaaS this engine was extracted from, this was the
#1 cause of banned numbers — pair of campaigns started minutes apart,
number flagged within the hour.

### The solution

Atomic, in-process lock on `sessionId`. When a campaign starts, it
**acquires** the lock; only one holder at a time. A second campaign
trying to start on the same session gets rejected with a clear error.

```ts
if (!acquireSessionLock(campaign.sessionId)) {
  throw new Error('Another campaign is already running on this session');
}
```

We also double-check the database while holding the lock, to defend
against a crashed process that left RUNNING state behind.

### Trade-off

This is strictly **in-process**. If you run two instances of the engine
against the same DB, the in-memory lock doesn't help you — you'd need
a distributed lock (Redis `SETNX`, Postgres advisory lock, etc.).

We kept it in-process because:

- Most users of the engine run a single instance.
- The abstraction is tiny (`session-lock.ts` is 50 lines) and trivially
  swappable. Replace the backing store, keep the same function
  signatures, done.
- A distributed lock adds a dependency (Redis) that most projects don't
  need on day one.

---

## Principle 2 — Randomized inter-message intervals

### The problem

A human doesn't send messages at exactly 5-second intervals. A bot does.
Uniform timing is one of the cheapest signals for a platform to flag:
"variance of inter-message delta is < X" catches more bots than any
content heuristic.

Fixed intervals — even slow ones — are a tell.

### The solution

Every send waits a **random** delay in `[minInterval, maxInterval]`
seconds. Uniform distribution; no two consecutive delays are expected
to match.

Defaults:

- `minInterval`: 8 seconds (also the hard floor — see below)
- `maxInterval`: 25 seconds

The engine clamps user config against these floors silently. If a user
configures `minInterval: 3`, the dispatch loop uses 8.

### Trade-off

Randomization has a cost in throughput predictability. A campaign of
1000 messages with interval 8–25s takes somewhere between 2h13m and
6h57m to complete. You can't tell ops "it'll be done at 4pm" — you can
only give a range.

For bulk marketing this is fine. For transactional messaging (where
timing matters) you'd bypass this layer entirely and call the provider
directly.

---

## Principle 3 — Warmup window

### The problem

A session that just connected and immediately starts sending at full
speed is the most recognizable bot pattern in existence. Platforms are
especially suspicious of:

- First messages after a fresh login.
- First messages after a reconnection event.
- First messages after an unusually long idle period.

All three collapse into "the session was quiet, now it's blasting" —
which is exactly what a hijacked account looks like.

### The solution

The first `WARMUP_MESSAGES` (5) sends of every step use an interval
multiplied by `WARMUP_MULTIPLIER` (2.5x).

```
Message 1  → wait ~20–62s  (warmup)
Message 2  → wait ~20–62s
Message 3  → wait ~20–62s
Message 4  → wait ~20–62s
Message 5  → wait ~20–62s
Message 6+ → wait ~8–25s   (normal)
```

This gives the platform's heuristics time to classify the session as
"active and behaving normally" before the heavier volume hits.

### Trade-off

Only the first 5 sends are slow, so the overhead is fixed regardless of
campaign size. For a 20-message campaign the warmup adds ~4 minutes;
for a 2000-message campaign it's still the same ~4 minutes. The cost
amortizes to nothing on realistic volumes.

What this does NOT do: warmup a **new** identity. A brand-new WhatsApp
number still needs 1–2 weeks of low-volume sending at the product layer
before it can take real campaigns. This engine warms up **each step**,
not the phone number.

---

## Principle 4 — Batches with mandatory pauses

### The problem

Even with perfectly randomized 8–25s intervals, 500 messages in a row
without interruption is still uncannily machine-like. Real humans send
in bursts: 10 messages in a session, then a 5-minute lull (checked email,
answered a call, went to the bathroom), then another burst.

Continuous streams — regardless of speed — trip volume-over-window
heuristics.

### The solution

After every `batchSize` messages, the loop pauses for `batchPause`
seconds.

- Default batch: 10 messages
- Default pause: 120 seconds
- Hard ceiling on batch size: 20
- Hard floor on pause: 60 seconds

```
[10 msgs at 8–25s each] → pause 120s → [10 msgs] → pause 120s → …
```

A 500-message campaign therefore has ~50 batches separated by 2-minute
breaks — producing a timeline that looks like a human working through a
contact list across a workday.

### Trade-off

Batching slows total delivery by 15–25% compared to pure interval-based
sending. On a 1000-message campaign that's an extra ~30 minutes. For
bulk messaging this is acceptable; for time-sensitive use cases,
bypass this engine.

---

## Principle 5 — Safe-hours awareness

### The problem

WhatsApp marketing messages at 3am are suspicious on their face. Real
businesses message customers during business hours. Automated spam
doesn't care about the clock.

Off-hours volume is a heuristic signal on its own, and it's especially
damning when combined with any other flag.

### The solution

The engine defines a "safe window" of **7am–10pm** local time. During
the dispatch loop, if the current time falls outside that window, the
engine logs a warning on every send. A future option will allow
blocking entirely.

```ts
if (!config.allowOutsideSafeHours && !isWithinSafeHours()) {
  this.log.warn('dispatching outside safe hours — higher detection risk');
}
```

### Trade-off

We log instead of block because real use cases require off-hours
delivery: international campaigns across time zones, reminder messages
scheduled for early morning, etc. The user can flip a flag to enforce
strict blocking if their business allows it.

The trade-off is visibility — a warning in the logs only helps if
someone reads the logs.

---

## Principle 6 — Respect rate-limit signals

### The problem

When the provider returns a rate-limit response (HTTP 429, or an
equivalent error code for unofficial APIs), the **wrong** reactions are:

1. Retry immediately. Makes things worse.
2. Retry faster. Makes things much worse.
3. Skip this message and send the next one. Confirms "automated
   system that ignores back-pressure" → fast-tracks the ban.

A rate-limit signal is the platform telling you *"you're close to the
line"*. The only sane response is to back off further than it asked.

### The solution

On any `RATE_LIMIT` error from the provider:

1. **Wait 5 full minutes** (`RATE_LIMIT_COOLDOWN_MS`).
2. **Retry the same message** (not the next one).
3. Resume normal pace afterward.

```ts
if (result.errorCode === 'RATE_LIMIT') {
  await prisma.dispatchLog.update({ where: { id: log.id }, data: { status: 'PENDING' } });
  await sleep(RATE_LIMIT_COOLDOWN_MS, signal);
  continue; // retry same log
}
```

The message stays in the queue (status flipped back to `PENDING`) and
the loop retries it after the cooldown.

### Trade-off

Five minutes is a long pause and users sometimes feel it's too much.
It's intentional: a rate-limit signal means you've already crossed
*some* threshold, and the cost of a ban is weeks of work (registering
new numbers, warming them up) versus the cost of a 5-minute pause
(literal minutes).

Shorter cooldowns were tried in the original SaaS and produced worse
ban rates. Five minutes held up.

---

## Principle 7 — Auto-pause on consecutive failures

### The problem

Five failed sends in a row almost always mean something structural is
wrong:

- The session got banned and every send returns an error.
- The provider's endpoint is down.
- The network is flaky.
- The template was rejected and every retry hits the same wall.

Continuing to send in any of these states achieves nothing except
filling the failure log — and if the cause is a soft-ban, it actively
makes things worse by generating an obvious "automated retry loop"
pattern.

### The solution

After `MAX_CONSECUTIVE_FAILS` (5) non-rate-limit, non-disconnected
errors in a row, the engine:

1. Pauses the current step.
2. Pauses the campaign.
3. Persists the cursor so resume picks up exactly where we stopped.
4. Releases the session lock.
5. Waits for a human to investigate and explicitly resume.

No automatic retry after a pause. This is deliberate — if the cause is
real, retrying automatically turns a small outage into a full ban.

### Trade-off

Pausing-by-default means operators occasionally need to go resume a
campaign that paused for a transient reason (a provider hiccup of a
minute). That's more ops overhead than auto-resume.

We chose ops overhead over silent ban risk every time.

---

## Principle 8 — Disconnection detection

### The problem

WhatsApp Web sessions can "disconnect" in several ways:

- QR code expired, needs rescanning.
- Phone went offline for too long.
- User logged in elsewhere.
- WAHA server lost its backing container.

When this happens, sends either silently queue (and deliver once the
session reconnects — producing the exact burst pattern we've been
avoiding) or fail with a specific error code depending on the provider.

Either outcome is dangerous. A burst of pent-up messages on reconnect
is textbook suspicious behavior.

### The solution

Providers can return a `DISCONNECTED` error code. When the engine sees
that:

1. The current message is flipped back to `PENDING` (not `FAILED`).
2. The step is paused.
3. The campaign is paused.
4. The session lock is released.
5. `lastProcessedLogId` is persisted so resume knows where to continue.

When the human fixes the session and calls `resume()`, the engine
continues from the saved cursor — at the normal pace. No queued burst.

### Trade-off

This requires the provider implementation to correctly classify errors.
If your provider always returns `TRANSIENT` when it should be returning
`DISCONNECTED`, the consecutive-failure pause (Principle 7) is your
fallback — but that's 5 failed sends you didn't need to make.

Good provider implementations are the foundation of all these controls.

---

## Bonus: Crash-safe progress cursor

### The problem

Your process is going to crash. Your container is going to restart.
Your deploy is going to ship mid-campaign. All of those, if handled
naively, either lose progress (user pays to resend) or create duplicate
sends (recipient sees the same message twice — which platforms also
flag as spam).

### The solution

Every 5 sends, the engine persists a checkpoint:

```ts
await prisma.campaignStep.update({
  where: { id: stepId },
  data: {
    sentCount, failedCount,
    lastProcessedLogId: log.id, // the resume cursor
  },
});
```

On boot, `recoverStuckWork()` flips orphaned RUNNING state back to
PAUSED. When the operator resumes, the loop uses the cursor to fetch
only logs created *after* the last processed one.

### Trade-off

There's a small replay window: if the process crashes between sending
message N+3 and checkpointing at N+5, on resume the engine will try to
send N+1, N+2, N+3 again. For any messaging channel with built-in
retries (WhatsApp, Twilio), this is harmless — a duplicate message ID
is deduped at the provider. For provider implementations that don't
handle this, add a pre-send dedupe key inside the provider itself.

We chose "may-double-send on crash" over "may-silent-drop on crash".
For user-visible messaging, a duplicate is recoverable; a drop isn't.

---

## What this engine does NOT protect against

Honesty: anti-ban has hard limits. The engine handles **delivery
mechanics**. These are still your responsibility:

- **Content**. Repeated generic marketing copy, links to
  known-suspicious domains (shorteners with bad reputation), or
  patterns flagged by the platform's content model. Diversify your
  copy, use your own short-link domain, avoid all-caps CTAs.
- **Opt-in discipline**. Messaging people who didn't opt in triggers
  user-reported abuse, which is instant and irrecoverable. No engine
  helps you here.
- **Cold number warmup**. A fresh WhatsApp number needs weeks of
  low-volume messaging before it can handle campaign load. This engine
  warms up **each dispatch**, not the identity.
- **Per-recipient frequency**. Sending the same phone 15 messages
  across three campaigns in a week is spam by any measure. Track
  recipient-level frequency at the application layer.

---

## TL;DR — the whole philosophy in one paragraph

Behave like one busy human working through a contact list on a workday.
Random pauses between sends. Warm up when you start. Take a coffee break
every 10 messages. Never work the night shift. When the platform says
"slow down", stop for 5 minutes. When 5 things fail in a row, walk away
and come back tomorrow. Remember where you left off if someone pulls
the plug.

Everything in the engine is one of those behaviors, made explicit,
encoded in code, and tested.
