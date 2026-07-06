-- freeze_dossier_slice — the freeze-endpoint CORE for the qualitative dossier (baton supersedes 4d6e94c7;
-- MR acd6310c freeze contract, applied to Connie's dossier_slice). Snapshots the COMPLETE self-contained
-- render payload for a slice, computes snapshot_hash over it, and sets frozen_at — all three together, so a
-- frozen slice satisfies the dossier_slice_frozen_is_self_contained CHECK and renders from the one row with
-- no live join (self-containment / cold-recovery). Snapshots are immutable: re-freezing is refused.
--
-- SCOPE NOTE: MR acd6310c specifies the freeze over report_snapshot (quantitative AESSEAL: audience_tier,
-- client_layers, figures, grounding column). dossier_slice is the qualitative counterpart and carries only
-- the CORE contract. This function is that core for dossier_slice. The MR's DEPENDENT parts (tier-scoped
-- two-URL render, materiality pre-check, change-diff) assume report_snapshot's tier/figure structure that
-- dossier_slice does not have — held pending Connie's confirm that dossier_slice is the intended target.
--
-- PAYLOAD SHAPE (Connie fed43ca1: top-level "version" key required, inner keys evolvable, no DDL round-trip):
--   { version, slice, integrity, facts:[...], grounding:{source_document_id: content_hash} }
-- v1 covers the ground-fact / integrity / evidence layer (the read views). Section/prose content assembly
-- is added when the dossier render spec (Eames) lands — a payload inner-key evolution, not a schema change.

CREATE OR REPLACE FUNCTION public.freeze_dossier_slice(p_slice_id uuid)
RETURNS public.dossier_slice
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_slice      public.dossier_slice;
  v_slice_state text;
  v_facts      jsonb;
  v_grounding  jsonb;
  v_payload    jsonb;
  v_hash       text;
  v_row        public.dossier_slice;
BEGIN
  SELECT * INTO v_slice FROM dossier_slice WHERE id = p_slice_id;
  IF v_slice.id IS NULL THEN
    RAISE EXCEPTION 'freeze_dossier_slice: no dossier_slice with id %', p_slice_id;
  END IF;
  IF v_slice.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION 'freeze_dossier_slice: slice % is already frozen at % — snapshots are immutable; recompute into a new slice',
      p_slice_id, v_slice.frozen_at;
  END IF;

  -- the slice's own integrity state (sparse_record / needs_corroboration / tier_conflict / ok)
  SELECT integrity_state INTO v_slice_state
  FROM render_element_integrity_v1
  WHERE element_type = 'dossier_slice' AND element_id = p_slice_id;

  -- supporting facts: content + tier/contestability/freshness + evidence anchor + per-fact integrity
  SELECT jsonb_agg(jsonb_build_object(
           'ground_fact_id',     gf.ground_fact_id,
           'title',              gf.title,
           'content',            gf.content,
           'authority_tier',     gf.authority_tier,
           'contestability',     gf.contestability,
           'freshness_status',   gf.freshness_status,
           'source_url',         gf.source_url,
           'content_hash',       gf.content_hash,
           'source_document_id', gf.source_document_id,
           'in_conflict',        gf.in_conflict,
           'integrity_state',    fi.integrity_state
         ) ORDER BY gf.title)
    INTO v_facts
    FROM render_dossier_slice_fact_v1 sf
    JOIN render_ground_fact_v1 gf ON gf.ground_fact_id = sf.ground_fact_id
    LEFT JOIN render_element_integrity_v1 fi
           ON fi.element_type = 'ground_fact' AND fi.element_id = gf.ground_fact_id
   WHERE sf.dossier_slice_id = p_slice_id;

  -- grounding map for cold-recovery: source_document_id -> content_hash (mirrors report_snapshot.grounding)
  SELECT jsonb_object_agg(gf.source_document_id::text, gf.content_hash)
    INTO v_grounding
    FROM render_dossier_slice_fact_v1 sf
    JOIN render_ground_fact_v1 gf ON gf.ground_fact_id = sf.ground_fact_id
   WHERE sf.dossier_slice_id = p_slice_id AND gf.source_document_id IS NOT NULL;

  v_payload := jsonb_build_object(
    'version', 1,
    'slice', jsonb_build_object(
      'id', v_slice.id, 'theo_session_id', v_slice.theo_session_id,
      'slice_kind', v_slice.slice_kind, 'label', v_slice.label, 'owner_lineage', v_slice.owner_lineage),
    'integrity', jsonb_build_object('slice_state', COALESCE(v_slice_state, 'sparse_record')),
    'facts', COALESCE(v_facts, '[]'::jsonb),
    'grounding', COALESCE(v_grounding, '{}'::jsonb),
    'payload_note', 'v1: self-contained ground-fact / integrity / evidence layer. Section/prose content assembly pending the dossier render spec; inner keys evolvable (Connie fed43ca1).'
  );

  -- snapshot_hash = digest over the frozen payload (md5: built-in, no pgcrypto). Verify later by
  -- re-hashing the stored render_payload and comparing. Content digest (frozen_at lives in the column).
  v_hash := md5(v_payload::text);

  UPDATE dossier_slice
     SET render_payload = v_payload, snapshot_hash = v_hash, frozen_at = now()
   WHERE id = p_slice_id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.freeze_dossier_slice(uuid) TO service_role, authenticated;
