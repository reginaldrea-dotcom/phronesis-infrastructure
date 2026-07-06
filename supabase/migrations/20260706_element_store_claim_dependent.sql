-- Read side of the claim->fact linkage (Eames ruling a2310ece; Connie's ALTER live: element_dependency now
-- has dependent_synthesis_claim_id + a 'claim_on_fact' edge_kind, one_dependent is 5-way). Two changes so
-- the dossier page's descend-to-evidence + tier-gated states work for a session's synthesis_claims:
--   1. render_element_integrity_v1 recognises synthesis_claim as a dependent (its integrity state computes
--      from the tiers of the facts it depends_on — same contract). Output columns unchanged.
--   2. render_claim_fact_v1 (new): synthesis_claim -> depends_on ground_fact/claim_figure, the descend join
--      (mirrors render_dossier_slice_fact_v1). This is the traversal Phase 2 walks: claim -> fact -> capture.
-- Empty until Angelia grounds edges (needs Connie's write_element_dependency RPC — the grant is live, the
-- function is not yet; flagged). A displayed claim with NO integrity row = sparse_record (page interprets).

CREATE OR REPLACE VIEW public.render_element_integrity_v1 AS
WITH dep AS (
  SELECT
    CASE
      WHEN dependent_dossier_slice_id   IS NOT NULL THEN 'dossier_slice'
      WHEN dependent_synthesis_claim_id IS NOT NULL THEN 'synthesis_claim'
      WHEN dependent_ground_fact_id     IS NOT NULL THEN 'ground_fact'
      WHEN dependent_claim_figure_id    IS NOT NULL THEN 'claim_figure'
      WHEN dependent_snapshot_id        IS NOT NULL THEN 'report_snapshot'
    END AS element_type,
    COALESCE(dependent_dossier_slice_id, dependent_synthesis_claim_id, dependent_ground_fact_id, dependent_claim_figure_id, dependent_snapshot_id) AS element_id,
    depends_on_ground_fact_id
  FROM public.element_dependency
),
dep_agg AS (
  SELECT d.element_type, d.element_id,
    count(*) AS depends_on_count,
    bool_and(d.depends_on_ground_fact_id IS NOT NULL AND gf.authority_tier = 'T3') AS all_depends_on_t3
  FROM dep d
  LEFT JOIN public.ground_fact gf ON gf.id = d.depends_on_ground_fact_id
  GROUP BY d.element_type, d.element_id
),
conflict AS (
  SELECT 'ground_fact'::text AS element_type, fact_a_ground_fact_id AS element_id FROM public.fact_conflict WHERE fact_a_ground_fact_id IS NOT NULL
  UNION SELECT 'ground_fact',  fact_b_ground_fact_id  FROM public.fact_conflict WHERE fact_b_ground_fact_id  IS NOT NULL
  UNION SELECT 'claim_figure', fact_a_claim_figure_id FROM public.fact_conflict WHERE fact_a_claim_figure_id IS NOT NULL
  UNION SELECT 'claim_figure', fact_b_claim_figure_id FROM public.fact_conflict WHERE fact_b_claim_figure_id IS NOT NULL
),
universe AS (
  SELECT 'dossier_slice'::text AS element_type, id AS element_id FROM public.dossier_slice
  UNION SELECT element_type, element_id FROM dep
  UNION SELECT element_type, element_id FROM conflict
)
SELECT
  u.element_type,
  u.element_id,
  COALESCE(da.depends_on_count, 0)       AS depends_on_count,
  COALESCE(da.all_depends_on_t3, false)  AS all_depends_on_t3,
  (c.element_id IS NOT NULL)             AS has_tier_conflict,
  CASE
    WHEN c.element_id IS NOT NULL              THEN 'tier_conflict'
    WHEN COALESCE(da.depends_on_count, 0) = 0  THEN 'sparse_record'
    WHEN da.all_depends_on_t3                  THEN 'needs_corroboration'
    ELSE 'ok'
  END AS integrity_state
FROM universe u
LEFT JOIN dep_agg  da ON da.element_type = u.element_type AND da.element_id = u.element_id
LEFT JOIN conflict c  ON c.element_type  = u.element_type AND c.element_id  = u.element_id;

-- Claim -> supporting facts (the descend-to-evidence join for a session's synthesis_claims).
CREATE OR REPLACE VIEW public.render_claim_fact_v1 AS
SELECT
  ed.dependent_synthesis_claim_id AS synthesis_claim_id,
  ed.edge_kind,
  ed.depends_on_ground_fact_id  AS ground_fact_id,
  ed.depends_on_claim_figure_id AS claim_figure_id,
  gf.title          AS ground_fact_title,
  gf.authority_tier,
  gf.contestability,
  gf.source_document_id,
  gf.content_hash
FROM public.element_dependency ed
LEFT JOIN public.ground_fact gf ON gf.id = ed.depends_on_ground_fact_id
WHERE ed.dependent_synthesis_claim_id IS NOT NULL;
