// One tick of dispatch work. Called by the EF entry point on each cron fire.
//
// Per tick:
//   1. Resolve worker instance_id (auto-register if first run).
//   2. Find theo_session rows in state='dispatched' that are unlocked OR locked by us.
//   3. For each session: claim it via claim_theo_session(); if claim succeeds:
//        a. Find engine_dispatch rows in status pending/dispatched.
//        b. For pending rows: check rate budget; if ok, submit.
//             - sync done:true       -> mark completed (or partial if label flagged)
//             - async done:false     -> mark dispatched + provider_job_ref + dispatched_at
//             - ok:false             -> mark failed (unless retryable; then leave for next tick)
//             - record provider_rate_limit usage on every actual submit
//        c. For dispatched rows: check staleness; if exceeded, mark failed; else poll.
//             - in_progress -> leave as-is
//             - completed/partial -> mark accordingly
//             - failed -> mark failed
//        d. After processing rows: if no rows remain in flight, transition
//           theo_session.state ('comparing' if any success, else 'failed') AND
//           file a completion wake_delta to theo.
//        e. Release the lock.

import type { SupabaseClient } from "./supabase.ts";
import type { EngineDispatchRow } from "./queue.ts";
import {
  claimSession,
  findDispatchableSessions,
  findRowsForSession,
  markCompleted,
  markDispatched,
  markFailed,
  markPartial,
  recordSubmitAttempt,
  releaseSession,
  sessionStatusCounts,
  updateSessionState,
} from "./queue.ts";
import type { AdapterResponse, Role } from "./types.ts";
import { engineConfig, pollStalenessMs, MAX_SUBMIT_ATTEMPTS, submitBackoffMs } from "./config.ts";
import { canSubmit, recordUsage } from "./pacing.ts";
import { getBudgetStatus, computeCostUsd, type BudgetStatus } from "./budget.ts";
import { submitAdapter, pollAdapter } from "./adapters/index.ts";
import { fileSessionWakeDelta, resolveOwnerLineage } from "./wake.ts";
import { resolveWorkerInstanceId } from "./instance.ts";

export interface TickSummary {
  worker_instance_id: string;
  sessions_seen: number;
  sessions_claimed: number;
  sessions_completed: number;
  rows_submitted: number;
  rows_polled: number;
  rows_completed: number;
  rows_partial: number;
  rows_failed: number;
  rows_paced_off: number;       // rate-budget exhausted / backing off, deferred to next tick
  rows_stale_failed: number;    // poll-staleness ceiling hit
  rows_retry_exhausted: number; // submit retry ceiling hit -> failed terminally (was: hung forever)
  rows_budget_blocked: number;  // spend ceiling / pause flag — submit deferred this tick
  submits_blocked: boolean;     // tick-level: were submits gated by the spend guard?
  spend_today_usd: number;      // observability: today's recorded spend at tick start
  budget_limit_usd: number;     // observability: the ceiling in force
}

const THEO_LINEAGE = "theophrastus";
const WORKER_LINEAGE = "theo-dispatch-worker";

export async function tick(supabase: SupabaseClient): Promise<TickSummary> {
  const workerInstanceId = await resolveWorkerInstanceId(supabase);
  const sessions = await findDispatchableSessions(supabase, workerInstanceId);

  const summary: TickSummary = {
    worker_instance_id: workerInstanceId,
    sessions_seen: sessions.length,
    sessions_claimed: 0,
    sessions_completed: 0,
    rows_submitted: 0,
    rows_polled: 0,
    rows_completed: 0,
    rows_partial: 0,
    rows_failed: 0,
    rows_paced_off: 0,
    rows_stale_failed: 0,
    rows_retry_exhausted: 0,
    rows_budget_blocked: 0,
    submits_blocked: false,
    spend_today_usd: 0,
    budget_limit_usd: 0,
  };

  // Spend guard — evaluated ONCE per tick. Gates submits only; polls always run.
  const budget = await getBudgetStatus(supabase);
  summary.submits_blocked = budget.block_submits;
  summary.spend_today_usd = budget.spent_usd;
  summary.budget_limit_usd = budget.limit_usd;
  if (budget.block_submits) {
    console.warn(
      `spend guard: submits blocked (${budget.reason}); ` +
      `spent $${budget.spent_usd.toFixed(4)} / $${budget.limit_usd.toFixed(2)} today` +
      (budget.note ? ` — note: ${budget.note}` : ""),
    );
    await fileBudgetAlertOnce(supabase, budget).catch(e => console.error("fileBudgetAlertOnce", e));
  }

  for (const session of sessions) {
    const claimed = await claimSession(supabase, session.id, workerInstanceId);
    if (!claimed) continue;
    summary.sessions_claimed++;

    try {
      const rows = await findRowsForSession(supabase, session.id);

      // ── Submit pending rows ────────────────────────────────────────────
      for (const row of rows.filter(r => r.status === "pending")) {
        await handlePending(supabase, row, summary, budget.block_submits);
      }

      // ── Poll dispatched rows ───────────────────────────────────────────
      for (const row of rows.filter(r => r.status === "dispatched")) {
        await handleDispatched(supabase, row, summary);
      }

      // ── Session terminal? ──────────────────────────────────────────────
      const counts = await sessionStatusCounts(supabase, session.id);
      if (counts.remaining === 0) {
        const anySuccess = counts.completed + counts.partial > 0;
        const newState = anySuccess ? "comparing" : "failed";
        await updateSessionState(supabase, session.id, newState);
        // Route the completion delta to the session OWNER (the Prime that enqueued
        // it), not always Theo (baton 143072ab #5) — else an autonomous researcher
        // like Angelia never learns her own run finished.
        const ownerLineage = await resolveOwnerLineage(supabase, session.id);
        await fileSessionWakeDelta(supabase, {
          to_lineage: ownerLineage,
          theo_session_id: session.id,
          note: anySuccess
            ? `dispatch complete: ${counts.completed} completed, ${counts.partial} partial, ${counts.failed} failed`
            : `dispatch failed: all ${counts.failed} engines failed`,
        });
        summary.sessions_completed++;
      }
    } catch (err) {
      console.error("tick: session error", session.id, err);
    } finally {
      await releaseSession(supabase, session.id).catch(e => console.error("releaseSession", e));
    }
  }

  return summary;
}

