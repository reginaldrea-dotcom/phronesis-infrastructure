// grounding-worker tick. One invocation = one tick. All state lives in the substrate (grounding_queue);
// no in-memory state across ticks.
//
// Per tick: reap stranded rows -> claim one pending row at a time (FOR UPDATE SKIP LOCKED, so overlapping
// ticks are safe) -> ground it by invoking Angelia through the Prime EF -> judge the outcome by a DB SIDE
// EFFECT (did a claim_on_fact edge appear?), NOT by parsing the model's prose (the confabulation lesson) ->
// mark grounded / retry / failed. Bounded by MAX_PER_TICK and a wall-clock budget so a tick never races the
// ~150s gateway wall. Newly-failed claims are routed to Theo as a wake_delta (Reg decision 4).

import type { SupabaseClient } from "./supabase.ts";
import { env } from "./env.ts";
import {
  GROUNDING_LINEAGE, MAX_PER_TICK, PRIME_INVOKE_TIMEOUT_MS, PRIME_INVOKE_URL, STALE_MINUTES, TICK_BUDGET_MS,
} from "./config.ts";

interface QRow {
  id: string; claim_id: string; synthesis_id: string | null; attempts: number; max_attempts: number;
}

export interface TickSummary {
  tick: string; reaped: number; processed: number; grounded: number; failed: number;
  pending_remaining: number | null; elapsed_ms: number;
}

export async function tick(supabase: SupabaseClient): Promise<TickSummary> {
  const tickId = crypto.randomUUID().slice(0, 8);
  const started = Date.now();

  const reap = await supabase.rpc("grounding_reap", { p_stale_minutes: STALE_MINUTES });
  const reaped = typeof reap.data === "number" ? reap.data : 0;

  let grounded = 0, failed = 0, processed = 0;
  const newlyFailed: Array<{ claim_id: string; error: string }> = [];

  while (processed < MAX_PER_TICK && (Date.now() - started) < TICK_BUDGET_MS) {
    const claim = await supabase.rpc("grounding_claim_one", { p_tick_id: tickId });
    if (claim.error) throw new Error(`grounding_claim_one failed: ${claim.error.message}`);
    const r = (Array.isArray(claim.data) ? claim.data[0] : claim.data) as QRow | null;
    if (!r || !r.id) break; // queue empty
    processed++;

    const outcome = await groundOne(supabase, r);
    if (outcome.grounded) {
      await supabase.rpc("grounding_mark", { p_id: r.id, p_state: "grounded" });
      grounded++;
    } else if (r.attempts >= r.max_attempts) {
      await supabase.rpc("grounding_mark", { p_id: r.id, p_state: "failed", p_error: outcome.note });
      failed++;
      newlyFailed.push({ claim_id: r.claim_id, error: outcome.note });
    } else {
      // transient miss - back to pending for a later tick (attempts already counted at claim).
      await supabase.rpc("grounding_mark", { p_id: r.id, p_state: "pending", p_error: outcome.note });
    }
  }

  if (newlyFailed.length > 0) await notifyTheo(supabase, newlyFailed);

  const pend = await supabase.from("grounding_queue").select("*", { count: "exact", head: true }).eq("state", "pending");
  return {
    tick: tickId, reaped, processed, grounded, failed,
    pending_remaining: pend.count ?? null, elapsed_ms: Date.now() - started,
  };
}

// Ground ONE claim. Judge success by whether a claim_on_fact edge exists AFTER the invocation, never by the
// model's words. Returns grounded + a short note (the model's reason on a miss, for Theo's triage).
async function groundOne(supabase: SupabaseClient, r: QRow): Promise<{ grounded: boolean; note: string }> {
  if (await hasEdge(supabase, r.claim_id)) return { grounded: true, note: "already grounded" };

  let respText = "";
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PRIME_INVOKE_TIMEOUT_MS);
    const resp = await fetch(PRIME_INVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "apikey": env("THEO_DISPATCH_SECRET_KEY") },
      body: JSON.stringify({
        lineage_name: GROUNDING_LINEAGE,
        session_id: crypto.randomUUID(),                  // fresh short session per claim (clean context)
        user_message: groundingPrompt(r.claim_id),
        request_id: `grounding-${r.claim_id}-${r.attempts}`, // idempotent per attempt
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const j = await resp.json().catch(() => ({}));
    respText = typeof (j as { response?: unknown })?.response === "string"
      ? (j as { response: string }).response
      : JSON.stringify(j).slice(0, 400);
  } catch (e) {
    respText = `prime invoke error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const grounded = await hasEdge(supabase, r.claim_id);
  return { grounded, note: grounded ? "grounded" : excerpt(respText) };
}

async function hasEdge(supabase: SupabaseClient, claimId: string): Promise<boolean> {
  const { data } = await supabase.from("element_dependency")
    .select("id").eq("dependent_synthesis_claim_id", claimId).eq("edge_kind", "claim_on_fact").limit(1);
  return Array.isArray(data) && data.length > 0;
}

function groundingPrompt(claimId: string): string {
  return [
    "GROUNDING TASK - one claim, v1 mode: ground ONLY against sources already frozen in this Dossier.",
    `Ground synthesis_claim ${claimId}.`,
    "1. Read the claim, then the frozen ground_facts already captured for this Dossier.",
    "2. Find the frozen ground_fact whose captured content SUPPORTS this claim's load-bearing figure or assertion. If the figure is numeric, verify it is actually present in that frozen content first.",
    "3. If found: write the claim_on_fact edge with write_element_dependency (dependent_type=synthesis_claim, dependent_id=" + claimId + ", depends_on_type=ground_fact, depends_on_id=<the fact>, edge_kind=claim_on_fact).",
    "4. If NO frozen ground_fact supports it: do NOT invent, capture, or dispatch anything. State plainly which source is missing - the claim will be parked for a later capture pass.",
    "Do exactly this ONE claim. Do not ground others.",
  ].join("\n");
}

function excerpt(s: string): string {
  const t = (s || "").trim();
  return t.length > 300 ? t.slice(0, 300) + " ..." : t;
}

// Route newly-failed claims to Theo (decision 4) so he can re-source, reword, or drop them.
async function notifyTheo(supabase: SupabaseClient, failed: Array<{ claim_id: string; error: string }>): Promise<void> {
  const lines = failed.map((f) => `- ${f.claim_id}: ${f.error}`).join("\n");
  const note =
    `Grounding worker could not ground ${failed.length} claim(s) after max attempts (no frozen source supported them, ` +
    `or the figure was not present in the frozen source). Triage: re-source (capture a real source), reword, or drop.\n\n${lines}`;
  const { error } = await supabase.from("wake_deltas").insert({
    to_lineage: "theophrastus", from_lineage: "grounding-worker", note,
  });
  if (error) console.error("notifyTheo wake_delta insert failed:", error.message);
}
