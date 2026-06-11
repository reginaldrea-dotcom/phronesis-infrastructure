// Live-report recompute engine — wire + internal types.
//
// The report is the evaluation of f(grounding, weights) over the anchored claim
// spine (SP 2e97d74e; contract MR d7b75a76 v1.1). This file is the single source
// of the shapes that cross the surface<->engine seam and the shapes f computes over.
//
// Three kinds of cell (Eames's model, confirmed):
//   LOCKED  — ground truth: anchored sources + their structured figures. Read-only.
//             The engine NEVER alters a locked cell on recompute.
//   INPUT   — client-adjustable: per-HOUSE weights + exclusions. Surface owns/sends.
//   FORMULA — derived: the recomputed findings. Engine owns; surface only displays.
//
// Reweighting is keyed by HOUSE, not by citation (Decision 1, fence 3): a house may
// have several citations across engines but is ONE data point; excluding a house
// drops all its figures; two engines citing one house remain one weight. This is what
// keeps the recompute un-gameable by a house appearing twice.

// ── Provenance / status vocab (matches the live spine, session 353faa7d) ──────
// claim_status as authored. Phase-1 recompute can downgrade along this ladder as
// houses are excluded (>=2 -> 1 -> 0 retained), never invent a stronger status.
export type ClaimStatus =
  | "convergent"
  | "single_source"
  | "divergent"
  | "synthesis_inference"
  | "gap";

// Provenance tier (the contamination guard, SP component 2). Phase 1 is ALWAYS
// "sourced"; client tiers attach later without retrofit. NOT the statutory/estimate
// distinction — that reads off is_derived + claim_status (contract amendment A1).
export type ProvenanceTier = "sourced" | "client-data" | "client-estimate";

export type GapReason =
  | "no_retained_support"   // every supporting house excluded/zero-weighted
  | "cited_not_anchored"    // citation exists but never froze to a source_document
  | "no_public_data";       // structural gap in the public record

// ── LOCKED cells ──────────────────────────────────────────────────────────────

// A structured figure: a typed projection of a figure already anchored in prose,
// pinned to its citation so it stays click-through to the frozen source (fence 1).
// Populated RESEARCH-SIDE and verified — never parsed here (fence 2). Many-per-
// citation: Mordor carries 7.62@FY2025 AND 7.97@2026 as two distinct figures.
export interface StructuredFigure {
  house_key: string;
  value: number;
  unit: string | null;        // e.g. "USD bn", "%"
  as_of_year: string | null;  // e.g. "FY2025", "2026" — kept distinct, never flattened
  scope: string | null;       // what the figure measures
  claim_citation_id: string;
  source_document_id: string | null;  // the frozen anchor (null = cited-not-anchored)
}

// One named research house — the unit of reweighting. Deduped across engines/citations.
export interface House {
  house_key: string;          // normalised id, e.g. "mordor_intelligence"
  display_name: string;       // e.g. "Mordor Intelligence"
}

// A locked source cell as the surface renders it (one per citation, grouped by house).
export interface SourceCell {
  source_id: string;          // claim_citation id
  house_key: string;
  title: string | null;
  url: string | null;
  source_document_id: string | null;
  content_hash: string | null;
  resolution: string;         // claim_citation.resolution (unchecked/resolved/dead/...)
}

// ── The grounding object the read layer produces and f computes over ────────────

export interface ClaimGrounding {
  finding_id: string;         // claim_id
  label: string;              // question_text (the human-facing heading)
  base_status: ClaimStatus;   // claim_status as delivered (v1 baseline)
  is_derived: boolean;        // FORMULA cell (true) vs directly-cited figure (false)
  supporting_houses: string[];// distinct house_keys backing this claim (deduped)
  figures: StructuredFigure[];// structured figures for this claim ([] => status-only)
  depends_on: string[];       // finding_ids this claim derives from (the spine edges)
}

export interface Grounding {
  report_id: string;
  base_snapshot_id: string;
  claims: ClaimGrounding[];
  houses: House[];
  sources: SourceCell[];
  as_delivered_weights: Record<string, number>;  // house_key -> baseline weight (default 1)
}

// ── INPUT cells (recompute request from the surface) ────────────────────────────

export interface RecomputeInputs {
  weights: Record<string, number>;  // house_key -> weight (0 == excluded)
  exclusions: string[];             // house_keys toggled off (== weight 0, but re-includable)
  reset: boolean;                   // restore as-delivered v1 for the scope
  scope: { finding_id?: string; chapter_id?: string; whole_report?: boolean };
  client_context?: { actor?: string; reason?: string };  // surface supplies who/why (audit)
}

// ── FORMULA cells (recompute response to the surface) ───────────────────────────

export interface DerivationEntry {
  house_key: string;
  effective_weight: number;
  contributed_value: number | null;  // the house's figure that fed the envelope (null = status-only)
}

export interface RecomputedFinding {
  finding_id: string;
  label: string;
  tier: ProvenanceTier;       // phase 1: always "sourced"
  is_derived: boolean;
  claim_status: ClaimStatus;  // recomputed
  // Numeric envelope — populated only where structured figures exist (the market-size
  // spine this phase). null central + null range => status-only finding.
  central: number | null;
  range: { low: number; high: number } | null;
  gap_reason: GapReason | null;
  derivation: DerivationEntry[];
  depends_on: string[];
  changed: boolean;           // did this finding change vs the base snapshot? (the ripple)
}

export interface RecomputeResult {
  report_id: string;
  base_snapshot_id: string;
  version: number;            // v1 = as-delivered; v2+ = recalibrated
  findings: RecomputedFinding[];
  inputs: {
    weights: Record<string, number>;
    exclusions: string[];
    as_delivered_weights: Record<string, number>;
  };
}
