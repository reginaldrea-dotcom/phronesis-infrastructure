-- interrogation_cache — precomputed / warmed interrogate answers (Napoleon baton 39ea928f, item 3).
--
-- WHY: the 36-of-45 betterworld claims carry a question_id, so the suggested questions (research_question)
-- are KNOWN IN ADVANCE. Running the trace once per known question and caching the vetted answer makes every
-- suggested question INSTANT — and the audit is fully intact, because the trace still ran (just earlier).
-- The draft (the judgment step, ~45s) is paid once, off the reader's clock.
--
-- STALENESS IS A CORRECTNESS ISSUE, NOT A NICETY (Napoleon): a claim edit or a re-ground must never serve a
-- stale vetted answer. We do NOT rely on invalidation triggers; instead each row stores the GRAPH_VERSION it
-- was computed against — an md5 fingerprint over the Dossier's claim/edge/tier state (exactly the inputs the
-- trace walks). On serve, dossier-interrogate recomputes the current fingerprint and serves the cache ONLY if
-- it still matches. Any change to the graph flips the fingerprint -> cache miss -> recompute. Serving a stale
-- answer is therefore structurally impossible, with no trigger to forget to write.
--
-- One row per (Dossier, normalized question). question_norm = lower(trim(collapse-whitespace(question))), so a
-- suggested question and a re-typed variant of it hit the same row. vetted_answer is the SAME segment array
-- the live path returns (kept text + withheld gap-notes), so the surface renders it identically.

CREATE TABLE IF NOT EXISTS public.interrogation_cache (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theo_session_id  uuid NOT NULL,               -- the Dossier scope
  question         text NOT NULL,               -- the question as asked (display)
  question_norm    text NOT NULL,               -- normalized for matching (lower/trim/collapse-ws)
  vetted_answer    jsonb NOT NULL,              -- the server-vetted segment array (kept + withheld notes)
  kept             int,
  withheld         int,
  assertion_count  int,
  graph_version    text NOT NULL,               -- md5 fingerprint of the claim/edge/tier state it was computed against
  source           text NOT NULL DEFAULT 'live',-- 'precompute' (warmed) | 'live' (a reader's first ask cached it)
  computed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (theo_session_id, question_norm)
);

COMMENT ON TABLE public.interrogation_cache IS
  'Precomputed/warmed interrogate answers (baton 39ea928f item 3). Served ONLY when graph_version still matches the Dossier''s current claim/edge/tier fingerprint (staleness = correctness). One row per (Dossier, normalized question).';
COMMENT ON COLUMN public.interrogation_cache.graph_version IS
  'md5 fingerprint of the Dossier claim/edge/tier state at compute time. A serve is allowed only if it equals the current fingerprint; any change (claim edit, re-ground, tier change) forces a recompute.';

CREATE INDEX IF NOT EXISTS idx_interrogation_cache_lookup
  ON public.interrogation_cache (theo_session_id, question_norm);

-- House convention: RLS deny-all with zero policies. Writes are service-role (the EFs, below the model); the
-- anon browser is denied direct access and reaches cached answers only through dossier-interrogate.
ALTER TABLE public.interrogation_cache ENABLE ROW LEVEL SECURITY;
