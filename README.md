# yugotool-backend

**YugoTool** is a local software factory. You give it a work order; it runs it down
an assembly line of Claude Code agents — research, build, QA, validation — in its
own git worktree, stops at gates where a human approves, and delivers a commit or
a pull request.

This repo is everything except the UI: the API, the Temporal worker that runs the
line, the process supervisor and the Electron desktop shell.

```
 desktop (Electron) ──► supervisor ──┬─► Postgres (embedded, ~/.yugotool/pg)
                                     ├─► migrations
                                     ├─► Temporal dev server
                                     ├─► API  :4810  ──► serves yugotool-frontend
                                     └─► worker ──► Agent SDK sessions in git worktrees
```

## Packages

| Path                 | What it is                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`           | NestJS HTTP API + SSE (`/events`). Projects, lines, work orders, runs, settings, Doctor, preview detection. Swagger at `/docs` in dev.             |
| `apps/worker`        | Temporal worker (plain TS). The `workOrderRun` workflow, Agent SDK activities, worktree runner, QA captures and judge.                             |
| `apps/supervisor`    | `yugotool start \| status \| stop`: starts Postgres → migrations → Temporal → API → worker, watches and restarts them, logs to `~/.yugotool/logs`. |
| `apps/desktop`       | Electron shell: runs the supervisor, opens the UI, tray with "needs you" count, native notifications, folder picker.                               |
| `packages/contracts` | Zod schemas and types shared by API, worker and (mirrored) the frontend.                                                                           |
| `packages/db`        | Drizzle schema, migrations, pg client.                                                                                                             |
| `packages/notify`    | Desktop, Slack and Telegram notifications.                                                                                                         |

## Run it

Requirements: Node 24, pnpm 10, the `temporal` CLI, Claude Code logged in (or
`ANTHROPIC_API_KEY`). Optional: `gh` (pull requests), Playwright Chromium (QA), nvm.

```bash
pnpm install && pnpm build
(cd ../yugotool-frontend && pnpm install && pnpm build)
```

**Desktop app** — everything in one window:

```bash
cd apps/desktop && pnpm start
```

**One process, in a browser** — same stack, UI at http://127.0.0.1:4810:

```bash
node apps/supervisor/dist/cli.js start     # status / stop from another shell
```

**Development** — hot reload, your own Postgres:

```bash
pnpm dev:temporal                  # Temporal dev server, UI on :8233
pnpm db:migrate                    # Postgres DB `yugotool` on localhost:5432
pnpm dev                           # API + worker + packages in watch mode
(cd ../yugotool-frontend && pnpm dev)   # http://localhost:4800
```

Open **Settings → Doctor** first: it checks Claude, git, the database, Temporal,
the worker, your repos folder, gh, Chromium and nvm, and says how to fix each.

## Quality gate

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

## Conventions

- Zod everywhere (nestjs-zod DTOs from contract schemas). No class-validator, TypeORM, Prisma, BullMQ.
- Services own transactions; repositories take an `Executor`. Errors are `DomainError` subclasses.
- Every state change publishes an `invalidate` event (pg NOTIFY → SSE) so clients refetch.
- Creates accept a client-generated `id` and are idempotent.
- Agent activities are never auto-retried (cost); bookkeeping activities are.
- Workflow code is deterministic: no I/O, `Date`, `Math.random` or Node APIs in `apps/worker/src/workflows/**`.
- Conventional Commits, English. More in [`CLAUDE.md`](CLAUDE.md).

Specs and decisions live in the `yugotool-work` repo.
