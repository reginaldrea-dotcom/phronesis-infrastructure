# Runbook — Theo dispatch test via the Supabase connector (projects framework)

**Audience:** Theo, running as a claude.ai Project (projects framework, not the API framework).
**What this exercises:** the `theo-dispatch-worker` EF + the four provider adapters + rate-limit pacing + the dispatch/synthesis substrate contracts — end to end.
**What this does NOT exercise:** the `enqueue_dispatch` / `read_dispatch_results` / `write_synthesis_section` / `read_synthesis` EF tools (those only run when Theo is invoked *through* `api-prime-invoke`), nor the live auth/onboarding path. You are hand-rolling, via the Supabase connector, exactly what those tools would have done.

## Why you can't see the dispatch tools

They are not MCP/connector tools. They live inside `api-prime-invoke`'s own server-side tool loop and are only handed to the Claude call that EF makes. `tool_search` only indexes connector tools, so it will never surface them. Nothing is misconfigured — the lever you have here is the **Supabase connector**. Use it.

## Verified identity facts (Clarev project `vysenpymsfhgionqfulf`)

- TestStranger `app_user.id` = `f7aa1663-3af4-4a81-9308-790ecca6960e` (`email_primary = reginaldrea@gmail.com`)
- TestStranger open `conversation.id` = `559fc822-d114-4bf0-aeac-52044cebb588`
- `theo_session.user_id` and `conversation.user_id` both FK to **`app_user.id`** (not the auth id). The SQL below resolves `app_user.id` itself, which is also why this path **sidesteps the `enqueue_dispatch` user-id bug**.
- Worker: `theo-dispatch-worker` v6, ACTIVE, `verify_jwt=true`. No cron yet → it must be fired manually.
- Theo lineage = `theophrastus` (where the completion wake_delta routes).

## Valid engines (`engine_dispatch.engine_name`)

`perplexity-sonar-deep-research`, `perplexity-sonar-pro`, `perplexity-sonar-reasoning-pro`, `gemini-deep-research`, `gemini-3-1-pro`, `gemini-2-5-pro`, `openai-o3-deep-research`, `openai-o4-mini-deep-research`, `openai-gpt-5-search`, `openai-gpt-4o-search`, `anthropic-claude-opus-4-8`, `anthropic-claude-sonnet-4-6`.
Valid roles: `deep_source`, `deep_research`, `current_web`, `synthesist`.

**For the first smoke test use the two Anthropic engines** — they are sync (one worker tick completes them) and their key is set. Optionally add `perplexity-sonar-pro` (sync, role `current_web`) for cross-provider divergence; that key is also set. **Avoid the deep-research SKUs for the first run** — they are async (first tick only marks them `dispatched`; you must fire the worker again after a few minutes to poll them to completion).

---

## Step 1 — Enqueue (you, via Supabase `execute_sql`)

Fill the five `<<...>>` placeholders. `$$...$$` dollar-quoting lets your prose contain apostrophes without escaping. One atomic statement: resolves the user + open conversation, inserts the `theo_session` (state=`dispatched`), inserts one `engine_dispatch` row per engine, and returns the new session id.

```sql
WITH appu AS (
  SELECT id AS app_user_id
  FROM app_user
  WHERE email_primary = 'reginaldrea@gmail.com'
),
conv AS (
  SELECT c.id AS conversation_id
  FROM conversation c
  JOIN appu ON c.user_id = appu.app_user_id
  WHERE c.status = 'open'
  ORDER BY c.last_active_at DESC
  LIMIT 1
),
sess AS (
  INSERT INTO theo_session
    (conversation_id, user_id, state, original_brief, refined_prompt,
     refined_prompt_user_confirmed_at, engine_selection_rationale)
  SELECT
    conv.conversation_id,
    appu.app_user_id,
    'dispatched',
    $$<<ORIGINAL_BRIEF>>$$,
    $$<<REFINED_PROMPT>>$$,
    now(),
    $$<<ENGINE_RATIONALE>>$$
  FROM conv, appu
  RETURNING id
),
ins AS (
  INSERT INTO engine_dispatch
    (theo_session_id, engine_name, role_in_dispatch, prompt_sent, status)
  SELECT sess.id, e.engine_name, e.role_in_dispatch, e.prompt_sent, 'pending'
  FROM sess
  CROSS JOIN (VALUES
    ('anthropic-claude-opus-4-8',   'synthesist', $$<<PROMPT_FOR_OPUS>>$$),
    ('anthropic-claude-sonnet-4-6', 'synthesist', $$<<PROMPT_FOR_SONNET>>$$)
  ) AS e(engine_name, role_in_dispatch, prompt_sent)
  RETURNING theo_session_id
)
SELECT theo_session_id, count(*) AS engines_queued
FROM ins GROUP BY theo_session_id;
```

