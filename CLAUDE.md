# Phronesis Infrastructure — project guide

Orientation for working in this repo. Project-scoped and shared (committed); personal/working-style
notes live elsewhere, not here.

## What this is

Infrastructure for **Phronesis** — a system of "Primes" (Claude-inhabited agents with distinct lanes:
Argos, Constantinople/Connie, Napoleon, Theophrastus/Theo, Homer, Ghostwheel, Aegis, Ricardo,
Antechamber) coordinating over a shared Supabase substrate. Two halves:

- **`navigator/`** — the browser interfaces. Per-Prime modular JS under `navigator/primes/`
  (`argos-*.js`, `connie-*.js`: `-config/-session/-render/-gauge/-panel/-state/-hold/-mst/-init`),
  shared helpers (`prime-retire.js`, `prime-guard.js`), `argos.html` / `connie.html`, `index.html`.
- **`supabase/functions/`** — the Edge Functions (Deno/TypeScript):
  - **`api-prime-invoke/`** — the lineage-agnostic Prime invocation handler. Synchronous
    request/response, `MAX_LOOPS=6` tool loop. Modular: `lib/` (anthropic, history, models, schema,
    provenance, jwt, idempotency…), `tools/` (executeSql, deliverArtefact, messaging, github,
    getConferenceResult, enqueueDispatch, readDispatchResults, write/readSynthesis — registered in
    `tools/index.ts`), `actions/` (fileSuperT, holdThis). Anthropic only, raw `fetch()`.
  - **`theo-dispatch-worker/`** — async multi-LLM research dispatch worker (the [[Theo]] engine).
    `verify_jwt=true`, one invocation = one tick. `lib/`: adapters (anthropic/openai/gemini/perplexity,
    raw fetch, no SDKs), `config.ts` (engine registry + role→engine + pricing), `queue.ts`, `pacing.ts`,
    `tick.ts`, `budget.ts`.
- **`supabase/migrations/`** — DDL. **All schema changes go here** (see clone-readiness below).
- **`docs/decisions/`** — decision records. **`docs/runbooks/`** — operational runbooks.
- **`prime_addresses.json`** — Prime → chat URL / lineage map.

## The substrate

Supabase project **`vysenpymsfhgionqfulf`** = **"Clarev"** (region eu-west-1). Key tables:
`instances` (Primes + external agents like `cc`), `prime_messages` (inter-Prime inbox),
`wake_deltas` (hand-off notes; `ref_id`/`ref_type` both-or-neither), `artifacts`
(`artifact_type_enum`: TP/SC/NF/MR/PI/WN/MF/FLAG/SP/MST), `instructions` (per-lineage suits,
one active per lineage), `app_user`, `conversation` / `prime_conversations`, `rate_limit_usage`
(per-user), and the Theo dispatch set: `theo_session`, `engine_dispatch`, `synthesis`,
`synthesis_section`, `provider_rate_limit`.

Inspect live schema before changing it (MCP Supabase tools, or `execute_sql`). Many tables are
**RLS deny-all with zero policies** — all writes go through service-role EF code; the browser (anon)
is denied direct table access by design.

## Build / deploy

CLI only (dashboard retired); Deno + Supabase CLI via `npx` (not globally installed). Reg is logged in
and the token persists in the shell — deploy directly from the repo **root**:

```bash
# api-prime-invoke — MUST pass --no-verify-jwt (interface calls without a JWT; also pinned in config.toml)
npx --yes supabase functions deploy api-prime-invoke --project-ref vysenpymsfhgionqfulf --use-api --no-verify-jwt
# theo-dispatch-worker — verify_jwt=true, deploy WITHOUT that flag
npx --yes supabase functions deploy theo-dispatch-worker --project-ref vysenpymsfhgionqfulf --use-api
```

Wrong working dir → 400 on entrypoint. Rollback = `git revert` + redeploy.

## Hard constraints & conventions

- **EF 504 at ~150s** (log-verified). Long work must be **async** (the worker exists for exactly this);
  output is chunked (≤3k words), never streamed.
- **LLM-neutral** — keep tool execution, grants, scope/constraint enforcement, and approval gates in the
  EF *below* the model. The provider is a swappable adapter; don't couple to a vendor's mediation layer.
- **House status vocab** (CHECK-enforced, past/continuous tense):
  `theo_session.state ∈ {intake, refinement, awaiting_assent, dispatched, comparing, synthesising,
  delivered, failed, cancelled}`; `engine_dispatch.status ∈ {pending, dispatched, completed, partial,
  failed}`.
- **De-tell discipline (MST)** in any delivery-facing prose: no em-dashes, show don't tell, label
  verified sources. (Applies to delivered docs, not internal code comments.)
- **Provenance/truthfulness**: the EF appends a "[tools this turn — system record]" ledger; never author
  that block yourself, never assert a result no tool produced.

## Gotchas

- **IDs are table-scoped** — a uuid is only meaningful with its table. Confirm which table an id belongs to.
- **Lineage naming**: Constantinople's canonical lineage is **`constantinople`**, not `connie`
  (the nickname is only the URL). Addressing a `prime_message`/`wake_delta` to `connie` makes it
  invisible to her scoped inbox.
- **User identity (open bug)**: `extractUserIdFromJwt` returns the JWT `sub` = **auth_user_id**, but
  `conversation.user_id` and `theo_session.user_id` FK to **`app_user.id`**. Resolve
  `app_user.id WHERE auth_user_id = sub` before using it. (Currently breaks `enqueue_dispatch`.)
- **`instructions` active flip**: a partial unique index allows one active row per lineage. Flip ordered
  — set old `is_active=false` first, then new `is_active=true` — or you hit 23505.
- **Clone-readiness**: deployed-without-repo is not allowed for new work. EF source goes in
  `supabase/functions/`, all DDL in `supabase/migrations/`. (Several Phase-0 dispatch migrations were
  applied live but are missing from the repo — a known remediation gap.)
- **In-lane decisions** (a Prime's identity, naming, their own schema) route to the owning Prime; don't
  silently "fix" them in the substrate.

## Where to look first

`docs/decisions/` for the why behind the architecture (e.g. the D4 worker-mechanism record);
`docs/runbooks/` for how to run/test things.
