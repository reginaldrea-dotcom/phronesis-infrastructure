-- artifacts: lineage + canonical_status columns and the PI one-canonical index.
--
-- TRANSCRIPTION FOR CLONE-READINESS. These three steps were authored + applied LIVE by
-- Constantinople (keeper / DDL lane, Seq 37, against spec artifact f1a4e8d2 / brief c57e32b8)
-- but were missing from the repo. Recorded here verbatim-with-guards so a fresh clone replay
-- reconstructs the schema the file_canonical_artifact() function depends on. Authorship is
-- Constantinople's; this file only closes the repo gap (Heph, 28 Jun 2026). IF NOT EXISTS /
-- conditional guards make it a safe no-op against the already-applied live state.

-- Step 1 — promote lineage to a generated column (small clean value set, widely queried).
ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS lineage text GENERATED ALWAYS AS (metadata->>'lineage') STORED;

CREATE INDEX IF NOT EXISTS idx_artifacts_lineage
  ON public.artifacts (lineage)
  WHERE lineage IS NOT NULL;

-- Step 2 — a SCOPED canonical_status column carrying ONLY the supersede-chain vocabulary
-- (canonical / superseded / null). metadata->>'status' stays freeform and untouched: it holds
-- 32 distinct freeform values across Primes, so it is NOT a controlled vocabulary.
ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS canonical_status text
  CHECK (canonical_status IN ('canonical', 'superseded') OR canonical_status IS NULL);

UPDATE public.artifacts
  SET canonical_status = metadata->>'status'
  WHERE metadata->>'status' IN ('canonical', 'superseded')
    AND canonical_status IS NULL;

-- Step 3 — the one-canonical structural invariant, SCOPED TO PI ONLY (Seq 37 decision).
-- canonical is used as a freeform descriptor across MR/WN/SY for legitimately distinct documents
-- (e.g. five Theophrastus synthesis reports, two Angelia MRs), so the one-canonical-per-lineage
-- invariant is only meaningful for the supersede-chained PI type. Enforce it exactly where it is true.
CREATE UNIQUE INDEX IF NOT EXISTS one_canonical_pi_per_lineage
  ON public.artifacts (lineage, artifact_type)
  WHERE canonical_status = 'canonical' AND artifact_type = 'PI';