async function handlePending(
  supabase: SupabaseClient,
  row: EngineDispatchRow,
  summary: TickSummary,
  submitsBlocked: boolean,
): Promise<void> {
  // Spend guard — defer the submit (leave 'pending') without touching the
  // provider. Picked up on a later tick once spend resets / pause lifts.
  if (submitsBlocked) {
    summary.rows_budget_blocked++;
    return;
  }
  if (!row.prompt_sent) {
    await markFailed(supabase, row.id, "no prompt_sent on row at submit time", "pending");
    summary.rows_failed++;
    return;
  }
  let cfg;
  try {
    cfg = engineConfig(row.engine_name);
  } catch (e) {
    await markFailed(supabase, row.id, `unknown engine: ${row.engine_name}`, "pending");
    summary.rows_failed++;
    return;
  }

  // Retry backoff (baton 143072ab #2) — if this row has already failed retryably,
  // wait out the exponential backoff window before touching the provider again.
  // Prevents hammering a throttled engine every tick (and burning rate budget on
  // a row we can't yet submit). attempts=0 => no wait, normal first submit.
  if (row.submit_attempts > 0 && row.last_attempt_at) {
    const sinceLastMs = Date.now() - new Date(row.last_attempt_at).getTime();
    if (sinceLastMs < submitBackoffMs(row.submit_attempts)) {
      summary.rows_paced_off++;
      return;  // still backing off; a later tick will retry.
    }
  }

  // Pacing — only PACE SUBMITS, polls are free.
  const decision = await canSubmit(supabase, row.engine_name);
  if (!decision.ok) {
    summary.rows_paced_off++;
    return;  // leave 'pending'; next tick may submit.
  }

  const result = await submitAdapter(row.engine_name, {
    prompt: row.prompt_sent,
    role: row.role_in_dispatch as Role,
  });

  // Record provider_rate_limit usage on every submit attempt that reached the
  // provider (counts the 429 too — the request landed and consumed a slot).
  const usageTokens = result.ok && result.done
    ? { input_tokens: result.response.usage.input_tokens ?? 0, output_tokens: result.response.usage.output_tokens ?? 0 }
    : { input_tokens: 0, output_tokens: 0 };
  await recordUsage(supabase, cfg, usageTokens).catch(e => console.error("recordUsage", e));

  if (result.ok && result.done) {
    summary.rows_submitted++;
    await finalizeResponse(supabase, row.id, row.engine_name, result.response, "pending", summary);
    return;
  }
  if (result.ok && !result.done) {
    summary.rows_submitted++;
    await markDispatched(supabase, row.id, result.job_ref);
    return;
  }
  // ok:false
  if (result.error.retryable) {
    // Provider rejected retryably (e.g. 429). Bound the retries (baton 143072ab #2):
    // bump the attempt counter, and once the ceiling is hit, fail the row TERMINALLY
    // so a persistently-throttled engine can no longer hang the session forever.
    const attempts = row.submit_attempts + 1;
    if (attempts >= MAX_SUBMIT_ATTEMPTS) {
      await markFailed(
        supabase,
        row.id,
        `submit retry ceiling: ${attempts} retryable failures; last ${result.error.kind}: ${result.error.message}`,
        "pending",
        result.error.raw,
      );
      summary.rows_retry_exhausted++;
      summary.rows_failed++;
      return;
    }
    // Under the ceiling: record the attempt (drives backoff) and leave 'pending'.
    await recordSubmitAttempt(supabase, row.id, attempts).catch(e => console.error("recordSubmitAttempt", e));
    summary.rows_paced_off++;
    return;
  }
  summary.rows_submitted++;
  await markFailed(supabase, row.id, `${result.error.kind}: ${result.error.message}`, "pending", result.error.raw);
  summary.rows_failed++;
}

