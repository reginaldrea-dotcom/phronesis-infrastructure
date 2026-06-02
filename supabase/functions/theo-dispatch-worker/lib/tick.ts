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
  releaseSession,
  sessionStatusCounts,
  updateSessionState,
} from "./queue.ts";
import type { AdapterResponse, Role } from "./types.ts";
import { engineConfig, pollStalenessMs } from "./config.ts";
import { canSubmit, recordUsage } from "./pacing.ts";
import { submitAdapter, pollAdapter } from "./adapters/index.ts";
import { fileSessionWakeDelta } from "./wake.ts";
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
  rows_paced_off: number;       // rate-budget exhausted, deferred to next tick
  rows_stale_failed: number;    // poll-staleness ceiling hit
}

const THEO_LINEAGE = "theophrastus";

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
  };

  for (const session of sessions) {
    const claimed = await claimSession(supabase, session.id, workerInstanceId);
    if (!claimed) continue;
    summary.sessions_claimed++;

    try {
      const rows = await findRowsForSession(supabase, session.id);

      // ── Submit pending rows ────────────────────────────────────────────
      for (const row of rows.filter(r => r.status === "pending")) {
        await handlePending(supabase, row, summary);
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
        await fileSessionWakeDelta(supabase, {
          to_lineage: THEO_LINEAGE,
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
): Promise<void> {
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
    await finalizeResponse(supabase, row.id, result.response, "pending", summary);
    return;
  }
  if (result.ok && !result.done) {
    summary.rows_submitted++;
    await markDispatched(supabase, row.id, result.job_ref);
    return;
  }
  // ok:false
  if (result.error.retryable) {
    // Provider rejected (e.g. 429); leave row 'pending' for the next tick. Don't
    // count as "submitted progressed" — it's effectively paced off by the provider.
    summary.rows_paced_off++;
    return;
  }
  summary.rows_submitted++;
  await markFailed(supabase, row.id, `${result.error.kind}: ${result.error.message}`, "pending");
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
      await finalizeResponse(supabase, row.id, result.response, "dispatched", summary);
      return;
    case "partial":
      await markPartial(supabase, row.id, {
        response_raw: JSON.stringify(result.response),
        reason: result.reason,
        tokens_in: result.response.usage.input_tokens,
        tokens_out: result.response.usage.output_tokens,
      }, "dispatched");
      summary.rows_partial++;
      return;
    case "failed":
      await markFailed(supabase, row.id, `${result.error.kind}: ${result.error.message}`, "dispatched");
      summary.rows_failed++;
      return;
  }
}

async function finalizeResponse(
  supabase: SupabaseClient,
  rowId: string,
  response: AdapterResponse,
  expectedStatus: "pending" | "dispatched",
  summary: TickSummary,
): Promise<void> {
  const partial = response.labels.some(l => l.key === "partial" && l.value === "true");
  if (partial) {
    await markPartial(supabase, rowId, {
      response_raw: JSON.stringify(response),
      reason: response.labels.find(l => l.key === "stop_reason")?.value ?? "max_tokens",
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
    }, expectedStatus);
    summary.rows_partial++;
    return;
  }
  await markCompleted(supabase, rowId, {
    response_raw: JSON.stringify(response),
    tokens_in: response.usage.input_tokens,
    tokens_out: response.usage.output_tokens,
  }, expectedStatus);
  summary.rows_completed++;
}
