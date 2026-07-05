-- Read-side views for the Ground Facts / element-store (dossier-page restructure).
-- Connie deployed the schema (ground_fact, dossier_slice, element_dependency, fact_conflict,
-- claim_figure.contestability — aff7e798); this is Heph's read side, per her handoff (c92bf544).
-- Encodes the fixed integrity contract + the descend-to-evidence path as views (the render_claim_v1
-- pattern), for the render EF to read (service-role). Empty until the write side (via Theo) populates rows.
--
-- INTEGRITY CONTRACT (Connie / Eames):
--   sparse_record       = a load-bearing node with zero depends_on edges.
--   needs_corroboration = a node whose depends_on facts are all T3.
--   tier_conflict       = an explicit fact_conflict row names the element.
--   descend-to-evidence = element_dependency walked slice -> fact -> source_document / content_hash.
--
-- TWO v1 POLICY CALLS flagged for Eames' render spec (data is contract-fixed; these are presentation edges):
--   (a) Integrity universe = dossier_slices (always — they should rest on facts) + any element that is a
--       dependent in the graph + any fact named in a conflict. Leaf facts that only SUPPORT (never depend)
--       are evidence, not integrity-flagged, so they are not mislabelled sparse_record.
--   (b) needs_corroboration keys off ground_fact.authority_tier (Connie's contract column). A claim_figure
--       dependency (quantitative side, tiered by provenance_tier, not authority_tier) makes all_depends_on_t3
--       false -> not flagged. Refine when the quantitative side integrates.

-- 1. Per-element integrity state (the three states).
CREATE OR REPLACE VIEW public.render_element_integrity_v1 AS
WITH dep AS (
  SELECT
    CASE
      WHEN dependent_dossier_slice_id IS NOT NULL THEN 'dossier_slice'
      WHEN dependent_ground_fact_id  IS NOT NULL THEN 'ground_fact'
      WHEN dependent_claim_figure_id IS NOT NULL THEN 'claim_figure'
      WHEN dependent_snapshot_id     IS NOT NULL THEN 'report_snapshot'
    END AS element_type,
    COALESCE(dependent_dossier_slice_id, dependent_ground_fact_id, dependent_claim_figure_id, dependent_snapshot_id) AS element_id,
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

-- 2. Ground fact projection: content + tier/contestability/freshness + the frozen-source anchor + conflict flag.
CREATE OR REPLACE VIEW public.render_ground_fact_v1 AS
SELECT
  gf.id AS ground_fact_id,
  gf.title, gf.content, gf.definition_scope,
  gf.period_start, gf.period_end, gf.period_label,
  gf.source_url, gf.content_hash, gf.source_document_id,
  gf.authority_tier, gf.contestability, gf.freshness_status,
  gf.last_verified_at, gf.captured_at, gf.captured_by_lineage,
  gf.superseded_by, (gf.superseded_by IS NOT NULL) AS is_superseded,
  sd.source_url  AS snapshot_source_url,     -- descend-to-evidence: the frozen source_document
  sd.captured_at AS snapshot_captured_at,
  sd.content_hash AS snapshot_content_hash,
  EXISTS (SELECT 1 FROM public.fact_conflict fc
          WHERE fc.fact_a_ground_fact_id = gf.id OR fc.fact_b_ground_fact_id = gf.id) AS in_conflict
FROM public.ground_fact gf
LEFT JOIN public.source_document sd ON sd.id = gf.source_document_id;

-- 3. Slice -> supporting facts (the descend join the render walks for a dossier_slice).
CREATE OR REPLACE VIEW public.render_dossier_slice_fact_v1 AS
SELECT
  ed.dependent_dossier_slice_id AS dossier_slice_id,
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
WHERE ed.dependent_dossier_slice_id IS NOT NULL;
