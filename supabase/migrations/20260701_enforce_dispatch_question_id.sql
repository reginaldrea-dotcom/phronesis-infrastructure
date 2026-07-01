-- enforce_dispatch_question_id — the Postgres-visible WALL behind the enqueue discipline
-- (conference 889f6014 C7; Reg-directed 1 Jul 2026, Connie's DDL lane, Aegis review).
--
-- Context: every Prime holds service-role Supabase MCP, so the EF-layer gates bind only the
-- cooperative harness path — a bare INSERT bypasses them. That produced 69/79 dispatches with NULL
-- question_id (capture provenance can't resolve) and the ungoverned-dispatch class generally. The EF
-- tool and enqueue_dispatch_rpc both STAMP question_id; this trigger makes the invariant unbypassable
-- at the layer the raw SQL writes to, so no undisciplined dispatch can ever reach the worker again.
--
-- Safe by construction: the theo-dispatch-worker only SELECT/UPDATEs engine_dispatch (never inserts),
-- and the two legitimate inserters (EF enqueue_dispatch, enqueue_dispatch_rpc) both stamp question_id.
-- Fires only on INSERT, so existing NULL rows and non-dispatch session states are untouched.
-- It enforces the DATA invariant (question_id present), not "must use the RPC" — a hand-rolled correct
-- insert still passes; only the sloppy bypass is rejected.

CREATE OR REPLACE FUNCTION public.enforce_dispatch_question_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.question_id IS NULL THEN
    RAISE EXCEPTION 'engine_dispatch.question_id is required — every dispatch must be question-addressable (MR e700ca48). Create dispatches via enqueue_dispatch (harness) or enqueue_dispatch_rpc (MCP), which stamp it; do not bare-INSERT. This is the substrate wall behind the enqueue discipline.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_dispatch_question_id ON public.engine_dispatch;
CREATE TRIGGER trg_enforce_dispatch_question_id
  BEFORE INSERT ON public.engine_dispatch
  FOR EACH ROW EXECUTE FUNCTION public.enforce_dispatch_question_id();

COMMENT ON FUNCTION public.enforce_dispatch_question_id() IS
  'C7 wall (Reg 1 Jul 2026): rejects an engine_dispatch INSERT without question_id, so a bare MCP write cannot create an undisciplined dispatch the worker would fire. Companion to enqueue_dispatch_rpc. Attribution enforcement (theo_session.created_by_lineage) deliberately NOT included here — flagged to Constantinople to assess against the intake/refinement session-creation flows.';
