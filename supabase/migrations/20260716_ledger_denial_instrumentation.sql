-- Ledger denial instrumentation (baton 7f71b2df, delphia/ledger-denial-instrumentation; passed by Napoleon).
-- First step of the interrogate build (SP 485b637b) and Aegis's binding pre-Mode-2 dependency
-- (methodology fde834d3: ledger-as-ground-truth).
--
-- THE PROBLEM: execution_ledger could not distinguish a REFUSAL from a SUCCESS. A tool call refused
-- below the model (the sealed-sibling capability belt in enforceCapability / requireGrant, the loop
-- tool-grant gate, or a B1 script-scope gate) recorded its opaque denial string as "-> 251 chars" —
-- textually indistinguishable from any opaque successful payload. There was ZERO denial vocabulary in
-- the table (denial_rows = 0 across the whole ledger). So a refusal was a PROSE SELF-REPORT — the exact
-- pattern the substrate forbids everywhere else. Every Denial Proof had to READ RESPONSE STRINGS because
-- the ledger could not testify. A model can narrate "I withheld this" without withholding; a row cannot lie.
--
-- THE FIX: make a refusal an AUDITABLE ROW. denied_capability is a first-class, structured signal set at
-- the belt (where the refusal is KNOWN), never parsed back out of the tool's return prose.
--   NULL      -> the call was NOT refused below the model. It ran (it may then have succeeded OR errored in
--                execution — that is the tool's business, recorded in `outcome`, not a belt denial).
--   non-NULL  -> the call was REFUSED below the model. The value is the missing CAPABILITY when the refusal
--                was tied to one (e.g. 'raw_web_dispatch', 'commission_grounding'), else a structural reason
--                sentinel for a refusal not tied to a single named capability:
--                  'deny_by_default'        — sealed sibling reached an unmapped privileged tool (no permit maps it)
--                  'not_granted_to_lineage' — standing Prime's loop gate: tool not in the lineage's tool_grants
--                  'not_a_binding'          — B1 script called a tool with no script-callable binding
--                  '<family>:<scope>'       — B1 script lacked that tool_grants script scope
--
-- THE PREDICATE (what Denial Proofs / the interrogate integrity test now query, WITHOUT reading payloads):
--   refused?          ->  denied_capability IS NOT NULL
--   which capability? ->  denied_capability
--
-- Additive and non-breaking: a PERMITTED call still records exactly as today (denied_capability stays NULL).
-- Historical rows stay NULL (unknowable in retrospect; denial_rows was 0 anyway, so nothing true is lost).

ALTER TABLE public.execution_ledger
  ADD COLUMN IF NOT EXISTS denied_capability text;

COMMENT ON COLUMN public.execution_ledger.denied_capability IS
  'Denial instrumentation (baton 7f71b2df). NULL = the call was not refused below the model (it ran). '
  'non-NULL = REFUSED below the model; the value is the missing capability (e.g. raw_web_dispatch) or a '
  'structural reason sentinel (deny_by_default / not_granted_to_lineage / not_a_binding / <family>:<scope>). '
  'Set at the belt, never parsed from the return prose. Query: refused = (denied_capability IS NOT NULL).';

-- Denial-proof / audit query support: a partial index so "show me every refusal" (and refusals of a given
-- capability) is a cheap indexed scan even as the ledger grows. Refusals are the rare, high-signal rows.
CREATE INDEX IF NOT EXISTS idx_execution_ledger_denied
  ON public.execution_ledger (denied_capability, occurred_at DESC)
  WHERE denied_capability IS NOT NULL;
