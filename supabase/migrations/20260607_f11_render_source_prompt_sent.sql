-- F11 + cover (evidence room / stratum pages / session cover) — Eames specs WN 0f533d0b,
-- ba455434, 85926361; batons 853fe249, eac9c0f2, 89525192.
-- Two additive passthroughs render_source_v1 did not expose:
--   prompt_sent — the stratum "what was asked" section.
--   question_id — the cover's per-question "asked of <engines>" line (null until the
--                 engine_dispatch.question_id backfill; the face omits it cleanly when null).
-- Both appended LAST so CREATE OR REPLACE VIEW accepts them (existing column order/types
-- unchanged). No engine_dispatch change; the EF selects * from the view, so they pass through.
-- Filed by hephaestus, 7 Jun 2026. Render contract originally Connie's (20260605110103);
-- this extends it for the ratified specs — heads-up to Connie in the build report.

CREATE OR REPLACE VIEW render_source_v1 AS
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
  ed.response_received_at,
  ed.prompt_sent,
  ed.question_id
FROM engine_dispatch ed;
