# Decision Record — Phase-0 Recovery + D4 (Worker Mechanism)

**Author:** CC (Claude Code) — `instance_id 7b3ab2a4-852f-464d-b8e8-2ed9416dda75`
**Date:** 2 June 2026
**Type:** decision-record (filed as `WN` in the substrate — the `artifact_type` enum has no `DR` value yet)
**Plan of record:** MR `5944ef52` (Napoleon, Conference `1ee3b0fd`, ratified by Reg)
**Predecessor:** Connie TPs `b66584af` (Phase0Build, Seq 30) + `a9e730a3` (Phase0Close, Seq 31)
**Verification owner:** Constantinople (parallel pass — reads `82ea8347`, sanity-checks D4 reasoning and five contracts against live source)

---

## 1. Why this record exists

CC's previous instance was lost mid-build (session terminated; no TP filed). The previous CC had completed Phase-0 inspection work (D4 choice, reuse confirmation, clone-readiness audit) which never landed in the substrate. Only two fragments survived as inbox-resident messages: `82ea8347` (CC reconcile of status vocab + section model + rate-limit shape) and `f5e2fbb0` (CC RLS resolution addendum for synthesis_section).

This record durably captures the re-established findings so a future logout does not cost them again. It is the close of carry-over #1 from the recovery sequence.

## 2. D4 — worker mechanism decision

**Decision: fresh dedicated Edge Function `theo-dispatch-worker`** (no `api-` prefix; `verify_jwt=true`; cron-invoked with service-role key).

**Reasoning (from live source inspection):**

- `dynamic-processor` (EF id `ff867c3b-a52a-49e3-afa0-efa9e4801f34`, v12, `verify_jwt=true`) is a Supabase template scaffold — returns `Hello {name}!` / `Hello {name} admin!`. The slug is reserved; there is no logic to extend. (Source not in repo — see §6.)
- `api-prime-invoke` (EF id `a918660d-cd6b-4a74-8bf5-dea0d31ff23b`, v123) is the lineage-agnostic Prime invocation handler. ~78,681 chars across one entrypoint. Synchronous request-response only:
  - `Deno.serve(async (req) => { ... })` — no background tasks, no `EdgeRuntime.waitUntil`.
  - `MAX_LOOPS = 6` bounds the tool loop; all side effects complete before `finalize()` returns.
  - Touches `prime_conversations`, `wake_deltas` (read only), `prime_messages` (read only), `instructions`, `idempotency_keys`, `rate_limit_usage`, `artifacts`. Does NOT touch `engine_dispatch`, `synthesis`, `synthesis_section`, `provider_rate_limit`.
  - Single provider: Anthropic only, raw `fetch()` against `https://api.anthropic.com/v1/messages` (no SDK). Models per `MODEL_BY_LINEAGE` in `lib/models.ts`.
- Extending `api-prime-invoke` to host async queue-draining would entangle interactive request-response with background work and break the one-shot invocation model. A dedicated worker keeps the seam clean.

**Slug naming rationale:** `theo-dispatch-worker` — Theo is the methodology (a clone still runs Theo); the `api-` prefix is reserved for client/external-facing endpoints. The pre-existing prefix-less worker `dynamic-processor` is the precedent. Generalising to a shared `dispatch-worker` is YAGNI — rename if a second consumer ever appears.

## 3. Five contracts the worker builds to (live-verified)

All five verified against `pg_constraint` / `information_schema` / `pg_proc` at 2 June 2026 ~16:00 UTC.

### 3.1 `engine_dispatch.status` CHECK

```sql
CHECK (status = ANY (ARRAY['pending','dispatched','completed','partial','failed']))
```

Lifecycle: `pending → dispatched → (completed | partial | failed)`. `error_detail text` carries failure text. Default `'pending'`. House convention: past/continuous tense — `failed` not `error`, mirroring `theo_session.state`.

### 3.2 `claim_theo_session` lock function

```sql
claim_theo_session(p_session_id uuid, p_instance_id uuid) RETURNS boolean
```

Body is a compare-and-set:
```sql
UPDATE theo_session
   SET locked_by_instance_id = p_instance_id
 WHERE id = p_session_id AND locked_by_instance_id IS NULL;
RETURN FOUND;
```

Worker calls it before working a session; proceeds only on `true`. Lock release on terminal status: `UPDATE theo_session SET locked_by_instance_id = NULL WHERE id = p_session_id`.

`theo_session.locked_by_instance_id` has FK → `instances(id)`. Worker's `p_instance_id` must be a real instances row.

### 3.3 `wake_deltas` ref pairing

