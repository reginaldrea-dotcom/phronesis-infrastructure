-- checkin_baton — the possibly-halted check-in write-action (Eames SP 76019f72 "ONE OPEN ITEM";
-- baton 38e5d802). The Navigator Possibly-halted route button calls this to resolve a silent stall:
--   'halted' → converts it into a properly filed halt (halted_at + halt_kind + halt_note + halt_needs)
--              and emits a check-in wake_delta to the holder.
--   'on_it'  → records the holder is still working (NO state change — picked_up_at is the true pickup
--              time and must not be falsified; just informs the holder).
-- SECURITY DEFINER + the existing baton-RPC pattern (mirrors dismiss_baton/restore_baton), so the anon
-- Navigator can convert a stall to a filed halt without manual SQL.
CREATE OR REPLACE FUNCTION public.checkin_baton(
  p_baton_id   uuid,
  p_outcome    text,
  p_halt_kind  text DEFAULT NULL,
  p_halt_note  text DEFAULT NULL,
  p_halt_needs text DEFAULT NULL,
  p_actor      text DEFAULT 'reg'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_track text; v_holder text; v_picked timestamptz; v_done timestamptz; v_halted timestamptz;
BEGIN
  SELECT track, holder, picked_up_at, done_at, halted_at
    INTO v_track, v_holder, v_picked, v_done, v_halted
    FROM relay_baton WHERE id = p_baton_id;
  IF v_track IS NULL THEN RAISE EXCEPTION 'baton % not found', p_baton_id; END IF;
  IF v_done IS NOT NULL THEN RAISE EXCEPTION 'baton % is done — nothing to check in', p_baton_id; END IF;
  IF v_halted IS NOT NULL THEN
    RETURN jsonb_build_object('id', p_baton_id, 'already_halted', true, 'halted_at', v_halted);
  END IF;
  IF v_picked IS NULL THEN RAISE EXCEPTION 'baton % was never picked up — it is unclaimed, not a silent stall', p_baton_id; END IF;

  IF p_outcome = 'halted' THEN
    IF p_halt_kind IS NULL OR p_halt_kind NOT IN ('blocked','needs_ruling','spawned','failed','gated','sibling_reported') THEN
      RAISE EXCEPTION 'halt_kind must be one of blocked/needs_ruling/spawned/failed/gated/sibling_reported (got %)', COALESCE(p_halt_kind,'null');
    END IF;
    IF p_halt_note IS NULL OR btrim(p_halt_note) = '' THEN
      RAISE EXCEPTION 'a halt_note is required when filing a halt (why it is stuck)';
    END IF;
    UPDATE relay_baton
      SET halted_at = now(), halt_kind = p_halt_kind, halt_note = p_halt_note, halt_needs = p_halt_needs
      WHERE id = p_baton_id;
    INSERT INTO wake_deltas (to_lineage, from_lineage, note, ref_type, ref_id)
    VALUES (v_holder, 'antechamber',
      'Check-in on your silent baton "' || left(v_track,80) || '": filed as HALTED (' || p_halt_kind || ') by ' || p_actor ||
      '. Note: ' || p_halt_note || COALESCE('. Needs: ' || p_halt_needs, '') ||
      '. If you are in fact still on it, clear the halt and continue.',
      'relay_baton', p_baton_id);
    INSERT INTO prime_messages (from_lineage, to_lineage, subject, body, attention_level)
    VALUES ('constantinople','antechamber',
      'Check-in filed halt: baton "' || left(v_track,80) || '"',
      'Possibly-halted baton ' || p_baton_id || ' (holder ' || v_holder || ') was converted to a filed halt (' || p_halt_kind ||
      ') via a Navigator check-in by ' || p_actor || '. It now sits in Halted-needs-routing.',
      'moderate');
    RETURN jsonb_build_object('id', p_baton_id, 'filed', true, 'halted_at', now(), 'halt_kind', p_halt_kind);

  ELSIF p_outcome = 'on_it' THEN
    INSERT INTO wake_deltas (to_lineage, from_lineage, note, ref_type, ref_id)
    VALUES (v_holder, 'antechamber',
      'Check-in on your quiet baton "' || left(v_track,80) || '": ' || p_actor ||
      ' confirms you are still on it — no halt filed, carry on.',
      'relay_baton', p_baton_id);
    RETURN jsonb_build_object('id', p_baton_id, 'on_it', true);

  ELSE
    RAISE EXCEPTION 'p_outcome must be ''halted'' or ''on_it'' (got %)', COALESCE(p_outcome,'null');
  END IF;
END $function$;

GRANT EXECUTE ON FUNCTION public.checkin_baton(uuid,text,text,text,text,text) TO anon, authenticated, service_role;
