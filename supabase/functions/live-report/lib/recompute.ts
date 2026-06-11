// f(grounding, inputs) — the recompute core (SP 2e97d74e "the genuine engineering
// core"; contract MR d7b75a76 v1.1). Pure and deterministic: same (grounding, inputs)
// -> same output, no I/O, no clock, no LLM. The snapshot store and the HTTP layer wrap
// this; the truth of the report lives here.
//
// Design rules (documented so Theo can confirm the methodology, not guess it):
//
//  RETENTION LADDER (status downgrade). Reweighting is over HOUSES. A claim's status
//  can only WEAKEN as houses are excluded, never strengthen — the engine never invents
//  support that reweighting removed:
//     retained >= 2 -> keep convergent/divergent ; == 1 -> single_source ; == 0 -> gap.
//     single_source / synthesis_inference: >=1 retained -> unchanged ; 0 -> gap.
//     an authored gap stays a gap (retention cannot un-gap a structural gap).
//
//  COHORT-AWARE ENVELOPE (no year-flattening, fence 1/2). A numeric range is computed
//  only WITHIN a comparable cohort = (unit, as_of_year, scope). Mordor's 7.62@FY2025 and
//  7.97@2026 are different cohorts and are never min/max'd together. The headline cohort
//  is the one the most retained houses share; central is the weight-mean over it.
//
//  RIPPLE (depends_on). Change-visibility propagates along the spine edges: a finding is
//  "changed" if its own recompute differs from baseline OR any finding it depends_on
//  changed. Cross-finding numeric formulas (e.g. turnover = share x market_size) are NOT
//  structured this phase, so a dependent's numeric value is not auto-derived — it is
//  flagged changed for review. The market-size spine is the only numeric cohort in P1.

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
// A house absent from the request keeps its as-delivered weight (default 1).
export function effectiveWeights(g: Grounding, inputs: RecomputeInputs): Record<string, number> {
  const w: Record<string, number> = {};
  for (const h of g.houses) {
    const base = g.as_delivered_weights[h.house_key] ?? 1;
    const override = inputs.weights[h.house_key];
    w[h.house_key] = override === undefined ? base : override;
  }
  for (const ex of inputs.exclusions) w[ex] = 0;
  return w;
}

function retainedHouses(claim: ClaimGrounding, weights: Record<string, number>): string[] {
  return claim.supporting_houses.filter((hk) => (weights[hk] ?? 0) > 0);
}

// Status under the retention ladder above.
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

// Numeric envelope over the headline comparable cohort. Returns null when the claim has
// no structured figures (status-only) or no retained figures (all houses excluded).
function envelope(
  claim: ClaimGrounding,
  weights: Record<string, number>,
): { central: number; low: number; high: number; derivation: DerivationEntry[] } | null {
  const retained = claim.figures.filter((f) => (weights[f.house_key] ?? 0) > 0);
  if (retained.length === 0) return null;

  // Group into comparable cohorts; pick the one the most distinct houses share (headline),
  // tie-broken by total retained weight.
  const cohorts = new Map<string, StructuredFigure[]>();
  for (const f of retained) {
    const k = cohortKey(f);
    (cohorts.get(k) ?? cohorts.set(k, []).get(k)!).push(f);
  }
  let best: StructuredFigure[] | null = null;
  let bestHouses = -1;
  let bestWeight = -1;
  for (const figs of cohorts.values()) {
    const houses = new Set(figs.map((f) => f.house_key));
    const weight = figs.reduce((s, f) => s + (weights[f.house_key] ?? 0), 0);
    if (houses.size > bestHouses || (houses.size === bestHouses && weight > bestWeight)) {
      best = figs;
      bestHouses = houses.size;
      bestWeight = weight;
    }
  }
  if (!best) return null;

  // One figure per house within a cohort (a house gives one value for a given unit/year/scope).
  // If a house repeats, keep the first — research-side population should not duplicate.
  const perHouse = new Map<string, StructuredFigure>();
  for (const f of best) if (!perHouse.has(f.house_key)) perHouse.set(f.house_key, f);

  const derivation: DerivationEntry[] = [];
  let wsum = 0;
  let wval = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const [hk, f] of perHouse) {
    const wt = weights[hk] ?? 0;
    derivation.push({ house_key: hk, effective_weight: wt, contributed_value: f.value });
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

  // Derivation: prefer the numeric envelope's per-house contributions; otherwise list the
  // retained houses with a null contribution (status-only).
  const derivation: DerivationEntry[] = env
    ? env.derivation
    : retained.map((hk) => ({ house_key: hk, effective_weight: weights[hk] ?? 0, contributed_value: null }));

  return {
    finding_id: claim.finding_id,
    label: claim.label,
    tier: "sourced",
    is_derived: claim.is_derived,
    claim_status: status,
    central: env ? env.central : null,
    range: env ? { low: env.low, high: env.high } : null,
    // gap reasons render honestly (SP invariant): no_retained_support applies ONLY when a
    // claim that HAD support at baseline is emptied by exclusion. A claim authored as a gap
    // is a structural gap (no_public_data) regardless of weighting — reweighting neither
    // caused nor can fix it, so it must not read as "you excluded the support".
    gap_reason: status !== "gap"
      ? null
      : (claim.base_status !== "gap" && retained.length === 0 ? "no_retained_support" : "no_public_data"),
    derivation,
    depends_on: claim.depends_on,
    changed: false, // set in the ripple pass below
  };
}

function sameFinding(a: RecomputedFinding, b: RecomputedFinding): boolean {
  const r = (x: { low: number; high: number } | null) => (x ? `${x.low}/${x.high}` : "null");
  return a.claim_status === b.claim_status && a.central === b.central && r(a.range) === r(b.range);
}

// f. Recompute every finding, then propagate change-visibility along depends_on so the
// surface shows the whole ripple, not just the touched finding.
export function recompute(g: Grounding, inputs: RecomputeInputs, version: number): RecomputeResult {
  const baseW = { ...g.as_delivered_weights };
  const curW = effectiveWeights(g, inputs);

  const baseline = new Map(g.claims.map((c) => [c.finding_id, recomputeOne(c, baseW)]));
  const current = g.claims.map((c) => recomputeOne(c, curW));
  const byId = new Map(current.map((f) => [f.finding_id, f]));

  // Direct change vs baseline.
  for (const f of current) {
    const b = baseline.get(f.finding_id);
    f.changed = b ? !sameFinding(f, b) : true;
  }

  // Ripple: a finding is changed if any finding it depends_on is changed. Iterate to a
  // fixpoint (the spine is small and acyclic; the loop bound guards against a bad edge set).
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
