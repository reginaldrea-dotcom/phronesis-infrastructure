-- enqueue_dispatch_rpc — the enqueue discipline as a callable Postgres function, so a Prime with
-- Supabase MCP (raw SQL) can fire a multi-LLM dispatch WITH the same discipline as the api-prime-invoke
-- harness tool, instead of a bare INSERT that bypasses it. Sanctioned for Theo (Reg, 1 Jul 2026): he
-- composes AND fires, disciplined, without waiting on Stage-2 or routing through Angelia.
--
-- Applies exactly what the EF enqueue_dispatch applies:
--   - autonomous-lineage gate (Aegis e5cd623f: angelia, theophrastus)
--   - created_by_lineage attribution (the column raw INSERTs leave NULL)
--   - one research_question per question_index, status='open'
--   - engine_dispatch rows STAMPED with question_id (MR e700ca48: the precise provenance key)
--   - engine/role validation
--   - start-of-job wake_delta
-- SECURITY DEFINER so the discipline is the function's, not the caller's. The companion enforcement
-- trigger (Connie/Aegis, C7) is what makes a bare INSERT that skips this reject at the DB layer; this
-- RPC is the easy correct path, the trigger is the wall. (Follow-up: refactor the EF enqueue_dispatch
-- to call this same function so there is a single implementation and no drift.)

