-- interrogation_run.curated — count of CURATED_OPERATOR entries in an adjudication (baton 53897bcc).
--
-- CURATED_OPERATOR is a DISTINCT class, orthogonal to the tier axis and to attestation_state (three axes,
-- none collapsible): a withheld ungrounded_claim an operator ACCEPTED on their own knowledge, attributed to
-- the curator. It is neither grounded (source-backed) nor withheld (a gap), so it needs its own count for the
-- row audit — kept + curated + withheld = the adjudicated segments.
ALTER TABLE public.interrogation_run ADD COLUMN IF NOT EXISTS curated int;
COMMENT ON COLUMN public.interrogation_run.curated IS
  'Count of CURATED_OPERATOR entries (operator-vouched claims, attributed to the curator). A distinct class, not grounded and not withheld. Baton 53897bcc.';
