-- Per-section confidence for the dossier's L1 (Eames 0515073a: "the honest computable successor to the old
-- free-text confidence-by-area"). synthesis_claim.section_id -> synthesis_section.id gives the claim->section
-- linkage; render_element_integrity_v1 gives each claim's state from the tiers of the facts it rests on
-- (element_dependency claim_on_fact). This aggregates a section's claims into one confidence_state.
--
-- Policy (honest, partial-aware; Eames may tune): ungrounded if the section has no grounded claims; a
-- conflict among any claim's facts dominates; otherwise weak-tier OR partial grounding (some claims not yet
-- grounded) reads as needs_corroboration; only all-claims-grounded-and-strong reads ok. Empty until edges land.
CREATE OR REPLACE VIEW public.render_section_confidence_v1 AS
SELECT
  ss.id            AS section_id,
  ss.synthesis_id,
  ss.section_index,
  count(sc.id)            AS claim_count,
  count(ei.element_id)    AS grounded_claim_count,
  CASE
    WHEN count(sc.id) = 0                                   THEN 'ungrounded'
    WHEN bool_or(ei.integrity_state = 'tier_conflict')      THEN 'tier_conflict'
    WHEN count(ei.element_id) = 0                           THEN 'ungrounded'
    WHEN bool_or(ei.integrity_state = 'needs_corroboration')
         OR count(ei.element_id) < count(sc.id)             THEN 'needs_corroboration'
    ELSE 'ok'
  END AS confidence_state
FROM public.synthesis_section ss
LEFT JOIN public.synthesis_claim sc ON sc.section_id = ss.id
LEFT JOIN public.render_element_integrity_v1 ei
       ON ei.element_type = 'synthesis_claim' AND ei.element_id = sc.id
GROUP BY ss.id, ss.synthesis_id, ss.section_index;
