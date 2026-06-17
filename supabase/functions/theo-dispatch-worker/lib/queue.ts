// Queue operations against theo_session + engine_dispatch.
//
// Status discipline (CHECK constraints — verified live):
//   engine_dispatch.status IN ('pending','dispatched','completed','partial','failed')
//   theo_session.state IN ('intake','refinement','awaiting_assent','dispatched',
//                          'comparing','synthesising','delivered','failed','cancelled')
//
// Worker only acts on theo_session.state='dispatched' and writes terminal
// engine_dispatch statuses. Session transitions to 'comparing' (any success)
// or 'failed' (all engines failed) when all engine_dispatch rows are terminal.
//
// All status updates use CAS-style WHERE guards (`AND status='<expected>'`) so
// a stale write can't trample a fresher one.

import type { SupabaseClient } from "./supabase.ts";
import { LOCK_LEASE_SECONDS } from "./config.ts";

export interface DispatchableSession {
  id: string;
  state: string;
  locked_by_instance_id: string | null;
}

export interface EngineDispatchRow {
  id: string;
  theo_session_id: string;
  engine_name: string;
  role_in_dispatch: string;
  prompt_sent: string | null;
  status: string;
  provider_job_ref: string | null;
  dispatched_at: string | null;
  submit_attempts: number;
  last_attempt_at: string | null;
}

export async function findDispatchableSessions(
  supabase: SupabaseClient,
  myInstanceId: string,
  limit = 20,
): Promise<DispatchableSession[]> {
  // Sessions in 'dispatched' state that are claimable: UNLOCKED, or RECLAIMABLE
  // (lock lease expired / a legacy lock with no timestamp). We don't filter by
  // holder — a hard-killed tick leaves the lock set under the worker's own stable
  // instance_id, and a future second worker could leave a stale lock too; both are
  // surfaced here and the actual reclaim decision is enforced atomically by
  // claim_theo_session's lease check. Two selects unioned because PostgREST can't
  // express the (unlocked OR stale) OR cleanly in one filter. myInstanceId is no
  // longer needed for filtering but is kept in the signature for callers.
  void myInstanceId;
  const unlocked = await supabase
    .from("theo_session")
    .select("id, state, locked_by_instance_id")
    .eq("state", "dispatched")
    .is("locked_by_instance_id", null)
    .limit(limit);
  if (unlocked.error) throw new Error(`session list (unlocked) failed: ${unlocked.error.message}`);

  // Reclaimable: locked, but the lease has lapsed (or predates the lease column).
  const leaseCutoff = new Date(Date.now() - LOCK_LEASE_SECONDS * 1000).toISOString();
  const reclaimable = await supabase
    .from("theo_session")
    .select("id, state, locked_by_instance_id")
    .eq("state", "dispatched")
    .not("locked_by_instance_id", "is", null)
    .or(`locked_at.is.null,locked_at.lt.${leaseCutoff}`)
    .limit(limit);
  if (reclaimable.error) throw new Error(`session list (reclaimable) failed: ${reclaimable.error.message}`);

  const byId = new Map<string, DispatchableSession>();
  for (const r of unlocked.data ?? []) byId.set(r.id as string, r as DispatchableSession);
  for (const r of reclaimable.data ?? []) byId.set(r.id as string, r as DispatchableSession);
  return [...byId.values()];
}

export async function claimSession(
  supabase: SupabaseClient,
  sessionId: string,
  myInstanceId: string,
): Promise<boolean> {
  // The lease lives in config (LOCK_LEASE_SECONDS) and is passed explicitly so the
  // worker and the RPC agree; the RPC also carries a matching default as a fallback.
  const { data, error } = await supabase.rpc("claim_theo_session", {
    p_session_id: sessionId,
    p_instance_id: myInstanceId,
    p_lease_seconds: LOCK_LEASE_SECONDS,
  });
  if (error) throw new Error(`claim_theo_session failed: ${error.message}`);
  return data === true;
}

export async function releaseSession(supabase: SupabaseClient, sessionId: string): Promise<void> {
  const { error } = await supabase
    .from("theo_session")
    .update({ locked_by_instance_id: null, locked_at: null })
    .eq("id", sessionId);
  if (error) throw new Error(`release session failed: ${error.message}`);
}

