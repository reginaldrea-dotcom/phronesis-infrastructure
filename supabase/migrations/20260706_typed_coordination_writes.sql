-- Typed coordination-write RPCs (baton d8f945ea, passed by Napoleon; Connie's DDL lane, coordinated).
-- Finishes the typed create-side that file_super_t / file_canonical_artifact started and retires the last
-- raw-SQL coordinator fumbling: OPENING a baton and FILING a wake_delta were still hand-written INSERTs
-- (Napoleon bounced off relay_baton's attention CHECK on a hand-written baton — exactly what pass_baton
-- validates cleanly). Pattern mirrors file_super_t (SECURITY DEFINER, search_path pinned, validate-then-raise,
-- return the created row) and enqueue_dispatch_rpc.

-- (1) pass_baton — open a baton. Validates attention in-function (clear error, not a raw constraint bounce)
-- and returns the created row. p_passed_by is an additive optional (records who passed; not in the original
-- 7-arg spec, defaulted so a 7-arg call is unaffected).
CREATE OR REPLACE FUNCTION public.pass_baton(
  p_track             text,
  p_holder            text,
  p_invoke_with       text DEFAULT NULL,
  p_reason            text DEFAULT NULL,
  p_attention         text DEFAULT 'moderate',
  p_stale_after_hours integer DEFAULT NULL,
  p_ref_ids           uuid[] DEFAULT NULL,
  p_passed_by         text DEFAULT NULL
) RETURNS public.relay_baton
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attention text := COALESCE(NULLIF(btrim(p_attention), ''), 'moderate');
  v_row public.relay_baton;
BEGIN
  IF p_track IS NULL OR btrim(p_track) = '' THEN
    RAISE EXCEPTION 'pass_baton: p_track is required (the deliverable/track name)';
  END IF;
  IF p_holder IS NULL OR btrim(p_holder) = '' THEN
    RAISE EXCEPTION 'pass_baton: p_holder is required (the lineage the baton is passed to)';
  END IF;
  IF v_attention NOT IN ('urgent', 'moderate', 'low') THEN
    RAISE EXCEPTION 'pass_baton: attention must be one of urgent / moderate / low (got %)', p_attention;
  END IF;

  INSERT INTO public.relay_baton
    (track, holder, passed_by, invoke_with, reason, attention, stale_after_hours, ref_ids, passed_at)
  VALUES
    (btrim(p_track), p_holder, p_passed_by, p_invoke_with, p_reason, v_attention, p_stale_after_hours, p_ref_ids, now())
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.pass_baton(text, text, text, text, text, integer, uuid[], text) TO service_role, authenticated;

-- (2) file_delta — file a wake_delta hand-off note. Returns the created row. ref_id/ref_type left null
-- (satisfies the both-or-neither pairing constraint); a ref-carrying variant can be added if needed.
CREATE OR REPLACE FUNCTION public.file_delta(
  p_from_lineage text,
  p_to_lineage   text,
  p_note         text
) RETURNS public.wake_deltas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.wake_deltas;
BEGIN
  IF p_from_lineage IS NULL OR btrim(p_from_lineage) = '' THEN
    RAISE EXCEPTION 'file_delta: p_from_lineage is required';
  END IF;
  IF p_to_lineage IS NULL OR btrim(p_to_lineage) = '' THEN
    RAISE EXCEPTION 'file_delta: p_to_lineage is required';
  END IF;
  IF p_note IS NULL OR btrim(p_note) = '' THEN
    RAISE EXCEPTION 'file_delta: p_note is required (wake_deltas.note is NOT NULL)';
  END IF;

  INSERT INTO public.wake_deltas (from_lineage, to_lineage, note)
  VALUES (p_from_lineage, p_to_lineage, btrim(p_note))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.file_delta(text, text, text) TO service_role, authenticated;
