# Contributing

Thanks for the interest. A few conventions to keep things consistent.

## Branching & commits

- Work off `main`. For anything non-trivial, open a PR.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Small, focused commits are preferred over one huge one.

## Code style

- TypeScript strict mode is on. No `any` without a `// why:` comment.
- Run `npm run lint` and `npm run typecheck` before pushing.
- Run `npm test` — PRs that drop coverage will be asked to add tests.

## Design defaults

- **Err on the side of safety for anti-ban.** If you're adding a knob,
  pick a default that is conservative even if it slows delivery.
- **The DB is the source of truth.** In-memory state is always
  reconstructable.
- **Every sleep must honor an `AbortSignal`.** Loops that can't be
  interrupted are bugs.

## What makes a good PR

- A clear problem statement (link an issue if there is one).
- A test that fails without the change and passes with it.
- Docs updated if behavior or API changes.
- No unrelated reformatting / drive-by changes.