export async function findRowsForSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<EngineDispatchRow[]> {
  const { data, error } = await supabase
    .from("engine_dispatch")
    .select("id, theo_session_id, engine_name, role_in_dispatch, prompt_sent, status, provider_job_ref, dispatched_at, submit_attempts, last_attempt_at")
    .eq("theo_session_id", sessionId)
    .in("status", ["pending", "dispatched"]);
  if (error) throw new Error(`row list failed: ${error.message}`);
  return (data ?? []) as EngineDispatchRow[];
}

// Record a retryable submit failure on a pending row: bump the attempt counter
// and stamp the attempt time (drives backoff + the terminal-fail ceiling). CAS
// guard on status='pending' so it can't trample a row another path just finalised.
export async function recordSubmitAttempt(
  supabase: SupabaseClient,
  rowId: string,
  newAttemptCount: number,
): Promise<void> {
  const { error } = await supabase
    .from("engine_dispatch")
    .update({ submit_attempts: newAttemptCount, last_attempt_at: new Date().toISOString() })
    .eq("id", rowId)
    .eq("status", "pending");
  if (error) throw new Error(`recordSubmitAttempt failed: ${error.message}`);
}

export async function markDispatched(
  supabase: SupabaseClient,
  rowId: string,
  providerJobRef: string,
): Promise<void> {
  const { error } = await supabase
    .from("engine_dispatch")
    .update({
      status: "dispatched",
      provider_job_ref: providerJobRef,
      dispatched_at: new Date().toISOString(),
    })
    .eq("id", rowId)
    .eq("status", "pending");  // CAS guard
  if (error) throw new Error(`markDispatched failed: ${error.message}`);
}

