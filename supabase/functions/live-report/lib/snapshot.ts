// Snapshot store — the synthesis-layer analogue of source_document (SP 2e97d74e
// component 3). Each evaluation of f is a pinned, immutable, append-only snapshot:
// v1 = as-delivered baseline; v2+ = recalibrated, bound to the baseline. Recompute
// derives from the FROZEN grounding in the baseline, never live tables, so any v2+ is
// reproducible.
//
// Built against the PROPOSED report_snapshot (pending Connie). Persistence is BEST-EFFORT:
// f is deterministic, so the returned values are correct whether or not the row lands —
// before the table exists the engine simply derives the baseline from live grounding each
// call (still exact, just unpinned + no audit row). "persisted" tells the caller which.

import { readGrounding } from "./grounding.ts";
import { recompute } from "./recompute.ts";
import type { Grounding, RecomputeInputs, RecomputeResult } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

const BASELINE_INPUTS: RecomputeInputs = {
  weights: {},
  exclusions: [],
  reset: false,
  scope: { whole_report: true },
};

export interface Baseline {
  grounding: Grounding;
  baselineId: string | null;   // null when report_snapshot does not yet exist
  baseline: RecomputeResult;
}

// Load the v1 baseline if persisted; otherwise mint it from live grounding and try to
// store it (best-effort). The frozen grounding is the immutable base for all recompute.
export async function loadBaseline(supabase: Db, sessionId: string): Promise<Baseline> {
  const existing = await supabase
    .from("report_snapshot")
    .select("id, grounding_json, results_json")
    .eq("theo_session_id", sessionId)
    .eq("version", 1)
    .maybeSingle();
  if (!existing.error && existing.data) {
    return {
      grounding: existing.data.grounding_json as Grounding,
      baselineId: existing.data.id as string,
      baseline: existing.data.results_json as RecomputeResult,
    };
  }

  // Mint from live grounding (the once-only live read).
  const grounding = await readGrounding(supabase, sessionId);
  const baseline = recompute(grounding, BASELINE_INPUTS, 1);

  const ins = await supabase
    .from("report_snapshot")
    .insert({
      theo_session_id: sessionId,
      base_snapshot_id: null,
      version: 1,
      weights_json: grounding.as_delivered_weights,
      exclusions_json: [],
      grounding_json: grounding,
      results_json: baseline,
      scope_json: { whole_report: true },
    })
    .select("id")
    .single();
  const baselineId = !ins.error && ins.data ? (ins.data.id as string) : null;
  if (baselineId) grounding.base_snapshot_id = baselineId;
  return { grounding, baselineId, baseline };
}

export async function nextVersion(supabase: Db, sessionId: string): Promise<number> {
  const res = await supabase
    .from("report_snapshot")
    .select("version")
    .eq("theo_session_id", sessionId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!res.error && res.data?.version) return (res.data.version as number) + 1;
  return 2;
}

// Append a recalibrated snapshot. Best-effort; failure does not change the returned values.
export async function persistVersion(
  supabase: Db,
  sessionId: string,
  baselineId: string | null,
  grounding: Grounding,
  inputs: RecomputeInputs,
  result: RecomputeResult,
): Promise<boolean> {
  const ins = await supabase.from("report_snapshot").insert({
    theo_session_id: sessionId,
    base_snapshot_id: baselineId,
    version: result.version,
    weights_json: result.inputs.weights,
    exclusions_json: result.inputs.exclusions,
    grounding_json: grounding,
    results_json: result,
    scope_json: inputs.scope,
    client_actor: inputs.client_context?.actor ?? null,
    client_reason: inputs.client_context?.reason ?? null,
  });
  return !ins.error;
}
