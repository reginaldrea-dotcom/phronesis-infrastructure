-- Evidence-capture verification + screenshot store (Heph, 7 Jul 2026).
--
-- The Angelia re-ground exposed that "anchored" meant only "we held some bytes", never "the bytes
-- contain the claim": raw-fetch HTML missed JS-rendered figures (ONS 171,000), 404/error pages were
-- frozen and badged anchored, and a wrong-document PDF passed. Fix (design settled with Theo, msgs
-- 1a9f0797 / a656ff1d): capture a RENDERED screenshot + rendered markdown + a Wayback archive, and
-- split "anchored" into two HONEST states by fact kind rather than one dishonest one:
--   * numeric      -> strict gate: ANCHORED only if HTTP 200 AND the canonical figure string is in the
--                     rendered markdown; else CITED-NOT-VERIFIED.
--   * qualitative  -> no string gate (a legal proposition has no grep-able proof); SCREENSHOT_REVIEW
--                     with a stored PNG + canonical quote, visibly flagged REQUIRES-HUMAN-REVIEW
--                     (Argos/Reg for load-bearing claims). Never a fake green anchor.
--
-- Screenshot/Wayback are per-URL (live on source_document.attestation, no DDL there). The canonical-
-- string MATCH is per-FACT (one URL can back a figure and a quote), so verification lives on ground_fact.
-- These columns are ADDITIVE + NULLABLE: Connie's write_ground_fact() contract is unchanged; the
-- write_ground_fact TOOL annotates the row post-insert with service role.

-- ── screenshot store ──────────────────────────────────────────────────────────────────────────────
-- Public read: the sources are public web pages and the Dossier is universal / PII-free by construction
-- (architecture 3f322400 §8). Writes are service-role only (no anon insert policy) by default.
insert into storage.buckets (id, name, public)
values ('evidence-captures', 'evidence-captures', true)
on conflict (id) do nothing;

-- ── per-fact verification state ─────────────────────────────────────────────────────────────────────
alter table public.ground_fact
  add column if not exists fact_kind          text,
  add column if not exists canonical_string   text,
  add column if not exists verification_state text not null default 'cited_not_verified',
  add column if not exists review_state       text not null default 'not_required',
  add column if not exists reviewed_by         text,
  add column if not exists reviewed_at         timestamptz;

comment on column public.ground_fact.fact_kind is
  'numeric | qualitative — chosen at mint; drives the verification gate (numeric = strict string match, qualitative = human review).';
comment on column public.ground_fact.canonical_string is
  'The load-bearing string: for numeric, the figure to match in the rendered capture; for qualitative, the shortest quote making the claim (what a human reviewer looks for in the screenshot).';
comment on column public.ground_fact.verification_state is
  'anchored (numeric, string present in rendered capture) | screenshot_review (qualitative, PNG stored, awaiting human) | cited_not_verified (capture failed or numeric string absent).';
comment on column public.ground_fact.review_state is
  'not_required (anchored/cited) | pending (screenshot_review awaiting review) | confirmed | rejected. Argos/Reg review for load-bearing qualitative claims.';

-- Constrain to the vocab (idempotent add).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ground_fact_fact_kind_chk') then
    alter table public.ground_fact add constraint ground_fact_fact_kind_chk
      check (fact_kind is null or fact_kind in ('numeric','qualitative'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ground_fact_verification_state_chk') then
    alter table public.ground_fact add constraint ground_fact_verification_state_chk
      check (verification_state in ('anchored','screenshot_review','cited_not_verified'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ground_fact_review_state_chk') then
    alter table public.ground_fact add constraint ground_fact_review_state_chk
      check (review_state in ('not_required','pending','confirmed','rejected'));
  end if;
end $$;
