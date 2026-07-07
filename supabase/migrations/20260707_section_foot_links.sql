-- Section-foot link zones (Eames c639a489 / msg 190f3512): at the foot of each synthesis_section, two
-- epistemic groups — GROUNDED SOURCES (the section's anchored facts, derived) and SUPPORTING LINKS
-- (~6 curated engine-return links, NOT verified; a promotion "waiting room").
--
-- Grounded-per-section is DERIVED (no storage) via render_section_fact_v1. Supporting links need a home:
-- ADDITIVE, NULLABLE columns on synthesis_section (Connie's lane — flagged to her; reshape as she prefers).
-- Theo's sibling writes support_links per section; domain is derived at render, so the writer supplies
-- only url (+ optional title). support_links_valid_as_of stamps the "(valid: DATE)" zone header.

alter table public.synthesis_section
  add column if not exists support_links jsonb,
  add column if not exists support_links_valid_as_of date;

comment on column public.synthesis_section.support_links is
  'Curated supporting links (~6) for this section from engine returns — NOT verified/frozen, perishable. jsonb array of {url, title?}. Domain derived at render. The promotion "waiting room" (Eames c639a489 section-foot links).';
comment on column public.synthesis_section.support_links_valid_as_of is
  'As-of date the supporting links were curated/checked; rendered once as the zone header "(valid: DATE)".';

-- Per-section GROUNDED SOURCES: the distinct anchored facts a section's claims rest on
-- (synthesis_claim.section_id -> element_dependency claim_on_fact -> ground_fact). Same spine the
-- per-section confidence walks; here it surfaces the facts themselves for the section-foot grounded zone.
create or replace view public.render_section_fact_v1 as
select distinct
  ss.id as section_id, ss.synthesis_id,
  gf.ground_fact_id, gf.title, gf.authority_tier, gf.contestability,
  gf.verification_state, gf.review_state, gf.screenshot_url, gf.archive_url,
  gf.source_url, gf.content_hash, gf.in_conflict
from synthesis_section ss
join synthesis_claim sc on sc.section_id = ss.id
join element_dependency ed on ed.dependent_synthesis_claim_id = sc.id
  and ed.edge_kind = 'claim_on_fact' and ed.depends_on_ground_fact_id is not null
join render_ground_fact_v1 gf on gf.ground_fact_id = ed.depends_on_ground_fact_id;