async function handleDispatched(
  supabase: SupabaseClient,
  row: EngineDispatchRow,
  summary: TickSummary,
): Promise<void> {
  // Staleness ceiling — protects against hung-poll bugs (e.g. Perplexity's IN_PROGRESS-forever case)
  const dispatchedAtMs = row.dispatched_at ? new Date(row.dispatched_at).getTime() : 0;
  const ageMs = Date.now() - dispatchedAtMs;
  const ceiling = pollStalenessMs(row.engine_name);
  if (dispatchedAtMs > 0 && ageMs > ceiling) {
    await markFailed(supabase, row.id, `poll staleness ceiling exceeded (${ageMs}ms > ${ceiling}ms)`, "dispatched");
    summary.rows_stale_failed++;
    summary.rows_failed++;
    return;
  }

  if (!row.provider_job_ref) {
    await markFailed(supabase, row.id, "dispatched row has no provider_job_ref", "dispatched");
    summary.rows_failed++;
    return;
  }

  const result = await pollAdapter(row.engine_name, row.provider_job_ref);
  summary.rows_polled++;

  switch (result.status) {
    case "in_progress":
      return;
    case "completed":
      await finalizeResponse(supabase, row.id, row.engine_name, result.response, "dispatched", summary);
      return;
    case "partial":
      await markPartial(supabase, row.id, {
        response_raw: JSON.stringify(result.response),
        reason: result.reason,
        tokens_in: result.response.usage.input_tokens,
        tokens_out: result.response.usage.output_tokens,
        cost_usd: computeCostUsd(row.engine_name, result.response.usage) ?? undefined,
      }, "dispatched");
      summary.rows_partial++;
      return;
    case "failed":
      await markFailed(supabase, row.id, `${result.error.kind}: ${result.error.message}`, "dispatched", result.error.raw);
      summary.rows_failed++;
      return;
  }
}

async function finalizeResponse(
  supabase: SupabaseClient,
  rowId: string,
  engineName: string,
  response: AdapterResponse,
  expectedStatus: "pending" | "dispatched",
  summary: TickSummary,
): Promise<void> {
  // Persist estimated cost for BOTH sync and async finalisations — this is the
  // only place engine_dispatch.cost_usd gets written, and the spend guard sums it.
  const costUsd = computeCostUsd(engineName, response.usage) ?? undefined;
  const partial = response.labels.some(l => l.key === "partial" && l.value === "true");
  if (partial) {
    await markPartial(supabase, rowId, {
      response_raw: JSON.stringify(response),
      reason: response.labels.find(l => l.key === "stop_reason")?.value ?? "max_tokens",
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
      cost_usd: costUsd,
    }, expectedStatus);
    summary.rows_partial++;
    return;
  }
  await markCompleted(supabase, rowId, {
    response_raw: JSON.stringify(response),
    tokens_in: response.usage.input_tokens,
    tokens_out: response.usage.output_tokens,
    cost_usd: costUsd,
  }, expectedStatus);
  summary.rows_completed++;
}

// File a single budget/pause alert per UTC day to Theo's lineage so the block is
// visible in read_wake_deltas, without spamming one on every blocked tick.
async function fileBudgetAlertOnce(
  supabase: SupabaseClient,
  budget: BudgetStatus,
): Promise<void> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const existing = await supabase
    .from("wake_deltas")
    .select("id")
    .eq("to_lineage", THEO_LINEAGE)
    .is("consumed_at", null)
    .ilike("note", "spend guard:%")
    .gte("created_at", dayStart.toISOString())
    .limit(1)
    .maybeSingle();
  if (existing.data?.id) return;  // already alerted today

  await supabase.from("wake_deltas").insert({
    to_lineage: THEO_LINEAGE,
    from_lineage: WORKER_LINEAGE,
    note:
      `spend guard: submits blocked (${budget.reason}) — ` +
      `spent $${budget.spent_usd.toFixed(2)} / $${budget.limit_usd.toFixed(2)} today` +
      (budget.note ? ` [${budget.note}]` : ""),
    // ref_type/ref_id intentionally null (both-or-neither CHECK) — this alert is
    // worker-global, not scoped to one theo_session.
  });
}
