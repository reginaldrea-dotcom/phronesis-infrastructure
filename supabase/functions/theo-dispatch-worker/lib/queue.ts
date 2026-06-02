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
}

export async function findDispatchableSessions(
  supabase: SupabaseClient,
  myInstanceId: string,
  limit = 20,
): Promise<DispatchableSession[]> {
  // Sessions in 'dispatched' state that are unlocked OR locked by us.
  // Two filters because PostgREST doesn't combine OR with an .eq() cleanly here;
  // we union via two separate selects then dedupe by id.
  const unlocked = await supabase
    .from("theo_session")
    .select("id, state, locked_by_instance_id")
    .eq("state", "dispatched")
    .is("locked_by_instance_id", null)
    .limit(limit);
  if (unlocked.error) throw new Error(`session list (unlocked) failed: ${unlocked.error.message}`);

  const owned = await supabase
    .from("theo_session")
    .select("id, state, locked_by_instance_id")
    .eq("state", "dispatched")
    .eq("locked_by_instance_id", myInstanceId)
    .limit(limit);
  if (owned.error) throw new Error(`session list (owned) failed: ${owned.error.message}`);

  const byId = new Map<string, DispatchableSession>();
  for (const r of unlocked.data ?? []) byId.set(r.id as string, r as DispatchableSession);
  for (const r of owned.data ?? []) byId.set(r.id as string, r as DispatchableSession);
  return [...byId.values()];
}

export async function claimSession(
  supabase: SupabaseClient,
  sessionId: string,
  myInstanceId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("claim_theo_session", {
    p_session_id: sessionId,
    p_instance_id: myInstanceId,
  });
  if (error) throw new Error(`claim_theo_session failed: ${error.message}`);
  return data === true;
}

export async function releaseSession(supabase: SupabaseClient, sessionId: string): Promise<void> {
  const { error } = await supabase
    .from("theo_session")
    .update({ locked_by_instance_id: null })
    .eq("id", sessionId);
  if (error) throw new Error(`release session failed: ${error.message}`);
}

export async function findRowsForSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<EngineDispatchRow[]> {
  const { data, error } = await supabase
    .from("engine_dispatch")
    .select("id, theo_session_id, engine_name, role_in_dispatch, prompt_sent, status, provider_job_ref, dispatched_at")
    .eq("theo_session_id", sessionId)
    .in("status", ["pending", "dispatched"]);
  if (error) throw new Error(`row list failed: ${error.message}`);
  return (data ?? []) as EngineDispatchRow[];
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

export async function markCompleted(
  supabase: SupabaseClient,
  rowId: string,
  args: { response_raw: string; tokens_in?: number; tokens_out?: number; cost_usd?: number },
  expectedStatus: "pending" | "dispatched",
): Promise<void> {
  const { error } = await supabase
    .from("engine_dispatch")
    .update({
      status: "completed",
      response_raw: args.response_raw,
      response_received_at: new Date().toISOString(),
      tokens_in: args.tokens_in ?? null,
      tokens_out: args.tokens_out ?? null,
      cost_usd: args.cost_usd ?? null,
    })
    .eq("id", rowId)
    .eq("status", expectedStatus);
  if (error) throw new Error(`markCompleted failed: ${error.message}`);
}

export async function markPartial(
  supabase: SupabaseClient,
  rowId: string,
  args: { response_raw: string; reason: string; tokens_in?: number; tokens_out?: number },
  expectedStatus: "pending" | "dispatched",
): Promise<void> {
  const { error } = await supabase
    .from("engine_dispatch")
    .update({
      status: "partial",
      response_raw: args.response_raw,
      response_received_at: new Date().toISOString(),
      error_detail: `partial: ${args.reason}`,
      tokens_in: args.tokens_in ?? null,
      tokens_out: args.tokens_out ?? null,
    })
    .eq("id", rowId)
    .eq("status", expectedStatus);
  if (error) throw new Error(`markPartial failed: ${error.message}`);
}

export async function markFailed(
  supabase: SupabaseClient,
  rowId: string,
  errorDetail: string,
  expectedStatus: "pending" | "dispatched",
): Promise<void> {
  const { error } = await supabase
    .from("engine_dispatch")
    .update({
      status: "failed",
      error_detail: errorDetail,
      response_received_at: new Date().toISOString(),
    })
    .eq("id", rowId)
    .eq("status", expectedStatus);
  if (error) throw new Error(`markFailed failed: ${error.message}`);
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
