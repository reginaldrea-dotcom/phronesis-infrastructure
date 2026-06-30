-- capture_run_target — the run-scoped write-ownership signal for the capture path
-- (a90e1410 instance 3; Connie ruling 0b788de1, carrier blessed 6d3fab47).
--
-- The disambiguator that defeats every stored signal is INTENT — which synthesis a
-- capture run means to write into — and intent lives only with the Prime, from its
-- brief. Write-ownership is therefore run-scoped (the SAME synthesis is a write-target
-- during its own capture run and read-only provenance during another run), so no
-- durable owner/recency/conversation column can carry it. The carrier is a
-- model-DECLARED target, persisted against the PRIME SESSION (run == prime session):
-- the Prime declares the session it writes into (declare_capture_target, or auto on
-- enqueue_dispatch), and the capture write tools assert the write's target == the
-- declared target, rejecting + naming it on mismatch (the SC1 arc-clobber: declared
-- SC1, wrote the arc -> reject; the arc-read run declares the arc in ITS run -> allowed).
--
-- Persisted (not held in EF memory) so a wrong declaration is debuggable (Connie's ask).
-- One target per prime session; re-declaring overrides (upsert on the PK).

CREATE TABLE IF NOT EXISTS public.capture_run_target (
  prime_session_id    uuid PRIMARY KEY,                              -- the prime conversation session = the run
  theo_session_id     uuid NOT NULL REFERENCES public.theo_session(id) ON DELETE CASCADE,
  declared_by_lineage text,
  note                text,
  declared_at         timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capture_run_target_theo ON public.capture_run_target(theo_session_id);

-- RLS deny-all with zero policies, like the synthesis family: all writes go through the
-- service-role EF client; the browser (anon) is denied direct access by design.
ALTER TABLE public.capture_run_target ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.capture_run_target IS
  'Run-scoped capture write-ownership (a90e1410 inst 3). prime_session_id (the run) -> the theo_session that run is allowed to write into. Set by declare_capture_target or auto on enqueue_dispatch; enforced by write_synthesis_section / write_claims / commit_synthesis.';