Columns: `to_lineage text NOT NULL`, `from_lineage text NOT NULL`, `note text NOT NULL`, `ref_id uuid NULL`, `ref_type text NULL`, `consumed_at timestamptz NULL`.

CHECK enforces both-or-neither:
```sql
CHECK ((ref_id IS NULL) = (ref_type IS NULL))
```

Worker writes start-of-job and completion deltas with `ref_type='theo_session'`, `ref_id=session_id`. Note text is human-readable summary; routing is by `to_lineage`.

### 3.4 `synthesis_section`

```sql
CREATE TABLE synthesis_section (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  synthesis_id uuid NOT NULL REFERENCES synthesis(id) ON DELETE CASCADE,
  section_index int  NOT NULL,
  title        text,
  content_md   text,
  needs_review boolean NOT NULL DEFAULT false,
  join_note    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (synthesis_id, section_index)
);
ALTER TABLE synthesis_section ENABLE ROW LEVEL SECURITY;  -- 0 policies (deny-all)
```

One row per `section_index` IS the section; revision = `UPDATE` the row. `needs_review` + `join_note` serve Ghostwheel's editorial gate. RLS is sealed deny-all; the worker writes via service-role key (RLS-bypassing). End-user read policy DEFERRED to item-7 — do not improvise ahead.

Knit consumer: `SELECT content_md FROM synthesis_section WHERE synthesis_id = $1 ORDER BY section_index`.

### 3.5 `provider_rate_limit`

```sql
CREATE TABLE provider_rate_limit (
  provider      text NOT NULL,
  model         text NOT NULL,
  bucket        timestamptz NOT NULL,
  request_count int  NOT NULL DEFAULT 0,
  input_tokens  int  NOT NULL DEFAULT 0,
  output_tokens int  NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, model, bucket)
);
```

Keying convention (worker, not schema): `bucket = date_trunc('minute', now())`.
- RPM = current minute bucket's `request_count`
- RPD = `SUM(request_count) WHERE bucket >= date_trunc('day', now())`
- TPM = `SUM(input_tokens + output_tokens)` over current minute

`rate_limit_usage` is left untouched — keyed `(user_id, service, bucket)`, serves per-user Clarev throttling, NOT provider-global pacing. `provider_rate_limit` is the worker's table.

## 4. Surviving CC fragments (recovery evidence)

Only two pieces of the prior CC session survive in-substrate, both as `prime_messages` with `from_lineage='cc'` and `from_instance_id=NULL` (CC had no instances row until this session):

- **`82ea8347-b05d-4eef-8b5c-bc6dc6aa8514`** (CC → Connie, 14:25 UTC) — Phase-0 reconcile. Confirms `synthesis_section` shape with the +2 columns (needs_review, join_note), confirms `provider_rate_limit` shape as-is, and CORRECTS the `engine_dispatch.status` set from CC's earlier `complete/error` relay to the house convention `pending/dispatched/completed/partial/failed`, citing live `theo_session.state` vocabulary.
- **`f5e2fbb0-a483-4978-bb92-abd9ed2770d4`** (CC → Connie, 14:42 UTC) — addendum closing item-4 (synthesis_section). Records Reg's decision: deny-all RLS now, proper RLS deferred; rationale = service-role-only access pattern, same posture as `jti_redemptions`.

These fragments establish that CC's prior judgement aligned with what this session would land at independently — re-inspection is safe; no risk of contradicting the prior self on the things that did survive.

What did NOT survive: D4 worker-mechanism choice + reasoning, reuse confirmation, clone-readiness audit. All re-derived this session from live source — see §2 for D4 and §6 for clone-readiness gaps.

## 5. Architecture (firm)

```
Theo (in api-prime-invoke EF, interactive turn ≤150s)
  └─ enqueue_dispatch tool → writes theo_session + engine_dispatch rows
                            + INSERT wake_delta (ref_type='theo_session',
                              ref_id=session_id, note='dispatch started')
  └─ [end_turn]
                                                ↓
                            pg_cron (every ~30s) → net.http_post → worker EF
                                  service-role key from Vault/config
                                                ↓
theo-dispatch-worker (NEW EF, verify_jwt=true, no 150s constraint for its outbound work)
  ├─ FIND pending theo_session rows (state='dispatched', locked_by_instance_id IS NULL)
  ├─ FOR EACH: claim_theo_session(id, my_instance_id) → bool; proceed only if true
  │   ├─ FOR EACH engine_dispatch (status='pending') under this session:
  │   │    ├─ check provider_rate_limit (RPM/TPM/RPD for (provider, model, bucket))
  │   │    ├─ wait/skip if paced
  │   │    ├─ adapter.run(provider, model, prompt) → fetch()
  │   │    ├─ UPSERT provider_rate_limit usage (minute bucket)
  │   │    └─ UPDATE engine_dispatch (status=completed|partial|failed,
  │   │       response_raw, response_received_at, cost_usd, tokens_in/out, error_detail)
  │   ├─ release lock: UPDATE theo_session SET locked_by_instance_id = NULL
  │   └─ INSERT wake_delta (to=theo lineage, ref_type='theo_session',
  │      ref_id=session_id, note='dispatch complete: N results')
  └─ exit (next tick handles further work)
                                                ↓
Theo (wakes on completion delta in next invocation)
  └─ read_dispatch_results tool → reads engine_dispatch with quality signals
  └─ proceeds to comparison/synthesis (writes synthesis + synthesis_section)
```

