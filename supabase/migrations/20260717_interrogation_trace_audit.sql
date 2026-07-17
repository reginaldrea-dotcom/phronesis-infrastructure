-- interrogation_run — the ROW-AUDITABLE record of a trace_interrogation adjudication.
--
-- WHY (baton chain 6f1d98fa -> Aegis msg 8cadd109 -> Integrity Test rubric 6e5c5f6d): the Integrity Test
-- evaluates "the trace's ROWS — which assertions resolved to a ground_fact and which were dropped", NOT the
-- djinn's prose. But trace_interrogation's {kept, withheld, vetted_answer, ledger} was ONLY a direct return
-- value to the harness caller — never persisted — so a verifier on the DB connector (Aegis) could not read
-- it. This table persists each adjudication so the Integrity Test is self-contained from the Supabase
-- connector, and every future interrogation is audit-durable. One row per trace_interrogation call.
--
-- ledger jsonb = the per-segment decisions verbatim (index, disposition kept/withheld, reason, tier, text,
-- rendered, attribution) — the "trace rows" the rubric scores. Per-segment queries:
--   SELECT question, e->>'disposition', e->>'reason', e->>'tier', e->>'text'
--     FROM interrogation_run, jsonb_array_elements(ledger) e WHERE session_id = '...';

CREATE TABLE IF NOT EXISTS public.interrogation_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    text,                 -- the (sealed) session that ran the interrogation
  lineage       text,                 -- calling lineage (delphia, for interrogate)
  dossier_id    text,                 -- the Dossier / synthesis interrogated
  question      text,
  kept          int,
  withheld      int,
  vetted_answer jsonb,                -- the server-vetted answer delivered verbatim
  ledger        jsonb,                -- per-segment adjudication rows (the Integrity Test evidence)
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.interrogation_run IS
  'Row-auditable record of each trace_interrogation adjudication (kept/withheld per segment + vetted answer). Written best-effort by the trace_interrogation tool below the model; read by verifiers (Integrity Test rubric 6e5c5f6d). See migration header.';

CREATE INDEX IF NOT EXISTS idx_interrogation_run_session
  ON public.interrogation_run (session_id, created_at DESC);

-- House convention: RLS deny-all with zero policies. Writes are service-role (the EF, below the model);
-- the anon browser is denied. Service-role verifiers read it directly.
ALTER TABLE public.interrogation_run ENABLE ROW LEVEL SECURITY;
