# yugotool-backend

NestJS API + Temporal worker for YugoTool (software factory) — pnpm workspace.

- `apps/api` — NestJS HTTP API + SSE (`GET /events`), port 4810, Swagger at `/docs`
- `apps/worker` — Temporal worker (plain TS, **not** Nest): `workOrderRun` workflow, Agent SDK activities, local git-worktree runner
- `packages/contracts` — Zod schemas + types shared api↔worker (frontend mirrors them)
- `packages/db` — Drizzle schema, migrations, pg client

Spec: `../yugotool-work/specs/0001-mvp.md`.

## Before coding

Load `Skill(nestjs-postgres)` — it is the coding guideline. For workflow code
follow Temporal determinism rules: no I/O, Date, Math.random or Node APIs in
`apps/worker/src/workflows/**`.

## Commands

```bash
pnpm install
pnpm dev:temporal             # Temporal dev server (no Docker), UI on :8233
pnpm db:migrate               # Postgres: local Homebrew, DB `yugotool`
pnpm build && pnpm dev        # api + worker + packages in watch mode

# quality gate — before every commit:
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

## Rules

- Zod everywhere (nestjs-zod DTOs from contract schemas). No class-validator, TypeORM, Prisma, BullMQ.
- Services own transactions; repositories take an `Executor`. Errors are `DomainError` subclasses.
- Every state change publishes an `invalidate` event (pg NOTIFY → SSE) so clients refetch.
- Creates accept a client-generated `id` and are idempotent (offline replay).
- Agent activities are never auto-retried (cost); bookkeeping activities are.
- New pg enum values cannot be used in the same transaction that adds them, and
  drizzle-kit applies all pending migrations in one transaction: put the enum
  change and anything using the new value in separate migrations **and** apply
  them in separate `db:migrate` runs.
- Conventional Commits, English.
