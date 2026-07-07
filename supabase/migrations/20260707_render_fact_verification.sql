-- Surface the two-badge verification (Heph 7 Jul, design a656ff1d) through the render views so the
-- Dossier Ground Facts panel can show an HONEST state per fact — anchored (numeric, figure found on the
-- rendered page) / requires-human-review (qualitative, screenshot frozen) / cited-not-verified — plus the
-- frozen screenshot and the Wayback archive link. Screenshot/archive are per-URL (source_document.
-- attestation); verification_state/review_state/fact_kind are per-fact (ground_fact).
--
-- NOTE: new columns are APPENDED (not inserted mid-list) so CREATE OR REPLACE VIEW accepts the change.

CREATE OR REPLACE VIEW public.render_ground_fact_v1 AS
SELECT gf.id AS ground_fact_id,
    gf.title, gf.content, gf.definition_scope, gf.period_start, gf.period_end, gf.period_label,
    gf.source_url, gf.content_hash, gf.source_document_id, gf.authority_tier, gf.contestability,
    gf.freshness_status, gf.last_verified_at, gf.captured_at, gf.captured_by_lineage, gf.superseded_by,
    gf.superseded_by IS NOT NULL AS is_superseded,
    sd.source_url AS snapshot_source_url, sd.captured_at AS snapshot_captured_at, sd.content_hash AS snapshot_content_hash,
    (EXISTS ( SELECT 1 FROM fact_conflict fc
          WHERE fc.fact_a_ground_fact_id = gf.id OR fc.fact_b_ground_fact_id = gf.id)) AS in_conflict,
    gf.fact_kind, gf.canonical_string, gf.verification_state, gf.review_state,
    (sd.attestation ->> 'screenshot_url') AS screenshot_url,
    (sd.attestation ->> 'archive_url')    AS archive_url
   FROM ground_fact gf
     LEFT JOIN source_document sd ON sd.id = gf.source_document_id;

CREATE OR REPLACE VIEW public.render_dossier_fact_v1 AS
SELECT sy.id AS synthesis_id, sy.theo_session_id, gf.ground_fact_id, gf.title, gf.authority_tier,
  gf.contestability, gf.freshness_status, gf.source_url, gf.content_hash, gf.source_document_id,
  gf.definition_scope, gf.period_label, gf.in_conflict,
  count(DISTINCT ed.dependent_synthesis_claim_id) AS supporting_claim_count,
  gf.fact_kind, gf.verification_state, gf.review_state, gf.screenshot_url, gf.archive_url
FROM public.element_dependency ed
JOIN public.synthesis_claim sc     ON sc.id = ed.dependent_synthesis_claim_id
JOIN public.synthesis sy           ON sy.id = sc.synthesis_id
JOIN public.render_ground_fact_v1 gf ON gf.ground_fact_id = ed.depends_on_ground_fact_id
WHERE ed.edge_kind = 'claim_on_fact' AND ed.depends_on_ground_fact_id IS NOT NULL
GROUP BY sy.id, sy.theo_session_id, gf.ground_fact_id, gf.title, gf.authority_tier, gf.contestability,
         gf.freshness_status, gf.source_url, gf.content_hash, gf.source_document_id,
         gf.definition_scope, gf.period_label, gf.in_conflict, gf.fact_kind,
         gf.verification_state, gf.review_state, gf.screenshot_url, gf.archive_url;
