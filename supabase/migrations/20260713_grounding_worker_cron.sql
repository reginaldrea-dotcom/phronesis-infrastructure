-- ============================================================================
-- pg_cron drainer for grounding-worker
-- ----------------------------------------------------------------------------
-- APPLIED 21 Jul 2026 (Reg greenlit; Connie signed off per the DDL+secrets lane, msg 3b5d3937).
-- Live as cron.job jobid 3 'grounding-worker-tick'. Verified: correct worker key -> 200 tick summary;
-- wrong key -> 401 self-guard. Mirrors 20260603_phase1_theo_dispatch_worker_cron.sql.
--
-- Purpose: tick grounding-worker on a fixed cadence so it auto-drains
-- grounding_queue rows in state='pending' (2 claims/tick, Reg decision 1),
-- instead of being fired by hand. The worker validates the apikey itself
-- (functions/grounding-worker/lib/auth.ts) against WORKER_INVOKE_KEY.
--
-- REUSES the EXISTING secret: grounding-worker's WORKER_INVOKE_KEY is the SAME
-- project secret theo-dispatch-worker already uses, so the SAME Vault entry
-- (theo_worker_invoke_token) works. No new secret to provision. Confirm before
-- apply that WORKER_INVOKE_KEY is set for the grounding-worker function env
-- (it is a project-wide secret, so it already is if theo's is).
--
-- CONFIRM IN REVIEW with one manual invoke:
--   * a call WITH the correct apikey returns 200 (tick summary);
--   * a call WITHOUT it (or wrong) returns 401 from the worker's self-guard.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_jobname text := 'grounding-worker-tick';
begin
  if exists (select 1 from cron.job where jobname = v_jobname) then
    perform cron.unschedule(v_jobname);
  end if;

  perform cron.schedule(
    v_jobname,
    -- Every minute. Drain rate = MAX_PER_TICK (2) x this cadence. Overlapping ticks are SAFE: the worker
    -- claims each row via grounding_claim_one() (FOR UPDATE SKIP LOCKED) before working it.
    '* * * * *',
    $cmd$
      select net.http_post(
        url     := 'https://vysenpymsfhgionqfulf.supabase.co/functions/v1/grounding-worker',
        body    := '{}'::jsonb,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'theo_worker_invoke_token'
          )
        ),
        timeout_milliseconds := 150000
      );
    $cmd$
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Verification (after apply):
--   select jobid, jobname, schedule, active from cron.job where jobname='grounding-worker-tick';
--   select status, return_message, start_time, end_time from cron.job_run_details
--     where jobid=(select jobid from cron.job where jobname='grounding-worker-tick')
--     order by start_time desc limit 5;
--
-- KILL SWITCH:  select cron.unschedule('grounding-worker-tick');
-- ============================================================================
