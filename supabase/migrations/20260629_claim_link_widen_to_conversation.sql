-- Widen enforce_same_session_claim_link from same-SESSION to same-CONVERSATION.
--
-- Ruling 82d38a8f (Constantinople): the conversation is the evidence-ownership boundary; a claim may
-- cite a dispatch from any session in the SAME conversation (same user), but never across conversations.
-- This is the DB half of baton 8cb99efa (whose EF change widened write_claims' dispatch pool to the
-- conversation but left this invariant at same-session), and it fixes baton 6d755360 (a corrected
-- re-dispatch lands in a new same-conversation session; the old same-session rule walled off capture).
--
-- The function backs BOTH triggers (trg_claim_source_same_session on claim_source and
-- trg_claim_citation_same_session on claim_citation); CREATE OR REPLACE updates both. Null guard: an
-- unlinked session (NULL conversation_id) on either side raises rather than silently bypassing the floor.
--
-- Verified (Heph, 2026-06-29) on a synthetic scaffold: a same-conversation cross-session claim_source
-- PASSES (it raised pre-fix); a cross-conversation claim_source RAISES; a cross-conversation
-- claim_citation RAISES. Forgery floor preserved at conversation scope.
CREATE OR REPLACE FUNCTION public.enforce_same_session_claim_link()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_claim_conversation uuid;
  v_dispatch_conversation uuid;
BEGIN
  IF NEW.dispatch_id IS NULL THEN
    RETURN NEW;  -- citation rows may legitimately carry no dispatch link
  END IF;

  SELECT ts.conversation_id INTO v_claim_conversation
  FROM synthesis_claim sc
  JOIN synthesis s ON s.id = sc.synthesis_id
  JOIN theo_session ts ON ts.id = s.theo_session_id
  WHERE sc.id = NEW.claim_id;

  SELECT ts.conversation_id INTO v_dispatch_conversation
  FROM engine_dispatch ed
  JOIN theo_session ts ON ts.id = ed.theo_session_id
  WHERE ed.id = NEW.dispatch_id;

  IF v_claim_conversation IS NULL OR v_dispatch_conversation IS NULL
     OR v_claim_conversation IS DISTINCT FROM v_dispatch_conversation THEN
    RAISE EXCEPTION
      'PROVENANCE INVARIANT VIOLATION (same-conversation rule, ruling 82d38a8f): claim % resolves to conversation %, dispatch % resolves to conversation %. Cross-conversation (or unscoped) evidence links are not permitted.',
      NEW.claim_id, v_claim_conversation, NEW.dispatch_id, v_dispatch_conversation;
  END IF;

  RETURN NEW;
END $function$;