// source_count — a DERIVED coverage signal (engine_dispatch.source_count): the
// count of DISTINCT source URLs the engine cited in its raw return. Re-derivable
// and NEVER authoritative — response_raw remains the source of truth, and a low
// count is a coverage signal, not a verdict (gaps render with dignity). Citation
// liveness/resolution is a separate later pass; this is only "how many cited".
const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/gi;
export function countSources(responseRaw: string | null | undefined): number {
  if (!responseRaw) return 0;
  const urls = responseRaw.match(URL_RE) ?? [];
  const distinct = new Set(urls.map((u) => u.replace(/[.,;:'")\]}>]+$/, "").toLowerCase()));
  return distinct.size;
}

// C1 (baton 9283c919) — worker act-trail. Every TERMINAL dispatch transition (completed /
// partial / failed) leaves an execution_ledger row keyed to theo_session_id, so the worker leg
// is no longer "invisible until queried": a finishing OR dying dispatch posts a queryable worker
// execution record into the session (read_execution_ledger surfaces it). Theo's own post-mortem
// found execution_ledger EMPTY for a real dispatched session — this closes that gap. Best-effort:
// an audit-write failure must NEVER fail the dispatch finalize it records, so it's caught here.
// Only fires when the CAS update actually transitioned a row (select returns it) — a stale write
// (0 rows matched) records nothing, which is correct.
const LEDGER_FIELDS = "theo_session_id, engine_name, role_in_dispatch, source_count";
interface LedgerRow { theo_session_id: string; engine_name: string; role_in_dispatch: string; source_count: number | null }

async function writeWorkerLedger(
  supabase: SupabaseClient,
  rowId: string,
  r: LedgerRow,
  status: "completed" | "partial" | "failed",
  outcome: string,
): Promise<void> {
  try {
    await supabase.from("execution_ledger").insert({
      lineage: "theo-dispatch-worker",
      session_id: r.theo_session_id,          // text session key (NOT NULL) — the theo_session id
      via: "worker",
      tool: `dispatch:${status}`,
      input_summary: `${r.engine_name} / ${r.role_in_dispatch} (dispatch ${rowId})`,
      outcome: outcome.length > 2000 ? outcome.slice(0, 2000) + "…" : outcome,
      theo_session_id: r.theo_session_id,      // uuid FK (A4) — keys the row to the session for audits
    });
  } catch (e) {
    console.error("writeWorkerLedger", e);
  }
}

export async function markCompleted(
  supabase: SupabaseClient,
  rowId: string,
  args: { response_raw: string; tokens_in?: number; tokens_out?: number; cost_usd?: number },
  expectedStatus: "pending" | "dispatched",
): Promise<void> {
  const { data, error } = await supabase
    .from("engine_dispatch")
    .update({
      status: "completed",
      response_raw: args.response_raw,
      response_received_at: new Date().toISOString(),
      source_count: countSources(args.response_raw),
      tokens_in: args.tokens_in ?? null,
      tokens_out: args.tokens_out ?? null,
      cost_usd: args.cost_usd ?? null,
    })
    .eq("id", rowId)
    .eq("status", expectedStatus)
    .select(LEDGER_FIELDS);
  if (error) throw new Error(`markCompleted failed: ${error.message}`);
  const r = (data ?? [])[0] as LedgerRow | undefined;
  if (r) {
    await writeWorkerLedger(supabase, rowId, r, "completed",
      `completed: ${r.source_count ?? 0} sources, ${args.tokens_in ?? 0}/${args.tokens_out ?? 0} tok` +
      (args.cost_usd != null ? `, $${args.cost_usd}` : ""));
  }
}

export async function markPartial(
  supabase: SupabaseClient,
  rowId: string,
  args: { response_raw: string; reason: string; tokens_in?: number; tokens_out?: number; cost_usd?: number },
  expectedStatus: "pending" | "dispatched",
): Promise<void> {
  const { data, error } = await supabase
    .from("engine_dispatch")
    .update({
      status: "partial",
      response_raw: args.response_raw,
      response_received_at: new Date().toISOString(),
      source_count: countSources(args.response_raw),
      error_detail: `partial: ${args.reason}`,
      tokens_in: args.tokens_in ?? null,
      tokens_out: args.tokens_out ?? null,
      cost_usd: args.cost_usd ?? null,
    })
    .eq("id", rowId)
    .eq("status", expectedStatus)
    .select(LEDGER_FIELDS);
  if (error) throw new Error(`markPartial failed: ${error.message}`);
  const r = (data ?? [])[0] as LedgerRow | undefined;
  if (r) await writeWorkerLedger(supabase, rowId, r, "partial", `partial: ${args.reason}`);
}

// rawBody (baton 143072ab #3): the provider's raw error response, persisted
// (truncated) into response_raw so a failure is diagnosable after the fact —
// previously only "api_error: http N" survived, blinding diagnosis of the 400s.
const RAW_ERROR_MAX = 8_000;
export async function markFailed(
  supabase: SupabaseClient,
  rowId: string,
  errorDetail: string,
  expectedStatus: "pending" | "dispatched",
  rawBody?: unknown,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: "failed",
    error_detail: errorDetail,
    response_received_at: new Date().toISOString(),
  };
  if (rawBody !== undefined && rawBody !== null) {
    const s = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
    if (s) patch.response_raw = s.length > RAW_ERROR_MAX ? s.slice(0, RAW_ERROR_MAX) + "…[truncated]" : s;
  }
  const { data, error } = await supabase
    .from("engine_dispatch")
    .update(patch)
    .eq("id", rowId)
    .eq("status", expectedStatus)
    .select(LEDGER_FIELDS);
  if (error) throw new Error(`markFailed failed: ${error.message}`);
  const r = (data ?? [])[0] as LedgerRow | undefined;
  if (r) await writeWorkerLedger(supabase, rowId, r, "failed", `failed: ${errorDetail}`);
}

export interface SessionTerminalCounts {
  completed: number;
  partial: number;
  failed: number;
  remaining: number;  // pending + dispatched (rows still in flight)
}

export async function sessionStatusCounts(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<SessionTerminalCounts> {
  const { data, error } = await supabase
    .from("engine_dispatch")
    .select("status")
    .eq("theo_session_id", sessionId);
  if (error) throw new Error(`status counts failed: ${error.message}`);

  const counts: SessionTerminalCounts = { completed: 0, partial: 0, failed: 0, remaining: 0 };
  for (const r of data ?? []) {
    switch (r.status) {
      case "completed": counts.completed++; break;
      case "partial":   counts.partial++;   break;
      case "failed":    counts.failed++;    break;
      case "pending":
      case "dispatched": counts.remaining++; break;
    }
  }
  return counts;
}

export async function updateSessionState(
  supabase: SupabaseClient,
  sessionId: string,
  newState: "comparing" | "failed",
): Promise<void> {
  const { error } = await supabase
    .from("theo_session")
    .update({ state: newState })
    .eq("id", sessionId)
    .eq("state", "dispatched");  // CAS guard — only transition from 'dispatched'
  if (error) throw new Error(`session state update failed: ${error.message}`);
}
