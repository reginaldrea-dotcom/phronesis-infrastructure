-- Dispatch-worker hang-risk hardening (baton 143072ab, Theo findings #2 + #4 from
-- Angelia arc 1). Two latent session-hang paths, both closed structurally here:
--
--   #4 LOCK-RECLAIM (permanent strand). claim_theo_session() claimed only
--      WHERE locked_by_instance_id IS NULL, but the worker holds a STABLE
--      instance_id (resolved by name). A tick hard-killed mid-processing (e.g. a
--      redeploy) left the lock set with no release path, and no other tick could
--      ever re-claim it -> the session hung in 'dispatched' forever. Fix: a lock
--      LEASE. claim_theo_session now also reclaims a lock whose lease has expired
--      (or that predates this migration, locked_at IS NULL). The lease is set
--      comfortably above the EF's ~150s hard tick ceiling so a healthy in-flight
--      tick is never stolen from, while a dead holder's lock frees within minutes.
--
--   #2 UNBOUNDED RETRY (throttle hang). A 429 is retryable, so the worker left the
--      row 'pending' and re-submitted every tick with NO ceiling -> a persistently
--      throttled engine retried forever and the session never reached all-terminal.
--      Fix: per-row submit_attempts counter + last_attempt_at, so the worker can
--      (a) back off between retries instead of hammering, and (b) fail the row
--      terminally after a retry ceiling so the session can complete.
--
-- Additive and idempotent (IF NOT EXISTS / CREATE OR REPLACE). No backfill needed:
-- new columns default safely (locked_at NULL => reclaimable; submit_attempts 0).

-- ── #4: lock lease ──────────────────────────────────────────────────────────
ALTER TABLE theo_session
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

COMMENT ON COLUMN theo_session.locked_at IS
  'When locked_by_instance_id was last (re)claimed. Drives the dispatch-worker lock lease: a lock older than the lease is reclaimable (claim_theo_session). NULL => unlocked or a pre-lease legacy lock (treated as reclaimable).';

-- Drop the prior 2-arg signature: adding p_lease_seconds is a NEW overload, not a
-- replacement, and leaving both makes a 2-arg call ambiguous. Dropping it leaves the
-- 3-arg (defaulted) version to satisfy both 2-arg and 3-arg callers.
DROP FUNCTION IF EXISTS public.claim_theo_session(uuid, uuid);

-- p_lease_seconds default 300s (5 min): safely above the EF ~150s tick ceiling,
-- so an overlapping cron fire cannot steal a live lock, yet a hard-killed holder's
-- lock frees within minutes instead of stranding the session forever. The worker
-- passes its own lease value explicitly; the default is the fallback.
CREATE OR REPLACE FUNCTION public.claim_theo_session(
  p_session_id uuid,
  p_instance_id uuid,
  p_lease_seconds integer DEFAULT 300
)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE theo_session
     SET locked_by_instance_id = p_instance_id,
         locked_at = now()
   WHERE id = p_session_id
     AND (
       locked_by_instance_id IS NULL                                      -- free
       OR locked_at IS NULL                                              -- legacy lock, pre-lease
       OR locked_at < now() - make_interval(secs => p_lease_seconds)     -- lease expired (dead holder)
     );
  RETURN FOUND;
END;
$function$;

-- ── #2: bounded submit retry ─────────────────────────────────────────────────
ALTER TABLE engine_dispatch
  ADD COLUMN IF NOT EXISTS submit_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE engine_dispatch
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

COMMENT ON COLUMN engine_dispatch.submit_attempts IS
  'Count of retryable (e.g. 429) submit failures the worker has absorbed for this row. Drives exponential backoff and a terminal-fail ceiling so a throttled engine cannot hang the session.';
COMMENT ON COLUMN engine_dispatch.last_attempt_at IS
  'When the worker last attempted to submit this pending row. Used to space retries (backoff) so a throttled engine is not hammered every tick.';