**Record the returned `theo_session_id`** — every step below uses it.

Optional audit marker (mirrors what `enqueue_dispatch` files; not required for the test):

```sql
INSERT INTO wake_deltas (to_lineage, from_lineage, note, ref_type, ref_id)
VALUES ('theophrastus', 'theophrastus',
        'dispatch started (manual projects-framework test)',
        'theo_session', '<<SESSION_ID>>');
```

## Step 2 — Fire the worker (Reg, not Theo)

The worker is `verify_jwt=true` and there is no cron, so it needs a manual invoke with the service-role key (Theo cannot do this from the connector). Reg runs:

```bash
curl -X POST "https://vysenpymsfhgionqfulf.supabase.co/functions/v1/theo-dispatch-worker" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json"
```

The response is `{ ok: true, summary: { ... } }`. For the two sync Anthropic engines, a single tick submits and completes both. (Theo: wait for Reg to confirm the tick returned before reading results.)

## Step 3 — Read results (you, via Supabase `execute_sql`)

```sql
SELECT
  engine_name,
  role_in_dispatch,
  status,
  tokens_in, tokens_out, cost_usd,
  error_detail,
  jsonb_array_length(coalesce((response_raw::jsonb)->'sources', '[]'::jsonb)) AS source_count,
  left((response_raw::jsonb)->>'text', 800) AS excerpt,
  dispatched_at, response_received_at
FROM engine_dispatch
WHERE theo_session_id = '<<SESSION_ID>>'
ORDER BY engine_name;
```

Session state + the completion delta the worker filed (proves the notify path):

```sql
SELECT id, state, locked_by_instance_id, created_at
FROM theo_session WHERE id = '<<SESSION_ID>>';

SELECT note, ref_type, ref_id, created_at, consumed_at
FROM wake_deltas
WHERE ref_type = 'theo_session' AND ref_id = '<<SESSION_ID>>'
ORDER BY created_at;
```

**Interpreting state:** after a successful tick the session transitions `dispatched → comparing` (any engine succeeded) or `→ failed` (all failed). If it is still `dispatched` with `pending` rows, the worker has not run — stop and tell Reg; do not retry.

## Step 4 — Synthesis (optional, you, via Supabase `execute_sql`)

Find-or-create the `synthesis` row, then upsert section 0 (exec summary). Re-running with the same `section_index` revises that section.

```sql
WITH existing AS (
  SELECT id FROM synthesis WHERE theo_session_id = '<<SESSION_ID>>'::uuid LIMIT 1
),
created AS (
  INSERT INTO synthesis (theo_session_id)
  SELECT '<<SESSION_ID>>'::uuid
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id
),
sid AS (
  SELECT id FROM existing
  UNION ALL
  SELECT id FROM created
)
INSERT INTO synthesis_section (synthesis_id, section_index, title, content_md, needs_review)
SELECT (SELECT id FROM sid), 0, 'Executive Summary', $$<<SECTION_MD>>$$, false
ON CONFLICT (synthesis_id, section_index)
DO UPDATE SET title = EXCLUDED.title,
              content_md = EXCLUDED.content_md,
              needs_review = EXCLUDED.needs_review
RETURNING synthesis_id, section_index;
```

Knit (the ordered concatenation a reader would receive):

```sql
SELECT s.section_index, s.title, s.needs_review, s.join_note, s.content_md
FROM synthesis_section s
JOIN synthesis y ON y.id = s.synthesis_id
WHERE y.theo_session_id = '<<SESSION_ID>>'::uuid
ORDER BY s.section_index;
```

**Content discipline (MST de-tell, standing rule):** no em-dashes in delivery prose; show don't tell; label verified sources. Set `needs_review = true` and add a `join_note` at any join you want Ghostwheel to check.

## Cleanup (optional, after the test)

```sql
DELETE FROM engine_dispatch WHERE theo_session_id = '<<SESSION_ID>>';
DELETE FROM synthesis       WHERE theo_session_id = '<<SESSION_ID>>';  -- sections cascade
DELETE FROM wake_deltas     WHERE ref_type = 'theo_session' AND ref_id = '<<SESSION_ID>>';
DELETE FROM theo_session    WHERE id = '<<SESSION_ID>>';
```

## Notes

- Async engines: if you queue any deep-research SKU, the first tick only marks it `dispatched` + records a `provider_job_ref`. Fire the worker again after a few minutes to poll it; the staleness ceiling (30–45 min, per engine) fails it if it never returns.
- `response_raw` is `text` holding the worker's `AdapterResponse` JSON (`{ text, sources[], labels[], usage, raw }`). Cast with `::jsonb` to read fields.
- This whole path is intentionally outside the EF tools. When the `enqueue_dispatch` user-id fix lands and `api-prime-invoke` is redeployed, the same test can run through the API framework (real EF tools) instead of hand-rolled SQL.
