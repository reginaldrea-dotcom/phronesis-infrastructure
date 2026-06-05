-- Conf 089858ad D1/D4 ratified: render contract views. Derivation lives in the
-- view, once — display states ARE view states (standing invariant, Argos).
-- Filed by constantinople, 5 Jun 2026; repo copy filed by hephaestus (clone-readiness).
-- Already applied live; this is the versioned source of record.

-- render_source_v1: one row per engine return, render_state derived.
-- NOTE: 'not_asked' is NOT derivable yet — it requires an expected-engine
-- roster (config) that does not exist; deferred and flagged in the build report.
CREATE VIEW render_source_v1 AS
SELECT
  ed.theo_session_id   AS session_id,
  ed.id                AS dispatch_id,
  ed.engine_name       AS source_name,
  ed.role_in_dispatch  AS role,
  ed.response_raw      AS content,
  CASE
    WHEN ed.status IN ('pending','dispatched') THEN ed.status
    WHEN ed.status = 'failed'  THEN 'failed_with_reason'
    WHEN ed.status = 'partial' THEN 'partial'
    WHEN ed.status = 'completed'
         AND (ed.response_raw IS NULL OR length(btrim(ed.response_raw)) = 0)
      THEN 'returned_empty'
    WHEN ed.status = 'completed' THEN 'returned'
  END                  AS render_state,
  ed.error_detail,
  ed.source_count,
  ed.cost_usd,
  ed.tokens_in,
  ed.tokens_out,
  ed.dispatched_at,
  ed.response_received_at
FROM engine_dispatch ed;

-- render_claim_v1: one row per claim with question key, provenance counts,
-- and citation resolution tallies (two-grade provenance made queryable).
CREATE VIEW render_claim_v1 AS
SELECT
  sc.id                AS claim_id,
  s.theo_session_id    AS session_id,
  sc.synthesis_id,
  sc.section_id,
  sc.question_id,
  rq.question_index,
  rq.question_text,
  sc.claim_text,
  sc.claim_status,
  sc.scope,
  sc.divergence_status,
  sc.resolution_note,
  COALESCE(src.supporting, 0)   AS supporting_engines,
  COALESCE(src.diverging, 0)    AS diverging_engines,
  COALESCE(cit.total, 0)        AS citations_total,
  COALESCE(cit.resolved, 0)     AS citations_resolved,
  COALESCE(cit.unchecked, 0)    AS citations_unchecked,
  COALESCE(cit.dead, 0)         AS citations_dead,
  COALESCE(cit.mismatched, 0)   AS citations_mismatched,
  sc.created_at
FROM synthesis_claim sc
JOIN synthesis s ON s.id = sc.synthesis_id
LEFT JOIN research_question rq ON rq.id = sc.question_id
LEFT JOIN (
  SELECT claim_id,
         count(*) FILTER (WHERE stance = 'supports') AS supporting,
         count(*) FILTER (WHERE stance = 'diverges') AS diverging
  FROM claim_source GROUP BY claim_id
) src ON src.claim_id = sc.id
LEFT JOIN (
  SELECT claim_id,
         count(*)                                        AS total,
         count(*) FILTER (WHERE resolution = 'resolved')   AS resolved,
         count(*) FILTER (WHERE resolution = 'unchecked')  AS unchecked,
         count(*) FILTER (WHERE resolution = 'dead')       AS dead,
         count(*) FILTER (WHERE resolution = 'mismatched') AS mismatched
  FROM claim_citation GROUP BY claim_id
) cit ON cit.claim_id = sc.id;