CREATE OR REPLACE FUNCTION public.enqueue_dispatch_rpc(
  p_lineage                     text,
  p_original_brief              text,
  p_refined_prompt              text,
  p_engine_selection_rationale  text,
  p_questions                   jsonb,   -- [{prompt, engine_name, role, question_index?, question_text?, role_description?}]
  p_anonymisation_mode          text DEFAULT NULL,
  p_entity_verification_note    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_valid_engines text[] := ARRAY['perplexity-sonar-deep-research','perplexity-sonar-pro','perplexity-sonar-reasoning-pro','gemini-deep-research','gemini-3-1-pro','gemini-2-5-pro','openai-o3-deep-research','openai-gpt-5-search','openai-gpt-4o-search','anthropic-claude-opus-4-8','anthropic-claude-sonnet-4-6'];
  v_valid_roles       text[] := ARRAY['deep_source','deep_research','current_web','synthesist'];
  v_approved_lineages text[] := ARRAY['angelia','theophrastus'];
  v_user    uuid;
  v_conv    uuid;
  v_session uuid;
  v_bad     text;
  v_result  jsonb;
BEGIN
  -- Scalars
  IF p_lineage IS NULL OR btrim(p_lineage) = '' THEN RAISE EXCEPTION 'p_lineage is required'; END IF;
  IF NOT (p_lineage = ANY(v_approved_lineages)) THEN
    RAISE EXCEPTION 'lineage % is not approved for autonomous dispatch (approved: angelia, theophrastus — Aegis e5cd623f)', p_lineage;
  END IF;
  IF COALESCE(btrim(p_original_brief),'') = '' THEN RAISE EXCEPTION 'p_original_brief is required'; END IF;
  IF COALESCE(btrim(p_refined_prompt),'') = '' THEN RAISE EXCEPTION 'p_refined_prompt is required'; END IF;
  IF COALESCE(btrim(p_engine_selection_rationale),'') = '' THEN RAISE EXCEPTION 'p_engine_selection_rationale is required'; END IF;
  IF p_questions IS NULL OR jsonb_typeof(p_questions) <> 'array' OR jsonb_array_length(p_questions) = 0 THEN
    RAISE EXCEPTION 'p_questions must be a non-empty JSON array of {prompt, engine_name, role, [question_index], [question_text], [role_description]}';
  END IF;

  -- Per-question validation
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_questions) e WHERE COALESCE(btrim(e->>'prompt'),'') = '') THEN
    RAISE EXCEPTION 'every question needs a non-empty prompt';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_questions) e WHERE COALESCE(e->>'engine_name','') = '') THEN
    RAISE EXCEPTION 'every question needs an engine_name';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_questions) e WHERE COALESCE(e->>'role','') = '') THEN
    RAISE EXCEPTION 'every question needs a role';
  END IF;
  SELECT string_agg(DISTINCT e->>'engine_name', ', ') INTO v_bad
    FROM jsonb_array_elements(p_questions) e
    WHERE NOT (e->>'engine_name' = ANY(v_valid_engines));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'invalid engine_name(s): %', v_bad; END IF;
  SELECT string_agg(DISTINCT e->>'role', ', ') INTO v_bad
    FROM jsonb_array_elements(p_questions) e
    WHERE NOT (e->>'role' = ANY(v_valid_roles));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'invalid role(s): %', v_bad; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_questions) e WHERE (e ? 'question_index') AND jsonb_typeof(e->'question_index') <> 'number') THEN
    RAISE EXCEPTION 'question_index must be an integer when provided';
  END IF;

  -- Owning autonomous-research identity + its open conversation
  SELECT id INTO v_user FROM app_user WHERE role_context = 'autonomous_research' LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'no autonomous_research app_user provisioned'; END IF;
  SELECT id INTO v_conv FROM conversation WHERE user_id = v_user AND status = 'open'
    ORDER BY last_active_at DESC NULLS LAST LIMIT 1;
  IF v_conv IS NULL THEN RAISE EXCEPTION 'no open conversation for the autonomous_research identity'; END IF;

  -- Session (ATTRIBUTED)
  INSERT INTO theo_session (conversation_id, user_id, created_by_lineage, state, original_brief,
                            refined_prompt, refined_prompt_user_confirmed_at, engine_selection_rationale,
                            anonymisation_mode, entity_verification_note)
  VALUES (v_conv, v_user, p_lineage, 'dispatched', btrim(p_original_brief),
          btrim(p_refined_prompt), now(), btrim(p_engine_selection_rationale),
          p_anonymisation_mode, p_entity_verification_note)
  RETURNING id INTO v_session;

  -- research_question rows (status='open'), one per distinct question_index; text defaults to refined
  INSERT INTO research_question (theo_session_id, question_index, question_text, status)
  SELECT v_session, qi, COALESCE(qtext, btrim(p_refined_prompt)), 'open'
  FROM (
    SELECT COALESCE((e->>'question_index')::int, 0) AS qi,
           max(NULLIF(btrim(e->>'question_text'),'')) AS qtext
    FROM jsonb_array_elements(p_questions) e
    GROUP BY COALESCE((e->>'question_index')::int, 0)
  ) q;

  -- engine_dispatch rows, each STAMPED with its question's id
  INSERT INTO engine_dispatch (theo_session_id, engine_name, role_in_dispatch, role_description, prompt_sent, status, question_id)
  SELECT v_session, e->>'engine_name', e->>'role', NULLIF(btrim(e->>'role_description'),''), btrim(e->>'prompt'), 'pending', rq.id
  FROM jsonb_array_elements(p_questions) e
  JOIN research_question rq ON rq.theo_session_id = v_session
                           AND rq.question_index = COALESCE((e->>'question_index')::int, 0);

  -- Start-of-job wake_delta to the composing lineage
  INSERT INTO wake_deltas (to_lineage, from_lineage, note, ref_type, ref_id)
  VALUES (p_lineage, p_lineage, 'dispatch started (rpc): session ' || v_session::text, 'theo_session', v_session);

  SELECT jsonb_build_object(
    'theo_session_id',   v_session,
    'conversation_id',   v_conv,
    'created_by_lineage', p_lineage,
    'state',             'dispatched',
    'research_questions', (SELECT jsonb_agg(jsonb_build_object('question_index', question_index, 'id', id) ORDER BY question_index)
                             FROM research_question WHERE theo_session_id = v_session),
    'engine_dispatch',   (SELECT jsonb_agg(jsonb_build_object('id', id, 'engine_name', engine_name, 'role', role_in_dispatch, 'question_id', question_id))
                             FROM engine_dispatch WHERE theo_session_id = v_session),
    'queued',            (SELECT count(*) FROM engine_dispatch WHERE theo_session_id = v_session),
    'note',              'enqueued via enqueue_dispatch_rpc — SAME discipline as the harness tool (attribution, research_question open + question_id stamping, validation). Worker fires on its next tick. Capture by dispatch_id or (engine_name, question_id).'
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.enqueue_dispatch_rpc(text,text,text,text,jsonb,text,text) IS
  'Disciplined multi-LLM dispatch callable via MCP (Theo raw-SQL path, Reg 1 Jul 2026). Same discipline as the EF enqueue_dispatch: autonomous-lineage gate, created_by_lineage, research_question(open)+question_id stamping, validation. The companion enforcement trigger is the wall against bare INSERTs.';

GRANT EXECUTE ON FUNCTION public.enqueue_dispatch_rpc(text,text,text,text,jsonb,text,text) TO service_role, authenticated;
