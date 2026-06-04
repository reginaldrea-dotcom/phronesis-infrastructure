-- ============================================================================
-- Phase-1 — worker_control: operator switch for theo-dispatch-worker
-- ----------------------------------------------------------------------------
-- DRAFT FOR REVIEW. Do NOT apply without Connie + Reg sign-off (DDL lane,
-- per DR_CC_2026-06-02_Phase0Recovery_D4 §7.6).
--
-- Backs the spend guard in lib/budget.ts. Singleton row (id always true). The
-- worker reads it once per tick:
--   * paused=true        -> blocks all SUBMITS this tick (polls still run).
--   * daily_budget_usd   -> overrides the env/default ceiling at runtime, no
--                           redeploy. NULL => use WORKER_DAILY_BUDGET_USD / 25.
-- The worker writes via the service-role key (RLS-bypassing); RLS is sealed
-- deny-all, same posture as synthesis_section.
-- ============================================================================

create table if not exists worker_control (
  id               boolean primary key default true check (id),  -- enforce a single row
  paused           boolean     not null default false,
  daily_budget_usd numeric,                                      -- null => env/default ceiling
  note             text,                                         -- operator note (surfaced in the alert)
  updated_at       timestamptz not null default now()
);

-- Seed the singleton (no-op on re-run).
insert into worker_control (id) values (true)
on conflict (id) do nothing;

-- Service-role-only access (worker bypasses RLS). No end-user policies.
alter table worker_control enable row level security;

-- ----------------------------------------------------------------------------
-- Operator controls (run as needed, service role):
--   -- pause the worker's submits (kill switch):
--   update worker_control set paused = true,  note = 'manual hold', updated_at = now() where id;
--   -- resume:
--   update worker_control set paused = false, note = null,          updated_at = now() where id;
--   -- set/clear the daily USD ceiling:
--   update worker_control set daily_budget_usd = 50,   updated_at = now() where id;
--   update worker_control set daily_budget_usd = null, updated_at = now() where id;  -- back to env/default
--   -- inspect:
--   select * from worker_control;
--   -- today's spend the guard sees:
--   select coalesce(sum(cost_usd),0) as spent_today_usd
--     from engine_dispatch
--    where cost_usd is not null and response_received_at >= date_trunc('day', now() at time zone 'utc');
--
-- ROLLBACK:
--   drop table if exists worker_control;
-- ============================================================================
