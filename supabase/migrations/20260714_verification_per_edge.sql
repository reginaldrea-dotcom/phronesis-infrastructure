-- Per-edge verification. Eames ruling 83163028; Connie ack 32ce964b.
--
-- Verification is a property of the claim<-fact SUPPORT RELATION, not the captured page:
-- "verified" is not something a FACT has (a fact is a captured page); the proposition being
-- verified is "this CLAIM is supported by this FACT", which IS the claim_on_fact edge. Per-fact
-- state also cannot support the co-location gate (one fact serving N claims with N different
-- figures cannot carry one anchor_quote), and it is HOW the incident's false-positive spread:
-- state on the node means every edge inherits a verdict earned by ONE figure.
--
-- This migration: (1) adds verification columns to the edge; (2) backfills them from the fact's
-- current state; (3) FAIL-SAFE downgrades every currently-anchored edge to cited_not_verified
-- (all were anchored under figure-identity ALONE - no subject co-location - so none has earned
-- 'anchored'; the co-location gate, built next, re-earns it); (4) repoints the two render views
-- that expose verification_state to source it from the edge.
--
-- ground_fact.verification_state / review_state are KEPT (Connie: non-trust headline for review +
-- backfill continuity) but STOP conferring trust - nothing reads them after step 4.
-- The co-location gate itself (write_element_dependency) is a SEPARATE change, paired with Eames.

-- 1. Additive edge columns (meaningful only for edge_kind='claim_on_fact'; nullable).
alter table element_dependency
  add column if not exists verification_state     text,
  add column if not exists anchor_quote           text,
  add column if not exists claim_canonical_string text,
  add column if not exists review_state           text,
  add column if not exists reviewed_by            text,
  add column if not exists reviewed_at            timestamptz;

-- 2. Backfill each claim_on_fact edge's state from its fact's current state.
update element_dependency ed
   set verification_state = gf.verification_state,
       review_state       = gf.review_state
  from ground_fact gf
 where ed.edge_kind = 'claim_on_fact'
   and ed.depends_on_ground_fact_id = gf.id;

-- 3. Fail-safe: drop every inherited 'anchored' to cited_not_verified. The gate re-earns it;
--    figure-match alone is NOT a pass (that is exactly what let INDUSTRY anchor to BUILDINGS).
update element_dependency
   set verification_state = 'cited_not_verified',
       review_state       = 'pending',
       anchor_quote       = null
 where edge_kind = 'claim_on_fact'
   and verification_state = 'anchored';

-- 4. Repoint the two verification-bearing render views to the EDGE. Per (dossier|section, fact),
--    the source's panel state is the STRONGEST verification any of its edges achieves
--    (anchored > screenshot_review > cited_not_verified) - "does this source anchor anything?".
--    Column names/order/types preserved, so theo-render-data + the front-end are untouched.
--    (render_claim_v1 and render_section_confidence_v1 do not read verification_state - the latter
--     derives confidence from tier-composition via render_element_integrity_v1 - so both are left
--     as-is.)

create or replace view render_dossier_fact_v1 as
 select sy.id as synthesis_id,
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
    count(distinct ed.dependent_synthesis_claim_id) as supporting_claim_count,
    gf.fact_kind,
    case
        when bool_or(ed.verification_state = 'anchored') then 'anchored'
        when bool_or(ed.verification_state = 'screenshot_review') then 'screenshot_review'
        else 'cited_not_verified'
    end as verification_state,
    case
        when bool_or(ed.review_state = 'pending') then 'pending'
        when bool_or(ed.review_state = 'reviewed') then 'reviewed'
        else 'not_required'
    end as review_state,
    gf.screenshot_url,
    gf.archive_url
   from element_dependency ed
     join synthesis_claim sc on sc.id = ed.dependent_synthesis_claim_id
     join synthesis sy on sy.id = sc.synthesis_id
     join render_ground_fact_v1 gf on gf.ground_fact_id = ed.depends_on_ground_fact_id
  where ed.edge_kind = 'claim_on_fact' and ed.depends_on_ground_fact_id is not null
  group by sy.id, sy.theo_session_id, gf.ground_fact_id, gf.title, gf.authority_tier,
           gf.contestability, gf.freshness_status, gf.source_url, gf.content_hash,
           gf.source_document_id, gf.definition_scope, gf.period_label, gf.in_conflict,
           gf.fact_kind, gf.screenshot_url, gf.archive_url;

create or replace view render_section_fact_v1 as
 select ss.id as section_id,
    ss.synthesis_id,
    gf.ground_fact_id,
    gf.title,
    gf.authority_tier,
    gf.contestability,
    case
        when bool_or(ed.verification_state = 'anchored') then 'anchored'
        when bool_or(ed.verification_state = 'screenshot_review') then 'screenshot_review'
        else 'cited_not_verified'
    end as verification_state,
    case
        when bool_or(ed.review_state = 'pending') then 'pending'
        when bool_or(ed.review_state = 'reviewed') then 'reviewed'
        else 'not_required'
    end as review_state,
    gf.screenshot_url,
    gf.archive_url,
    gf.source_url,
    gf.content_hash,
    gf.in_conflict
   from synthesis_section ss
     join synthesis_claim sc on sc.section_id = ss.id
     join element_dependency ed on ed.dependent_synthesis_claim_id = sc.id
        and ed.edge_kind = 'claim_on_fact' and ed.depends_on_ground_fact_id is not null
     join render_ground_fact_v1 gf on gf.ground_fact_id = ed.depends_on_ground_fact_id
  group by ss.id, ss.synthesis_id, gf.ground_fact_id, gf.title, gf.authority_tier,
           gf.contestability, gf.screenshot_url, gf.archive_url, gf.source_url,
           gf.content_hash, gf.in_conflict;
