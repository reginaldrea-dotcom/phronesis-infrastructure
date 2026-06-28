-- dispatch_deliverable — Navigator "Copy next step" / "Open [holder]" stamps picked_up_at on the
-- deliverable's FRONT baton, so dispatch (the moment work leaves Reg's hands) reliably marks the card
-- IN_PROGRESS. Eames SP f729d071 §v2.9 / baton b7951c58. Reuses picked_up_at -> flows through the
-- existing deliverable_board derivation (front next_state UNCLAIMED -> ACTIVE -> status IN_PROGRESS):
-- NO view change. Fixes one-item deliverables, which have no done_count partial to lean on and so depend
-- entirely on picked_up_at. Mirrors clear_deliverable (SECURITY DEFINER, jsonb, idempotent). Routine
-- dispatch, so no AC notification; the picked_up_at stamp is itself the audit trail, and dispatch-without-
-- delivery is caught by the possibly-halted check-in (baton 38e5d802).
CREATE OR REPLACE FUNCTION public.dispatch_deliverable(p_deliverable_id uuid, p_actor text DEFAULT 'reg')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_name text; v_baton uuid; v_state text; v_holder text; v_track text; v_picked timestamptz;
BEGIN
  SELECT name INTO v_name FROM deliverable WHERE id = p_deliverable_id;
  IF v_name IS NULL THEN RAISE EXCEPTION 'deliverable % not found', p_deliverable_id; END IF;
  -- Front baton via the board derivation (first non-DONE step) — no recompute here.
  SELECT next_baton_id, next_state, next_holder, next_track
    INTO v_baton, v_state, v_holder, v_track
    FROM deliverable_board WHERE deliverable_id = p_deliverable_id;
  IF v_baton IS NULL THEN
    RETURN jsonb_build_object('id', p_deliverable_id, 'no_front_baton', true);  -- nothing actionable (e.g. all done)
  END IF;
  SELECT picked_up_at INTO v_picked FROM relay_baton WHERE id = v_baton;
  IF v_picked IS NOT NULL THEN
    RETURN jsonb_build_object('id', p_deliverable_id, 'baton_id', v_baton, 'already_in_flight', true, 'picked_up_at', v_picked);
  END IF;
  -- Only an UNCLAIMED front baton is dispatchable. A HALTED/PENDING_FOLD front (picked_up_at still null)
  -- must NOT be silently flipped to in-flight — leave it for routing.
  IF v_state IS DISTINCT FROM 'UNCLAIMED' THEN
    RETURN jsonb_build_object('id', p_deliverable_id, 'baton_id', v_baton, 'front_state', v_state, 'no_dispatch', true);
  END IF;
  UPDATE relay_baton SET picked_up_at = now() WHERE id = v_baton AND picked_up_at IS NULL;
  RETURN jsonb_build_object('id', p_deliverable_id, 'baton_id', v_baton, 'dispatched', true, 'picked_up_at', now(), 'holder', v_holder, 'track', v_track);
END $function$;

GRANT EXECUTE ON FUNCTION public.dispatch_deliverable(uuid,text) TO anon, authenticated, service_role;
