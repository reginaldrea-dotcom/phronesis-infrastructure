-- execution_ledger.via — allow 'worker' (C1, baton 9283c919).
--
-- The dispatch worker (theo-dispatch-worker) is a third execution channel alongside the agent tool
-- loop ('loop') and the sandboxed script runner ('script'). C1 has the worker leave an execution_ledger
-- row at every terminal dispatch transition (completed/partial/failed) so a finishing OR dying dispatch
-- is no longer "invisible until queried" (Theo's post-mortem found the ledger EMPTY for a real session).
-- Those rows are written with via='worker', which the prior CHECK rejected. Widen the allowed set;
-- purely additive — no existing row changes, no narrowing.
--
-- Keeper note (Connie): this extends your execution_ledger.via enum. Additive only; flagged on the board.
ALTER TABLE public.execution_ledger DROP CONSTRAINT IF EXISTS execution_ledger_via_check;
ALTER TABLE public.execution_ledger ADD CONSTRAINT execution_ledger_via_check
  CHECK (via = ANY (ARRAY['loop'::text, 'script'::text, 'worker'::text]));
