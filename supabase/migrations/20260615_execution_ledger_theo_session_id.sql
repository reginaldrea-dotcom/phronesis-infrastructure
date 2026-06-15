-- execution_ledger.theo_session_id — dispatch-provenance audit keying (FLAG 42c13e4c follow-on).
--
-- The ledger was keyed only on the agent's loop session_id (the chat session), so any audit keyed
-- on a theo_session returned a FALSE EMPTY: e0e30218 read as "fictional / ledger empty" because its
-- enqueue_dispatch logged under the chat session (b68f456a), not the theo_session. That false-empty
-- sent a prior Theo instance to retirement on a wrong call.
--
-- Carry theo_session_id as a first-class queryable column. api-prime-invoke populates it from the
-- tool input for session-referencing tools (read_dispatch_results / write_claims /
-- write_synthesis_section / read_synthesis / commit_synthesis) and from the enqueue_dispatch result
-- (enqueue CREATES the session, returning the id). Nullable: most tool calls have no theo_session.
ALTER TABLE public.execution_ledger ADD COLUMN IF NOT EXISTS theo_session_id uuid;

CREATE INDEX IF NOT EXISTS execution_ledger_theo_session_id_idx
  ON public.execution_ledger (theo_session_id) WHERE theo_session_id IS NOT NULL;
