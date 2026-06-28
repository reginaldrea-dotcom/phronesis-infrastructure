-- execution_ledger.juncture — first-class join key for the MST-delivery F audit / M1.
--
-- Baton da67b795 (numerator side of F, parent 3305e3d0). F (baton 5dfb4003) joins the numerator
-- (load_mst calls) to the denominator (mark_juncture markers + attended artifacts) on
-- (lineage, session_id, juncture). The harness already auto-ledgers every tool call to
-- execution_ledger; this lifts the juncture out of the free-text input_summary into a real column
-- (populated generically from the tool input at both the loop and B1-script write sites), so the
-- join is robust rather than a JSON-parse of a summary string. Null for non-juncture tool calls.

ALTER TABLE public.execution_ledger ADD COLUMN IF NOT EXISTS juncture text;

CREATE INDEX IF NOT EXISTS idx_execution_ledger_juncture
  ON public.execution_ledger (lineage, juncture, session_id)
  WHERE juncture IS NOT NULL;

COMMENT ON COLUMN public.execution_ledger.juncture IS
  'Reasoning juncture (VALIDATION/DECISION) this tool call concerns, lifted from the tool input (uppercased). First-class join key for the MST-delivery F audit / M1 (baton 5dfb4003): numerator = load_mst calls with a juncture; denominator = mark_juncture markers + attended artifacts. Null for tool calls that carry no juncture.';