Notes:
- Two-step compose-then-enqueue: Theo composes the refinement (questions × engine assignments + research intent) into `theo_session.engine_selection_rationale`, then `enqueue_dispatch` writes the session + child `engine_dispatch` rows in a single tool call.
- Notify-first / manual-resume: completion delta is filed; Theo wakes on next interactive invocation. Auto-wake is Phase 3 (gated triply: item-7 + Knocker-Upper + Homer clean-resume record), not built here.
- Adapter contract: `run(question, role, opts) → { text, sources[], labels }`. One adapter per provider (Perplexity, Gemini, OpenAI, Anthropic) — all use raw `fetch()` (no SDKs), matching `api-prime-invoke`'s precedent. Role → model mapping lives in `lib/config.ts` — zero hardcoded model strings in worker logic.
- Failure handling: per-engine `failed` is fine; the session as a whole completes `partial` if at least one engine succeeded, `failed` if none did. `error_detail` populated with provider response.

## 6. Clone-readiness gaps found

The substrate is live-correct but NOT clone-buildable from the repo. Three gaps identified this session:

1. **`dynamic-processor` source absent from repo.** EF deployed; no source in `supabase/functions/`. Pre-existing. Owner: TBD. Not in Phase-1 scope.
2. **Seven Phase-0 migrations applied live but absent from `supabase/migrations/`:**
   - `wake_deltas_ref`
   - `theo_session_lock_claim`
   - `engine_dispatch_status_check` (initial, superseded)
   - `engine_dispatch_status_check_align_theo_vocab` (corrected)
   - `create_synthesis_section`
   - `enable_rls_synthesis_section`
   - `create_provider_rate_limit`

   Same clone-readiness gap as dynamic-processor, larger blast radius — a clone built from the current repo would lack the entire dispatch substrate the worker depends on. Remediation owner: Connie (her lane).
3. **`cc` instances row added this session as raw INSERT** (under Reg sign-off), not as a migration. Correct per Reg's framing — "CC the builder isn't something a client-clone needs" — so it does NOT go in `migrations/`. Recorded here for traceability.

The worker build must not replicate gap (1) or (2): source goes into `supabase/functions/theo-dispatch-worker/` and any DDL goes into a numbered migration in `supabase/migrations/`. Deployed-without-repo is not permitted for Phase-1 outputs.

## 7. Phase-1 build sequence (immediate)

1. Adapter contract + role → model config (`lib/adapters/*.ts`, `lib/config.ts`).
2. Paced worker (`index.ts` + `lib/queue.ts` + `lib/pacing.ts`).
3. `enqueue_dispatch` and `read_dispatch_results` tools — added to `api-prime-invoke/tools/index.ts` `TOOLS` array.
4. Wake-delta inserts (start + complete) honouring ref_id/ref_type pairing.
5. Knit consumer (separate; lives where the synthesis turn lives — likely in `api-prime-invoke`).
6. pg_cron + pg_net enablement (Connie's lane, under Reg sign-off) — the only Phase-1 step that gates on substrate prerequisites.

Carry-over to settle with Connie via Napoleon: whether `provider_rate_limit` keying needs any addition (e.g. tenant scoping in future). Current shape `(provider, model, bucket)` is correct for global provider pacing; Gemini Deep Research 1 RPM is global across tenants.

## 8. What this record does NOT yet contain

- **Clone-readiness audit addendum**: a fuller pass on the whole repo vs whole substrate (beyond the three gaps above) is owed once the worker is sketched. Will land as an amendment to this record or a sibling DR.
- **The worker source itself.** Coming next.

## 9. Routing

- Technical/coordination decisions: Napoleon (via `prime_messages`).
- DDL sign-off: Reg.
- Verification of this record: Constantinople (parallel pass — reads `82ea8347` + `f5e2fbb0` + live catalog cross-check + flags any drift from this record).

If verification finds drift, this record gets amended (not silently corrected). The live substrate is the operative contract; this record is the human-readable index.
