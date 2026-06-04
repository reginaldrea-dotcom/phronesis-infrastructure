-- ============================================================================
-- Phase-1 — pg_cron drainer for theo-dispatch-worker
-- ----------------------------------------------------------------------------
-- DRAFT FOR REVIEW. Do NOT apply without Connie + Reg sign-off (DDL + secrets
-- are the Connie/Reg lane per DR_CC_2026-06-02_Phase0Recovery_D4 §7.6).
--
-- Purpose: schedule the worker so it auto-drains `theo_session` rows in
-- state='dispatched' on a fixed cadence, instead of being fired by hand. This
-- is the mechanism the architecture already assumes (DR §5). Theo never holds
-- or handles the invocation token; the schedule owns it.
--
-- The worker (EF `theo-dispatch-worker`, verify_jwt=FALSE) uses its OWN env
-- SUPABASE_SERVICE_ROLE_KEY for all DB work. The caller's secret is used ONLY as
-- the worker's door lock — the worker never acts on the caller's behalf. Because
-- verify_jwt is off, the platform does not guard the endpoint; the worker
-- validates this secret itself (functions/theo-dispatch-worker/lib/auth.ts),
-- constant-time comparing the `apikey` header to its WORKER_INVOKE_KEY env.
--
-- ============================================================================
-- PREREQUISITES — run ONCE, manually, out of band (NOT part of this migration;
-- the secret must never live in a committed file or in cron.job.command):
--
--   1. Store the invoke secret in Vault for the cron caller:
--        SELECT vault.create_secret(
--          '<PASTE_SECRET_HERE>',        -- see "Secret choice" below
--          'theo_worker_invoke_token',
--          'apikey secret used by the pg_cron drainer to invoke theo-dispatch-worker'
--        );
--   2. Set the SAME value as the worker's env secret so its self-guard matches:
--        supabase secrets set WORKER_INVOKE_KEY='<SAME_SECRET>' \
--          --project-ref vysenpymsfhgionqfulf
--      (By hand / CLI — never commit it. The worker fails to boot without it.)
--
-- Secret choice (review decision):
--   RECOMMENDED: the project SECRET key (sb_secret_…). Two reasons. (a) With
--   verify_jwt off, the gateway may still require a valid project apikey to route
--   to the function; a real secret key satisfies that AND the worker's own check,
--   whereas a dedicated random string could be refused at the gateway. (b) It is
--   the key Reg already manages, so there is one secret to rotate, not two.
--   EXPOSURE NOTE: the apikey travels in the request headers pg_net records in
--   net._http_response (privileged-only schema) — see the FOLLOW-UP on pruning it
--   so the secret does not accumulate in history indefinitely.
--
-- CONFIRM IN REVIEW with one manual invoke before relying on the schedule:
--   * a call WITH the correct apikey returns 200 (tick summary);
--   * a call WITHOUT it (or wrong) returns 401 from the worker's self-guard.
-- ============================================================================

-- Extensions are already installed on this project; these are idempotent and
-- document the dependency for a clone build.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ----------------------------------------------------------------------------
-- Schedule (re-runnable): unschedule any prior job of this name, then schedule.
-- ----------------------------------------------------------------------------
do $$
declare
  v_jobname text := 'theo-dispatch-worker-tick';
begin
  -- Idempotent re-run: drop the existing job if present.
  if exists (select 1 from cron.job where jobname = v_jobname) then
    perform cron.unschedule(v_jobname);
  end if;

  perform cron.schedule(
    v_jobname,
    -- Cadence. '* * * * *' = every minute (universally supported; conservative
    -- default for review). For the ~30s cadence in DR §5, replace with the
    -- interval form '30 seconds' (requires pg_cron >= 1.5). Overlapping ticks
    -- are SAFE: the worker claims each session via claim_theo_session() before
    -- working it, so a slow tick cannot be double-processed by the next.
    '* * * * *',
    $cmd$
      select net.http_post(
        url     := 'https://vysenpymsfhgionqfulf.supabase.co/functions/v1/theo-dispatch-worker',
        body    := '{}'::jsonb,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          -- Secret fetched at run time from Vault — the plaintext secret does NOT
          -- appear in cron.job.command, only this lookup does. Sent in `apikey`
          -- (the new-key model); the worker validates it in lib/auth.ts.
          'apikey', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'theo_worker_invoke_token'
          )
        ),
        -- pg_net is fire-and-forget; this bounds how long it waits for the
        -- worker's HTTP response before recording one. The worker still runs to
        -- completion server-side regardless. 150s matches the EF request wall.
        timeout_milliseconds := 150000
      );
    $cmd$
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Verification (run after apply; not part of the migration effect):
--   select jobid, jobname, schedule, active from cron.job
--    where jobname = 'theo-dispatch-worker-tick';
--   -- recent runs:
--   select status, return_message, start_time, end_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname='theo-dispatch-worker-tick')
--    order by start_time desc limit 5;
--   -- pg_net delivery (apikey is in headers here — net schema is privileged-only):
--   select id, status_code, created from net._http_response order by created desc limit 5;
--
-- ----------------------------------------------------------------------------
-- KILL SWITCH / ROLLBACK:
--   select cron.unschedule('theo-dispatch-worker-tick');
--   -- and, if retiring entirely:
--   -- select vault.delete_secret('theo_worker_invoke_token');  -- by name/id
--
-- ----------------------------------------------------------------------------
-- FOLLOW-UP (out of scope for this migration, tracked separately):
--   * Daily spend guard + a worker-checked pause flag. provider_rate_limit
--     paces SUBMITS per minute but does not cap total daily cost; a runaway or
--     mis-queued batch would still spend up to the per-minute ceiling each tick.
--   * Consider pruning net._http_response on a schedule so request headers
--     (which carry the invoke token) do not accumulate indefinitely.
-- ============================================================================
