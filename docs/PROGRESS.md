# LeadRescue AI — Implementation Progress

Each subphase is marked complete only after its verification gate actually ran.
Evidence lists the exact commands executed and their observed results.

| Phase | Subphase | Status | Verification evidence |
|-------|----------|--------|-----------------------|
| P00 | P00.01 Repository and TypeScript foundation | ✅ Done | `tsc --noEmit` clean; `eslint .` clean; `vitest run` 5/5 passed (config validation, redaction, ids) |
| P00 | P00.02 Mastra, Studio, persistence, baseline workflow | ✅ Done | `mastra dev` served Studio (HTTP 200) and listed `platformHeartbeatWorkflow`; runs started through the API (`mastra api workflow run start`) and from a separate tsx process (`scripts/smoke-heartbeat.ts`) both appeared in the dev server's run list and trace store; `better-sqlite3` loads inside the Mastra bundle (`bundler.externals`); integration test `mastra-runtime.test.ts` passed (run snapshot + spans persisted to LibSQL) |
| P00 | P00.03 Ollama integration, configuration, health checks | ✅ Done | Pulled local `qwen2.5:7b` (tools capability). `pnpm ollama:smoke` PASS: plain generation ("pong"), tool call (1 call) and schema-validated structured output through Mastra's router; `pnpm test:ollama` 1/1 passed; probe/health unit tests 9/9; live `GET /health/ready` on the Mastra server returned `ai.state=ready`, `required:false` |
| P01 | P01.01 Domain models and contracts | ✅ Done | Pure domain modules (lead contract + normalization, delivery state machine, failure taxonomy, remediation/operator action allowlists, incidents, jobs, Zod assessment contract); `domain.test.ts` 18 tests passed, including no-fabrication and illegal-transition cases; tsc/eslint clean |
| P01 | P01.02 Database schema, migrations, repositories | ✅ Done | 16 tables, 9 triggers (state-machine enforcement, append-only histories, immutable finished attempts), tenant-scoped unique indexes, FK enforcement, AES-256-GCM credentials with tenant-bound AAD; `repositories.test.ts` 13 tests passed (idempotency, tenant isolation, illegal transitions rejected by SQLite itself, refresh lock + optimistic versioning, monotonic checkpoints); migration applied to `data/leadrescue.db` by the running Mastra server |
| P01 | P01.03 Durable jobs, leases, recovery | ✅ Done | SQLite job queue (BEGIN IMMEDIATE claims, lease-token fencing, heartbeats, expired-lease reclaim, crash-loop → dead), concurrent `JobRunner`, `LeadJobWorker` (MastraWorker); `job-queue.test.ts` 9 tests passed 3× consecutively: 4 runners on separate connections processed 60 jobs exactly once, crashed worker's job recovered by a new worker after lease expiry, stale worker's completion discarded |
| P02 | P02.01 Advertising source simulator | ✅ Done | Meta-style simulator (own SQLite file, HTTP only): lead creation, HMAC-SHA256 signed identifier-only webhooks with bounded retries, Graph-style lead read, keyset cursor listing, page-token tenant isolation, drop/duplicate/http_error/omit_fields faults with attribution; `MetaSourceClient` with typed `IntegrationError`; `meta-simulator.test.ts` 5/5 passed (57 leads sharing timestamps + mid-scan insert paginated with no gaps/duplicates); `pnpm sim` process served `/health`, admin API rejected missing token (401) |

## Framework verification log

- Mastra skill installed with `npx skills add mastra-ai/skills` (`.agents/skills/mastra`, symlinked for Claude Code).
- Pinned versions: `@mastra/core@1.81.0`, `mastra@1.37.0` (CLI), `@mastra/libsql@1.28.0`, `@mastra/observability@1.23.0`, `@mastra/loggers@1.3.10`, `zod@4.6.7`.
- TypeScript pinned to `6.0.3`: `typescript-eslint@8.72.1` declares `typescript <6.1.0`, so TypeScript 7 (native port) is not yet compatible with linting.
- APIs verified against embedded docs in `node_modules/@mastra/core/dist/docs/references`:
  - `createWorkflow({ schedule: { cron } })`: native cron scheduling (SchedulerWorker, LibSQL `schedules` domain supported).
  - `Mastra({ workers: MastraWorker[] })`: custom workers merge with default workers; used for the durable job runner.
  - `Mastra({ recovery: { workflows: 'off' } })`: disables Mastra's boot-time workflow restart. Job leases own crash recovery, so nothing executes twice.
  - `registerApiRoute(path, { method, handler, requiresAuth })`: custom HTTP routes on the Mastra (Hono) server.
  - `OpenAICompatibleConfig { providerId, modelId, url }`: the model router has only `ollama-cloud` (remote, excluded), so local Ollama is reached through its OpenAI-compatible `/v1` endpoint.
  - Observability: `Observability` + `MastraStorageExporter`; LibSQL supports traces but **not** Studio's Metrics tab (requires DuckDB/ClickHouse). App-level metrics come from the application database instead.

- Ollama: `qwen2.5:7b` cannot combine tool calls and `response_format` in one request (the tool was skipped and the JSON came back empty). Both documented workarounds were verified locally: a separate structuring `model` (3.4s, used by default) and `jsonPromptInjection: true` (1.6s). `deepseek-r1:7b` supports tools but is a reasoning model and too slow for incident triage. `gemma3` lacks tool support, and `*-cloud` models are remote; the probe rejects both.

## Framework defects found and worked around

- **Studio trace list crash (`stored.trim is not a function`)**: `@mastra/libsql@1.28.0`'s generic row loader JSON-parses any string that starts with `{`, which turns stored span previews such as `{"requestedBy":"x"}` into objects. `@mastra/core@1.81.0`'s `lightPreview()` then calls `.trim()` on them, and `GET /api/observability/traces/light` (used by Studio) returns 500.
  Fix: `patches/@mastra__core@1.81.0.patch` (applied via `pnpm.patchedDependencies`) stringifies non-string previews. Verified: the endpoint returned 500 before the patch and 200 after it. Remove the patch when upgrading Mastra.
- `@mastra/deployer` depends on `@hono/node-ws`, which requires `@hono/node-server@^1.19`, so the simulators pin `@hono/node-server@1.19.18` to avoid two server copies.
