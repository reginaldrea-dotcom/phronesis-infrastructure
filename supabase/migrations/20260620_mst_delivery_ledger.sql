-- MST-delivery M1 ledger (conf d36d9609, MR ac84a3d9; baton 3305e3d0, components 3 + 4).
--
-- The metric the conference asked F to audit: delivery-at-need. Two event streams in one ledger:
--   • mst_pulled       — a Prime pulled an MST (emitted by the load_mst tool). The M1 NUMERATOR.
--   • juncture_reached — a Prime reached a reasoning juncture. The M1 DENOMINATOR. Sources:
--       'load_mst' — a juncture-mode load_mst call self-reports the juncture it pulled at;
--       'marker'   — the mark_juncture tool, for NON-TOOL junctures (component 3, the denominator's
--                    non-tool tail named in Argos's F baton 5dfb4003);
--       'tool' / 'artifact' — reserved for Argos's F leg to fold in tool-call- and durable-artifact-
--                    derived junctures (the unattended + attended tracks) without a schema change.
--
-- M1 = of the (lineage, session, juncture) occasions a Prime reached a juncture, the fraction in which
-- it also pulled an MST. DISTINCT per (lineage, session, juncture) so overlapping markers/pulls for the
-- same juncture in a session count once — a well-bounded [0,1] rate, not a raw call tally that could
-- exceed 1. Argos owns the TARGET (>=90% at VALIDATION+DECISION) and may refine the windowing.

CREATE TABLE IF NOT EXISTS public.mst_delivery_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage     text NOT NULL,
  session_id  text,
  kind        text NOT NULL CHECK (kind IN ('juncture_reached', 'mst_pulled')),
  juncture    text,            -- VALIDATION / DECISION / ... ; NULL for topic/id pulls (not juncture-keyed)
  mst_id      uuid,            -- set on mst_pulled where a body resolved
  source      text NOT NULL CHECK (source IN ('load_mst', 'marker', 'tool', 'artifact')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mst_delivery_event_lineage_time_idx ON public.mst_delivery_event (lineage, created_at);
CREATE INDEX IF NOT EXISTS mst_delivery_event_kind_juncture_idx ON public.mst_delivery_event (kind, juncture);

-- Deny-all RLS: writes are service-role only (the EF tools). No anon/browser access by design,
-- consistent with the substrate's other coordination tables. A read grant for the Navigator/Argos
-- surface can be added when M1 is displayed.
ALTER TABLE public.mst_delivery_event ENABLE ROW LEVEL SECURITY;

-- M1 view — delivery-at-need rate, per juncture with an overall ROLLUP row (juncture IS NULL = overall).
CREATE OR REPLACE VIEW public.mst_delivery_m1 AS
WITH reached AS (
  SELECT DISTINCT lineage, session_id, juncture
  FROM public.mst_delivery_event
  WHERE kind = 'juncture_reached' AND juncture IS NOT NULL
),
pulled AS (
  SELECT DISTINCT lineage, session_id, juncture
  FROM public.mst_delivery_event
  WHERE kind = 'mst_pulled' AND juncture IS NOT NULL
)
SELECT
  r.juncture,
  count(*)                                                      AS junctures_reached,
  count(p.juncture)                                            AS junctures_with_pull,
  round(count(p.juncture)::numeric / nullif(count(*), 0), 3)  AS m1
FROM reached r
LEFT JOIN pulled p USING (lineage, session_id, juncture)
GROUP BY ROLLUP (r.juncture)
ORDER BY r.juncture NULLS FIRST;

COMMENT ON TABLE  public.mst_delivery_event IS 'MST-delivery M1 ledger (conf d36d9609): mst_pulled (numerator) + juncture_reached (denominator) events.';
COMMENT ON VIEW   public.mst_delivery_m1    IS 'M1 delivery-at-need rate per juncture (ROLLUP NULL row = overall). Distinct per (lineage,session,juncture).';
