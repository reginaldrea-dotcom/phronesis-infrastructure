-- Grounding queue + worker (Heph; Reg-approved 13 Jul). Decouples claim PRODUCTION (Theo, bursts of ~45)
-- from claim GROUNDING (paced, judgment-in-the-loop, 1-2 at a time). Fixes the Angelia freeze: grounding a
-- batch synchronously blew the ~150s EF ceiling, left no trace, and a resume replayed a stale session.
--
-- SHAPE (modelled on theo-dispatch-worker): Theo ENQUEUES claims (instant data write); a cron-ticked
-- grounding-worker drains the queue a couple of claims per tick, invoking Angelia per claim for the
-- judgment, and records the outcome. Timeout-proof (bounded ticks), durable (nothing lost), resumable
-- (reaper), observable (progress view), burst-tolerant (the queue absorbs the burst).
--
-- v1 SCOPE (Reg decision 3): grounds claims whose supporting source is ALREADY FROZEN. A claim that needs
-- a new capture is parked 'awaiting_capture' (Phase 2 wires the capture loop). Reasoner = Angelia invoked
-- per claim (decision 2). Drain = 2 claims/tick ~60s (decision 1). Failed claims route to Theo (decision 4).

create table if not exists public.grounding_queue (
  id            uuid primary key default gen_random_uuid(),
  claim_id      uuid not null references public.synthesis_claim(id) on delete cascade,
  synthesis_id  uuid,                                  -- scope for batching + progress
  state         text not null default 'pending'
                  check (state in ('pending','grounding','awaiting_capture','grounded','failed','skipped')),
  priority      int  not null default 100,
  attempts      int  not null default 0,
  max_attempts  int  not null default 3,
  source_hint   jsonb,                                 -- optional URL/instruction Theo passes
  capture_ref   uuid,                                  -- source it is waiting to freeze (Phase 2)
  last_error    text,
  claimed_at    timestamptz,                           -- reaper anchor
  claimed_by    text,                                  -- tick id
  enqueued_by   text not null default 'theophrastus',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  grounded_at   timestamptz,
  unique (claim_id)                                    -- idempotent enqueue: one live row per claim
);

create index if not exists grounding_queue_pending_idx
  on public.grounding_queue (priority, created_at) where state = 'pending';
create index if not exists grounding_queue_synthesis_idx on public.grounding_queue (synthesis_id);

comment on table public.grounding_queue is
  'Durable work-list decoupling claim production (Theo) from paced grounding (worker+Angelia). Baton: grounding-queue, Heph 13 Jul.';

-- RLS deny-all (house pattern): only the service-role worker + SECURITY DEFINER RPCs touch it.
alter table public.grounding_queue enable row level security;

-- ENQUEUE (Theo's contract). Idempotent bulk insert; re-enqueueing a claim is a no-op. Instant data write,
-- no 150s exposure. Auto-fills synthesis_id from the claim. Returns how many NEW rows were queued.
create or replace function public.enqueue_claims_for_grounding(
  p_claim_ids   uuid[],
  p_source_hints jsonb default null,   -- optional map { claim_id_text: hint }
  p_priority    int default 100,
  p_enqueued_by text default 'theophrastus'
) returns integer
  language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare v_inserted integer;
begin
  if p_claim_ids is null or array_length(p_claim_ids,1) is null then return 0; end if;
  insert into public.grounding_queue (claim_id, synthesis_id, priority, source_hint, enqueued_by)
  select c.id, c.synthesis_id, coalesce(p_priority,100),
         case when p_source_hints ? c.id::text then p_source_hints -> c.id::text else null end,
         coalesce(p_enqueued_by,'theophrastus')
  from public.synthesis_claim c
  where c.id = any(p_claim_ids)
  on conflict (claim_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end $$;

comment on function public.enqueue_claims_for_grounding is
  'Theo-facing enqueue: idempotent bulk insert of claims for grounding. Send the whole set; the worker paces the drain.';

-- REAP: reset rows stranded in 'grounding' past a timeout back to 'pending' (attempts already counted at
-- claim). The generalised fix for the stranded-request class: a tick that dies mid-claim self-heals.
create or replace function public.grounding_reap(p_stale_minutes int default 5)
  returns integer
  language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare v_reaped integer;
begin
  update public.grounding_queue
     set state='pending', claimed_at=null, claimed_by=null, updated_at=now()
   where state='grounding' and claimed_at < now() - make_interval(mins => greatest(p_stale_minutes,1));
  get diagnostics v_reaped = row_count;
  return v_reaped;
end $$;

-- CLAIM ONE: atomically take the next pending row (FOR UPDATE SKIP LOCKED so overlapping ticks are safe),
-- flip to 'grounding', increment attempts, stamp the tick. Returns the claimed row, or no rows if empty.
create or replace function public.grounding_claim_one(p_tick_id text)
  returns public.grounding_queue
  language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare v_row public.grounding_queue;
begin
  update public.grounding_queue q
     set state='grounding', claimed_at=now(), claimed_by=p_tick_id, attempts=q.attempts+1, updated_at=now()
   where q.id = (
     select id from public.grounding_queue
      where state='pending' order by priority, created_at
      for update skip locked limit 1
   )
  returning q.* into v_row;
  return v_row;  -- composite is null if nothing claimed
end $$;

-- MARK: set the terminal/next state after a grounding attempt.
create or replace function public.grounding_mark(
  p_id uuid, p_state text, p_error text default null, p_capture_ref uuid default null
) returns void
  language plpgsql security definer set search_path to 'public','pg_temp'
as $$
begin
  update public.grounding_queue
     set state = p_state,
         last_error = p_error,
         capture_ref = coalesce(p_capture_ref, capture_ref),
         grounded_at = case when p_state='grounded' then now() else grounded_at end,
         claimed_at = case when p_state in ('grounding','awaiting_capture') then claimed_at else null end,
         updated_at = now()
   where id = p_id;
end $$;

-- PROGRESS: per-synthesis drain state for observability (Reg / Argos / Theo).
create or replace view public.grounding_progress as
  select synthesis_id,
         count(*) filter (where state='pending')          as pending,
         count(*) filter (where state='grounding')         as grounding,
         count(*) filter (where state='awaiting_capture')  as awaiting_capture,
         count(*) filter (where state='grounded')          as grounded,
         count(*) filter (where state='failed')            as failed,
         count(*) filter (where state='skipped')           as skipped,
         count(*)                                          as total,
         max(updated_at)                                   as last_activity
    from public.grounding_queue
   group by synthesis_id;
