# LeadRescue AI

Self-healing lead operations: ingests ad-platform leads, delivers them into a CRM exactly once,
recovers from failures automatically, reconciles lost webhooks, and explains incidents with an LLM.

## Quick start (Docker)

```bash
docker compose up --build
```

That's all. The first build takes a few minutes; later starts take seconds.

| What | Where |
|------|-------|
| Mastra Studio (workflows, traces, agent, schedules) | http://localhost:4111 |
| Health | http://localhost:4111/health/ready |
| Simulators (fake Meta Lead Ads + CRM) | http://localhost:4200 |

The stack starts in order: `init` generates secrets once into a volume, `simulators` starts, `seed`
provisions two demo tenants, then `app` runs the production Mastra build (API, Studio, durable job
worker and the reconciliation schedule). Data persists in Docker volumes across restarts.

**Optional `.env`:** to enable AI incident analysis, create `.env` with an Ollama Cloud key
(https://ollama.com/settings/keys):

```bash
OLLAMA_API_KEY=your-key
```

Without a key, everything else works and incidents get deterministic assessments instead.
To use a local Ollama daemon instead: `LLM_PROVIDER=ollama-local` and
`OLLAMA_BASE_URL=http://host.docker.internal:11434`.

**Send a lead** (uses the simulator admin token from `.env`, or read it from the container:
`docker compose exec app sh -c 'grep SIMULATOR_ADMIN_TOKEN /config/secrets.env'`):

```bash
T=<SIMULATOR_ADMIN_TOKEN>
curl -X POST localhost:4200/sim-admin/meta/pages/104729384710001/leads \
  -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"fields":{"full_name":"Test Lead","email":"test@example.com","phone_number":"5125550100"}}'
```

**Reset everything:** `docker compose down -v` (removes the data and secrets volumes).

## Local development (without Docker)

```bash
pnpm install && pnpm setup:env
pnpm sim          # terminal 1: simulators on :4200
pnpm seed         # once
pnpm dev:mastra   # terminal 2: Mastra dev server + Studio on :4111
```

## Tests

```bash
pnpm test         # full suite, no LLM or servers needed
pnpm verify       # typecheck + lint + tests
pnpm ollama:smoke # one live LLM call (needs OLLAMA_API_KEY)
pnpm eval:ai      # live Incident Analyst evaluation across failure scenarios

# Or without Node on the host, inside the image:
docker compose run --rm --no-deps app node_modules/.bin/vitest run
```

Implementation status and verification evidence: [docs/PROGRESS.md](docs/PROGRESS.md).
