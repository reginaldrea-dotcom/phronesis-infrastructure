// Live-report recompute engine — wire + internal types.
//
// The report is the evaluation of f(grounding, weights) over the anchored claim spine
// (SP 2e97d74e; contract MR d7b75a76 v1.1). Reconciled to Connie's live schema
// (migration live_report_phase1_figures_and_snapshots): houses key via source_house
// (house_id, a uuid), figures carry provenance_tier/figure_kind, snapshots use the
// computed_output/grounding/weighting_vector/is_baseline shape.
//
// Three kinds of cell (Eames's model, confirmed):
//   LOCKED  — ground truth: anchored sources + their structured figures. Read-only.
//   INPUT   — client-adjustable: per-HOUSE weights + exclusions. Surface owns/sends.
//   FORMULA — derived: the recomputed findings. Engine owns; surface only displays.
//
// Reweighting is keyed by HOUSE (house_id), not by citation (Decision 1, fence 3): a
// house may have several citations across engines but is ONE data point; excluding a
// house drops all its figures; two engines citing one house remain one weight. The
// source_house table makes this structural — both the surface (Eames) and this engine
// key INPUT cells on house_id.

export type ClaimStatus =
  | "convergent"
  | "single_source"
  | "divergent"
  | "synthesis_inference"
  | "gap";

// Provenance tier (the contamination guard). Phase 1 is ALWAYS "sourced"; client tiers
// attach later. Underscored to match claim_figure.provenance_tier {sourced|client_data|client_estimate}.
export type ProvenanceTier = "sourced" | "client_data" | "client_estimate";

export type GapReason =
  | "no_retained_support"   // a claim that HAD support is emptied by exclusion
  | "cited_not_anchored"    // citation exists but never froze to a source_document
  | "no_public_data";       // structural gap in the public record (authored gap)

// ── LOCKED cells ──────────────────────────────────────────────────────────────

// A structured figure: a typed projection of a figure already anchored in prose, pinned
// to its citation/source (fence 1). Populated RESEARCH-SIDE and verified (fence 2).
// Many-per-claim: Mordor carries 7.62@2025 AND 7.97@2026 as two distinct figures.
export interface StructuredFigure {
  house_id: string;             // -> source_house.id (the reweighting key)
  value: number;
  unit: string;                 // e.g. "USD bn", "%"
  as_of_year: number | null;    // int; distinct years never min/max'd together
  scope: string | null;
  figure_kind: "anchored" | "derived";
  divergence_note: string | null;  // preserves the year-binding distinction etc.
  claim_citation_id: string | null;
  source_document_id: string | null;
}

// One named research house — the unit of reweighting (source_house row).
export interface House {
  house_id: string;             // source_house.id
  display_name: string;         // source_house.canonical_name
}

// A locked source cell as the surface renders it (one per citation, grouped by house).
export interface SourceCell {
  source_id: string;            // claim_citation id
  house_id: string | null;      // resolved source_house.id (null if unmapped)
  title: string | null;
  url: string | null;
  source_document_id: string | null;
  content_hash: string | null;
  resolution: string;
}

// ── The grounding object the read layer produces and f computes over ────────────

export interface ClaimGrounding {
  finding_id: string;           // claim_id
  label: string;                // question_text
  base_status: ClaimStatus;
  is_derived: boolean;          // FORMULA cell vs directly-cited figure
  supporting_houses: string[];  // distinct house_ids backing this claim (deduped)
  figures: StructuredFigure[];  // [] => status-only
  depends_on: string[];         // finding_ids this claim derives from (the spine edges)
}

export interface Grounding {
  report_id: string;
  base_snapshot_id: string;
  claims: ClaimGrounding[];
  houses: House[];
  sources: SourceCell[];
  as_delivered_weights: Record<string, number>;  // house_id -> baseline weight (default 1)
}

// ── INPUT cells (recompute request from the surface) ────────────────────────────

export interface RecomputeInputs {
  weights: Record<string, number>;  // house_id -> weight (0 == excluded)
  exclusions: string[];             // house_ids toggled off
  reset: boolean;
  scope: { finding_id?: string; chapter_id?: string; whole_report?: boolean };
  client_context?: { actor?: string; reason?: string };
}

// ── FORMULA cells (recompute response to the surface) ───────────────────────────

export interface DerivationEntry {
  house_id: string;
  effective_weight: number;
  contributed_value: number | null;  // null => status-only
}

export interface RecomputedFinding {
  finding_id: string;
  label: string;
  tier: ProvenanceTier;       // phase 1: always "sourced"
  is_derived: boolean;
  claim_status: ClaimStatus;
  central: number | null;     // null => status-only finding
  range: { low: number; high: number } | null;
  gap_reason: GapReason | null;
  derivation: DerivationEntry[];
  depends_on: string[];
  changed: boolean;
}

export interface RecomputeResult {
  report_id: string;
  base_snapshot_id: string;
  version: number;            // informational: 1 = baseline, 2+ = reweight
  findings: RecomputedFinding[];
  inputs: {
    weights: Record<string, number>;
    exclusions: string[];
    as_delivered_weights: Record<string, number>;
  };
}
