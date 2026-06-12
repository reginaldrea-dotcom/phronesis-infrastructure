// f(grounding, inputs) — the recompute core (SP 2e97d74e "the genuine engineering
// core"; contract MR d7b75a76 v1.1). Pure and deterministic: same (grounding, inputs)
// -> same output, no I/O, no clock, no LLM. Keyed by house_id (source_house).
//
//  RETENTION LADDER (status downgrade). Reweighting is over HOUSES. A claim's status can
//  only WEAKEN as houses are excluded, never strengthen:
//     retained >= 2 -> keep convergent/divergent ; == 1 -> single_source ; == 0 -> gap.
//     single_source / synthesis_inference: >=1 retained -> unchanged ; 0 -> gap.
//     an authored gap stays a gap.
//
//  COHORT-AWARE ENVELOPE (no year-flattening, fence 1/2). A numeric range is computed only
//  WITHIN a comparable cohort = (unit, as_of_year, scope). 7.62@2025 and 7.97@2026 are
//  different cohorts and never min/max'd together. Headline cohort = the one the most
//  retained houses share; central is the weight-mean over it.
//
//  RIPPLE (depends_on). Change-visibility propagates along the spine edges to a fixpoint.
//  Cross-finding numeric formulas are not structured this phase, so a dependent's numeric
//  value is not auto-derived — it is flagged changed for review.

import type {
  ClaimGrounding,
  ClaimStatus,
  DerivationEntry,
  Grounding,
  RecomputedFinding,
  RecomputeInputs,
  RecomputeResult,
  StructuredFigure,
} from "./types.ts";

// Effective per-house weights: baseline, overlaid by the request, exclusions forced to 0.
export function effectiveWeights(g: Grounding, inputs: RecomputeInputs): Record<string, number> {
  const w: Record<string, number> = {};
  for (const h of g.houses) {
    const base = g.as_delivered_weights[h.house_id] ?? 1;
    const override = inputs.weights[h.house_id];
    w[h.house_id] = override === undefined ? base : override;
  }
  for (const ex of inputs.exclusions) w[ex] = 0;
  return w;
}

function retainedHouses(claim: ClaimGrounding, weights: Record<string, number>): string[] {
  return claim.supporting_houses.filter((id) => (weights[id] ?? 0) > 0);
}

function recomputeStatus(base: ClaimStatus, retainedCount: number): ClaimStatus {
  if (base === "gap") return "gap";
  if (retainedCount === 0) return "gap";
  switch (base) {
    case "convergent":
    case "divergent":
      return retainedCount >= 2 ? base : "single_source";
    case "single_source":
    case "synthesis_inference":
      return base;
  }
}

const cohortKey = (f: StructuredFigure) => `${f.unit ?? ""}|${f.as_of_year ?? ""}|${f.scope ?? ""}`;

function envelope(
  claim: ClaimGrounding,
  weights: Record<string, number>,
): { central: number; low: number; high: number; derivation: DerivationEntry[] } | null {
  const retained = claim.figures.filter((f) => (weights[f.house_id] ?? 0) > 0);
  if (retained.length === 0) return null;

  const cohorts = new Map<string, StructuredFigure[]>();
  for (const f of retained) {
    const k = cohortKey(f);
    (cohorts.get(k) ?? cohorts.set(k, []).get(k)!).push(f);
  }
  let best: StructuredFigure[] | null = null;
  let bestHouses = -1;
  let bestWeight = -1;
  for (const figs of cohorts.values()) {
    const houses = new Set(figs.map((f) => f.house_id));
    const weight = figs.reduce((s, f) => s + (weights[f.house_id] ?? 0), 0);
    if (houses.size > bestHouses || (houses.size === bestHouses && weight > bestWeight)) {
      best = figs;
      bestHouses = houses.size;
      bestWeight = weight;
    }
  }
  if (!best) return null;

  const perHouse = new Map<string, StructuredFigure>();
  for (const f of best) if (!perHouse.has(f.house_id)) perHouse.set(f.house_id, f);

  const derivation: DerivationEntry[] = [];
  let wsum = 0;
  let wval = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const [id, f] of perHouse) {
    const wt = weights[id] ?? 0;
    derivation.push({ house_id: id, effective_weight: wt, contributed_value: f.value });
    wsum += wt;
    wval += wt * f.value;
    if (f.value < low) low = f.value;
    if (f.value > high) high = f.value;
  }
  if (wsum === 0) return null;
  return { central: wval / wsum, low, high, derivation };
}

function recomputeOne(claim: ClaimGrounding, weights: Record<string, number>): RecomputedFinding {
  const retained = retainedHouses(claim, weights);
  const status = recomputeStatus(claim.base_status, retained.length);
  const env = envelope(claim, weights);

  const derivation: DerivationEntry[] = env
    ? env.derivation
    : retained.map((id) => ({ house_id: id, effective_weight: weights[id] ?? 0, contributed_value: null }));

  return {
    finding_id: claim.finding_id,
    label: claim.label,
    tier: "sourced",
    is_derived: claim.is_derived,
    claim_status: status,
    central: env ? env.central : null,
    range: env ? { low: env.low, high: env.high } : null,
    // no_retained_support ONLY when a claim that HAD support is emptied by exclusion; an
    // authored gap is structural (no_public_data) regardless of weighting.
    gap_reason: status !== "gap"
      ? null
      : (claim.base_status !== "gap" && retained.length === 0 ? "no_retained_support" : "no_public_data"),
    derivation,
    depends_on: claim.depends_on,
    changed: false,
  };
}

function sameFinding(a: RecomputedFinding, b: RecomputedFinding): boolean {
  const r = (x: { low: number; high: number } | null) => (x ? `${x.low}/${x.high}` : "null");
  return a.claim_status === b.claim_status && a.central === b.central && r(a.range) === r(b.range);
}

export function recompute(g: Grounding, inputs: RecomputeInputs, version: number): RecomputeResult {
  const baseW = { ...g.as_delivered_weights };
  const curW = effectiveWeights(g, inputs);

  const baseline = new Map(g.claims.map((c) => [c.finding_id, recomputeOne(c, baseW)]));
  const current = g.claims.map((c) => recomputeOne(c, curW));
  const byId = new Map(current.map((f) => [f.finding_id, f]));

  for (const f of current) {
    const b = baseline.get(f.finding_id);
    f.changed = b ? !sameFinding(f, b) : true;
  }

  for (let pass = 0; pass < g.claims.length; pass++) {
    let touched = false;
    for (const f of current) {
      if (f.changed) continue;
      if (f.depends_on.some((dep) => byId.get(dep)?.changed)) {
        f.changed = true;
        touched = true;
      }
    }
    if (!touched) break;
  }

  return {
    report_id: g.report_id,
    base_snapshot_id: g.base_snapshot_id,
    version,
    findings: current,
    inputs: {
      weights: curW,
      exclusions: inputs.exclusions,
      as_delivered_weights: g.as_delivered_weights,
    },
  };
}
