// Snapshot store — the synthesis-layer analogue of source_document (SP 2e97d74e).
// Reconciled to Connie's report_snapshot: snapshot_kind in {baseline, reweight} locked to
// is_baseline; grounding = the frozen [{source_document_id, content_hash}] provenance set
// (NOT NULL); weighting_vector = house weights/exclusions; computed_output = the recorded
// evaluation. IMMUTABLE (no UPDATE/DELETE, refusal-tested); a reweight MINTS a new row.
//
// Persistence is BEST-EFFORT and append-only: f is deterministic, so returned values are
// correct whether or not the row lands. The baseline is computed LIVE from current grounding
// each call (deterministic) rather than read back from the stored row — so while the spine
// is still being populated (figures landing post-delivery) the baseline reflects the real
// spine instead of freezing a stale status-only evaluation. The stored baseline row is the
// provenance/audit pin (minted once per session). On the settled, delivered spine the two
// coincide bit-for-bit ("go back to original" = the baseline).

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

// The frozen provenance set Connie's grounding column pins.
function frozenSourceSet(g: Grounding): Array<{ source_document_id: string; content_hash: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ source_document_id: string; content_hash: string | null }> = [];
  for (const s of g.sources) {
    if (s.source_document_id && !seen.has(s.source_document_id)) {
      seen.add(s.source_document_id);
      out.push({ source_document_id: s.source_document_id, content_hash: s.content_hash });
    }
  }
  return out;
}

export interface Baseline {
  grounding: Grounding;
  baselineId: string | null;
  baseline: RecomputeResult;
}

export async function loadBaseline(supabase: Db, sessionId: string): Promise<Baseline> {
  const grounding = await readGrounding(supabase, sessionId);
  const baseline = recompute(grounding, BASELINE_INPUTS, 1);

  // Ensure exactly one baseline row exists (provenance pin); mint if absent. Best-effort.
  let baselineId: string | null = null;
  const existing = await supabase
    .from("report_snapshot")
    .select("id")
    .eq("theo_session_id", sessionId)
    .eq("is_baseline", true)
    .maybeSingle();
  if (!existing.error && existing.data) {
    baselineId = existing.data.id as string;
  } else {
    const ins = await supabase
      .from("report_snapshot")
      .insert({
        theo_session_id: sessionId,
        snapshot_kind: "baseline",
        is_baseline: true,
        grounding: frozenSourceSet(grounding),
        weighting_vector: { weights: grounding.as_delivered_weights, exclusions: [] },
        computed_output: baseline,
      })
      .select("id")
      .single();
    if (!ins.error && ins.data) baselineId = ins.data.id as string;
  }
  if (baselineId) grounding.base_snapshot_id = baselineId;
  return { grounding, baselineId, baseline };
}

export async function nextVersion(supabase: Db, sessionId: string): Promise<number> {
  const res = await supabase
    .from("report_snapshot")
    .select("id", { count: "exact", head: true })
    .eq("theo_session_id", sessionId);
  if (!res.error && typeof res.count === "number") return res.count + 1;
  return 2;
}

// Append a reweight snapshot (immutable, never edits an old one). Best-effort.
export async function persistReweight(
  supabase: Db,
  sessionId: string,
  grounding: Grounding,
  inputs: RecomputeInputs,
  result: RecomputeResult,
): Promise<boolean> {
  const ins = await supabase.from("report_snapshot").insert({
    theo_session_id: sessionId,
    snapshot_kind: "reweight",
    is_baseline: false,
    grounding: frozenSourceSet(grounding),
    weighting_vector: { weights: result.inputs.weights, exclusions: result.inputs.exclusions },
    computed_output: result,
    attributed_to: inputs.client_context?.actor ?? null,
  });
  return !ins.error;
}
