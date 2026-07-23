-- C11 — LINK VERIFICATION PASS (Napoleon 03df2aae; plan SP d7d1a532).
-- VERIFIED != GROUNDED: verification is a CHEAP, POINT-IN-TIME fact — "this link resolved at
-- verified_at and bore on the question". Links may die later; the verification stays true.
-- Grounding (freeze/hash/anchor) is reserved for the load-bearing subset and is NOT this table.
-- One row per (engine_dispatch, normalized_url): the same URL returned by three engines is three
-- rows — that attribution IS the per-engine quality signal. Verification work is deduped per
-- distinct URL by the EF; the verdict is copied to every row that cites it.

create table if not exists link_verification (
  id uuid primary key default gen_random_uuid(),
  theo_session_id uuid not null references theo_session(id),
  engine_dispatch_id uuid not null references engine_dispatch(id),
  engine_name text not null,               -- denormalized: stable, and the quality view groups on it
  question_id uuid references research_question(id),
  url text not null,                       -- as returned by the engine (post trailing-punct trim)
  normalized_url text not null,            -- dedup key: lowercased host, no fragment, no tracking params
  verdict text not null default 'pending'
    check (verdict in ('pending','usable','dead','junk','irrelevant','error')),
  junk_class text
    check (junk_class in ('consent_wall','paywall','login_gate','soft_404','empty_shell','other')),
  http_status int,
  final_url text,                          -- after redirects — a consent-wall redirect is evidence
  content_type text,
  text_length int,                         -- chars of stripped text, the junk/emptiness denominator
  -- C12 advance party: index/landing-page suspicion is CONTENT-based (link density, prose ratio,
  -- list structure), never URL-pattern-based (Napoleon's false-positive warning). A flag, not a
  -- verdict — an index page can be genuinely relevant; it just must not anchor a claim.
  index_suspect boolean not null default false,
  index_signals jsonb,
  relevance_note text,                     -- the bounded model judgment's one-line justification
  relevance_model text,
  verify_error text,
  attempts int not null default 0,
  verified_at timestamptz,                 -- THE point-in-time stamp the whole model rests on
  created_at timestamptz not null default now(),
  unique (engine_dispatch_id, normalized_url)
);

create index if not exists link_verification_session_verdict_idx on link_verification (theo_session_id, verdict);
create index if not exists link_verification_norm_url_idx on link_verification (normalized_url);

-- House norm: RLS deny-all, zero policies — all writes via the service-role EF
-- (link-verification-pass). Primes read via execute_sql at service level.
alter table link_verification enable row level security;

-- (b) THE QUALITY SIGNAL PER ENGINE — which dispatcher returns junk, which returns gold.
create or replace view link_quality_by_engine as
select
  theo_session_id,
  engine_name,
  count(*) as links,
  count(*) filter (where verdict = 'usable')     as usable,
  count(*) filter (where verdict = 'dead')       as dead,
  count(*) filter (where verdict = 'junk')       as junk,
  count(*) filter (where verdict = 'irrelevant') as irrelevant,
  count(*) filter (where verdict = 'error')      as error,
  count(*) filter (where verdict = 'pending')    as pending,
  round(100.0 * count(*) filter (where verdict = 'usable')
        / nullif(count(*) filter (where verdict <> 'pending'), 0), 1) as usable_pct,
  count(*) filter (where index_suspect) as index_suspects
from link_verification
group by theo_session_id, engine_name;

-- (c) THE RE-DISPATCH TRIGGER'S INPUT — per-dispatch/question verified-usable counts. The floor
-- policy (verified below N => the dispatch FAILED, re-dispatch) belongs to the Conductor (C4);
-- this view is the fact it will read.
create or replace view dispatch_verified_counts as
select
  theo_session_id,
  engine_dispatch_id,
  engine_name,
  question_id,
  count(*)                                    as links,
  count(*) filter (where verdict <> 'pending') as examined,
  count(*) filter (where verdict = 'usable')   as usable,
  count(*) filter (where index_suspect)        as index_suspects
from link_verification
group by theo_session_id, engine_dispatch_id, engine_name, question_id;

-- Views are owner-executed: revoke client roles so the pool is substrate/service-queryable only
-- (curation surfaces read through service-role EFs, per the sealed-tables norm).
revoke all on link_quality_by_engine from anon, authenticated;
revoke all on dispatch_verified_counts from anon, authenticated;
revoke all on link_verification from anon, authenticated;
