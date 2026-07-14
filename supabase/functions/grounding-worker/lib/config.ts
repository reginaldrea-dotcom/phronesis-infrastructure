// grounding-worker configuration.

// Fail-at-boot if missing (worker cannot function).
export const REQUIRED_ENV = ["SUPABASE_URL", "THEO_DISPATCH_SECRET_KEY", "WORKER_INVOKE_KEY"] as const;
// Warn at boot; only fatal when actually used.
export const EXPECTED_ENV: readonly string[] = [];

// Drain rate. ONE claim per tick: in capture mode each claim's Angelia invocation runs a live
// render/screenshot/freeze (tens of seconds to ~2min), so 2/tick could exceed the worker's OWN ~150s EF wall
// and (via re-claim of a just-failed row) waste a slot. One claim/tick keeps every tick safely bounded; the
// cron cadence sets throughput. (Reg decision 1 was 2/tick for the frozen-only case; capture mode needs 1.)
export const MAX_PER_TICK = 1;
// A tick that dies mid-claim leaves the row 'grounding'; the reaper resets it after this long.
export const STALE_MINUTES = 5;
// Stop claiming new work once a tick has run this long, so it never races the ~150s gateway wall.
export const TICK_BUDGET_MS = 120_000;

// The grounding reasoner is Angelia, invoked once per claim (decision 2) through the Prime EF.
export const PRIME_INVOKE_URL = "https://vysenpymsfhgionqfulf.supabase.co/functions/v1/api-prime-invoke";
export const GROUNDING_LINEAGE = "angelia";
// Bound each per-claim invocation so one claim + tick overhead stays under the worker's OWN ~150s EF wall.
export const PRIME_INVOKE_TIMEOUT_MS = 120_000;
