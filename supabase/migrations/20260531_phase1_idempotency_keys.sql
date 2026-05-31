-- Phase 1 / D3 — request-level idempotency store (Conference 1b638657).
-- Applied to vysenpymsfhgionqfulf via apply_migration (31 May 2026); kept here for
-- version control. Service-role only (RLS on, no policies — the EF bypasses it).
create table if not exists public.idempotency_keys (
  request_id  text primary key,
  status      text not null default 'in_progress',   -- 'in_progress' | 'done'
  status_code integer,
  response    text,                                   -- verbatim response body, for replay
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.idempotency_keys enable row level security;
