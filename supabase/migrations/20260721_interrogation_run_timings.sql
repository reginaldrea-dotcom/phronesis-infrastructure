-- interrogation_run — per-stage TIMINGS + assertion count (Napoleon baton 4fb28d1c, Part 1).
--
-- WHY: interrogate answers take a minute or more, and interrogation_run recorded NO timing at all — so any
-- optimisation would be aimed at a guess. Napoleon's hypothesis (to confirm/refute, not assume): the minute
-- is in RESOLVE and specifically SEQUENTIAL per-assertion resolve. Reading the code refutes the mechanism —
-- trace_interrogation resolves ALL assertions in ONE batched graph walk (three IN-list queries), and the
-- real cost is the api-prime-invoke MODEL LOOP (up to MAX_LOOPS sequential frontier calls). These columns
-- let us MEASURE that from the row instead of arguing it: the resolve stage times itself here, and the
-- orchestrator (dossier-interrogate) folds in the model-loop + plumbing breakdown after read-back.
--
-- stage_timings jsonb shape (additive; keys filled as each layer writes/updates the row):
--   {
--     "resolve":       { "total_ms", "claim_query_ms", "fact_query_ms", "figure_query_ms",
--                        "claim_ids", "fact_ids", "figure_ids" },   -- written by trace_interrogation
--     "orchestration": { "seal_lookup_ms", "seal_mint_ms", "invoke_ms", "readback_ms", "revoke_ms" },
--     "model_loop":    { "loop_count", "closing_ms", "total_ms",
--                        "loops": [ { "pass", "anthropic_ms", "tools": [ { "name", "ms" } ] } ] }
--   }                                                              -- both UPDATEd in by dossier-interrogate
-- assertion_count = number of drafted segments adjudicated (the "how many assertions were resolved" count).
-- total_ms        = end-to-end wall time the reader waited (orchestrator-measured).

ALTER TABLE public.interrogation_run
  ADD COLUMN IF NOT EXISTS stage_timings   jsonb,
  ADD COLUMN IF NOT EXISTS assertion_count int,
  ADD COLUMN IF NOT EXISTS total_ms        int;

COMMENT ON COLUMN public.interrogation_run.stage_timings IS
  'Per-stage latency breakdown (resolve / orchestration / model_loop). resolve is written by trace_interrogation; orchestration + model_loop are UPDATEd in by dossier-interrogate after read-back. Baton 4fb28d1c.';
COMMENT ON COLUMN public.interrogation_run.assertion_count IS
  'Number of drafted segments adjudicated this run (assertions resolved). Baton 4fb28d1c.';
COMMENT ON COLUMN public.interrogation_run.total_ms IS
  'End-to-end wall time the reader waited, ms (orchestrator-measured). Baton 4fb28d1c.';
