# Anti-ban controls

Most unofficial channels (WAHA for WhatsApp, third-party SMS brokers with
trunking policies, etc.) will silently throttle or ban identities that
behave suspiciously. This document explains what the engine does about it
and why.

None of these numbers are arbitrary — they come from production experience.
Don't lower them without a concrete reason.

## Hard floors (cannot be disabled)

| Constant                 | Value         | Why                                                                 |
|--------------------------|---------------|---------------------------------------------------------------------|
| `MIN_SAFE_INTERVAL`      | 8 s           | Sustained inter-message rate below this gets WhatsApp sessions banned within hours. |
| `MAX_BATCH_SIZE`         | 20            | Bursts of more than ~20 at any speed trip heuristics on most channels. |
| `MIN_BATCH_PAUSE`        | 60 s          | Pauses shorter than this don't materially reduce burst risk.        |
| `MAX_CONSECUTIVE_FAILS`  | 5             | 5 fails in a row almost always means the identity is unhealthy.    |
| `RATE_LIMIT_COOLDOWN_MS` | 5 min         | Shorter cooldowns after a rate-limit signal get the session flagged. |

User config below these floors is silently raised.

## Warmup

The first `WARMUP_MESSAGES` (5) sends of any step use `WARMUP_MULTIPLIER`
(2.5x) slower intervals. This matters because:

- After a reconnection / fresh login, full-speed bursts are the most
  likely pattern to trigger a ban.
- A slow first few messages give the provider's heuristics time to
  recognize "normal behavior" before the bulk of the campaign goes out.

## Safe hours

Sends outside the window `SAFE_HOURS_START..SAFE_HOURS_END` (7am–10pm
local) log a warning. By default the loop still proceeds — many business
cases require off-hours delivery. Flip `allowOutsideSafeHours: false`
(the default) to at least get the warning; in future a `block` option
may refuse to send.

## Per-session singleton

Only one campaign runs on a session at any time. Two concurrent dispatches
on the same identity produce overlapping patterns that are trivially
detectable. The session lock is in-memory for single-instance; for
multi-instance you swap in a Redis or Postgres-backed implementation
without touching the rest of the code.

## What the engine does NOT do

- **Content inspection** — you ship whatever text/media you want. Avoid
  classic patterns (shortened URLs with suspicious tracking domains,
  repeated high-CTR copy) at the application layer.
- **Per-recipient dedupe** across campaigns — if you send the same
  recipient the same message from three different campaigns, that's on
  you.
- **Warmup for new identities** — this is per-step, not per-identity.
  A brand-new WhatsApp number still needs a slow 2-week warmup at the
  product layer (100 messages/day, growing). Don't use this engine to
  break in a fresh number.
