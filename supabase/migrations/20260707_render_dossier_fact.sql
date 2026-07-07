-- Ground Facts panel data for the dossier page (was a Phase-2 stub; wiring it to real rows now that
-- Angelia has grounded). The panel shows the anchored sources a Dossier stands on: the DISTINCT ground_facts
-- that support any of the session's synthesis_claims via claim_on_fact edges, with tier / contestability /
-- freshness / frozen-capture pointer, plus how many claims each underpins.
CREATE OR REPLACE VIEW public.render_dossier_fact_v1 AS
SELECT
  sy.id             AS synthesis_id,
  sy.theo_session_id,
  gf.ground_fact_id,
  gf.title,
  gf.authority_tier,
  gf.contestability,
  gf.freshness_status,
  gf.source_url,
  gf.content_hash,
  gf.source_document_id,
  gf.definition_scope,
  gf.period_label,
  gf.in_conflict,
  count(DISTINCT ed.dependent_synthesis_claim_id) AS supporting_claim_count
FROM public.element_dependency ed
JOIN public.synthesis_claim sc     ON sc.id = ed.dependent_synthesis_claim_id
JOIN public.synthesis sy           ON sy.id = sc.synthesis_id
JOIN public.render_ground_fact_v1 gf ON gf.ground_fact_id = ed.depends_on_ground_fact_id
WHERE ed.edge_kind = 'claim_on_fact' AND ed.depends_on_ground_fact_id IS NOT NULL
GROUP BY sy.id, sy.theo_session_id, gf.ground_fact_id, gf.title, gf.authority_tier, gf.contestability,
         gf.freshness_status, gf.source_url, gf.content_hash, gf.source_document_id,
         gf.definition_scope, gf.period_label, gf.in_conflict;
