# Basic example

This example boots the engine against a Postgres database, creates one
campaign with 20 fake recipients, and dispatches them using the `MockProvider`
at a compressed schedule (so you can watch it run in under a minute).

## Run it

```bash
# 1. Spin up Postgres (any way you like; docker is easiest)
docker run --rm -d \
  --name mcde-example-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mcde \
  -p 5432:5432 \
  postgres:17-alpine

# 2. Set env and push the schema
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mcde"
npm run db:push

# 3. Run the example
npm run example
```

You should see the engine sending one message at a time, respecting the
intervals, checkpointing progress, and finishing cleanly.

## What to try next

- Crash the process mid-run (Ctrl+C) and start it again — the scheduler
  plus `recoverStuckWork()` will pause the orphaned run, and calling
  `resumeCampaign()` will resume exactly where it left off.
- Turn up `MockProvider`'s `failureRate` or `rateLimitRate` to see how the
  engine reacts to errors.
- Set `batchSize: 3, batchPause: 5` to watch the batching behavior clearly.
