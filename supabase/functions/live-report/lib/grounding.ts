// Read the LOCKED cells (the anchored claim spine + structured figures) for a report
// into the immutable Grounding object. Reconciled to Connie's live schema: figures live
// in claim_figure (keyed by house_id -> source_house, linked to claim_id directly),
// houses in source_house. Recompute derives from this grounding; the snapshot pins the
// frozen source-set for provenance (SP 2e97d74e).
//
// Degrades cleanly: before claim_figure / source_house are populated the read returns a
// status-only grounding (figures [], citations resolved via the houses.ts fallback), and
// lights up numeric the moment they fill — no redeploy.

import type { Grounding, ClaimGrounding, ClaimStatus, House, SourceCell, StructuredFigure } from "./types.ts";
import { resolveHouse, type SourceHouseRow } from "./houses.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

// PROVISIONAL dependency edges for the AESSEAL spine, by question_index — pending Theo's
// A2 confirmation (msg 8479ef1c). Market size (index 0) is the denominator; share /
// breakdown findings derive from it. Swap for Theo's confirmed edge set before freeze.
const DEPENDS_ON_BY_QINDEX: Record<number, number[]> = {
  0: [], 1: [], 2: [0], 3: [0], 4: [0], 5: [], 6: [],
};

export async function readGrounding(supabase: Db, sessionId: string): Promise<Grounding> {
  // Claims (the spine).
  const claimsRes = await supabase
    .from("render_claim_v1")
    .select("claim_id, question_text, question_index, claim_status")
    .eq("session_id", sessionId);
  if (claimsRes.error) throw new Error(`grounding: claims read failed: ${claimsRes.error.message}`);
  const claimRows = (claimsRes.data ?? []) as Array<{ claim_id: string; question_text: string; question_index: number; claim_status: string }>;
  if (claimRows.length === 0) throw new Error(`grounding: no claims for session ${sessionId}`);

  const claimIds = claimRows.map((c) => c.claim_id);
  const idByQIndex = new Map(claimRows.map((c) => [c.question_index, c.claim_id]));

  // Citations (locked source cells), with the frozen anchor's content_hash.
  const citRes = await supabase
    .from("claim_citation")
    .select("id, claim_id, url, title, source_document_id, resolution")
    .in("claim_id", claimIds);
  if (citRes.error) throw new Error(`grounding: citation read failed: ${citRes.error.message}`);
  const citRows = (citRes.data ?? []) as Array<{ id: string; claim_id: string; url: string | null; title: string | null; source_document_id: string | null; resolution: string }>;

  const docIds = [...new Set(citRows.map((c) => c.source_document_id).filter(Boolean))] as string[];
  const hashByDoc = new Map<string, string | null>();
  if (docIds.length > 0) {
    const docRes = await supabase.from("source_document").select("id, content_hash").in("id", docIds);
    if (docRes.error) throw new Error(`grounding: source_document read failed: ${docRes.error.message}`);
    for (const d of (docRes.data ?? []) as Array<{ id: string; content_hash: string | null }>) hashByDoc.set(d.id, d.content_hash);
  }

  // House registry (source_house). Empty pre-population — houses.ts then falls back.
  let registry: SourceHouseRow[] = [];
  {
    const hRes = await supabase.from("source_house").select("id, canonical_name, aliases");
    if (!hRes.error && hRes.data) registry = hRes.data as SourceHouseRow[];
  }

  // Structured figures (claim_figure), linked to claim_id directly, keyed by house_id.
  let figRows: Array<{ claim_id: string; claim_citation_id: string | null; source_document_id: string | null; house_id: string; value: number; unit: string; as_of_year: number | null; scope: string | null; figure_kind: string; divergence_note: string | null }> = [];
  {
    const figRes = await supabase
      .from("claim_figure")
      .select("claim_id, claim_citation_id, source_document_id, house_id, value, unit, as_of_year, scope, figure_kind, divergence_note")
      .in("claim_id", claimIds);
    if (!figRes.error && figRes.data) figRows = figRes.data;
    // figRes.error (e.g. table absent in an old env) -> status-only, no throw
  }

  // Build the house registry the surface renders + a citation -> house_id resolution.
  const houseById = new Map<string, House>();
  const sources: SourceCell[] = [];
  const housesByClaim = new Map<string, Set<string>>();
  for (const c of citRows) {
    const h = resolveHouse(registry, c.url, c.title);
    houseById.set(h.house_id, { house_id: h.house_id, display_name: h.display_name });
    sources.push({
      source_id: c.id,
      house_id: h.house_id,
      title: c.title,
      url: c.url,
      source_document_id: c.source_document_id,
      content_hash: c.source_document_id ? (hashByDoc.get(c.source_document_id) ?? null) : null,
      resolution: c.resolution,
    });
    (housesByClaim.get(c.claim_id) ?? housesByClaim.set(c.claim_id, new Set()).get(c.claim_id)!).add(h.house_id);
  }

  // Figures grouped to their claim; their house_id is authoritative (registered).
  const figuresByClaim = new Map<string, StructuredFigure[]>();
  for (const f of figRows) {
    const fig: StructuredFigure = {
      house_id: f.house_id,
      value: Number(f.value),
      unit: f.unit,
      as_of_year: f.as_of_year,
      scope: f.scope,
      figure_kind: f.figure_kind === "derived" ? "derived" : "anchored",
      divergence_note: f.divergence_note,
      claim_citation_id: f.claim_citation_id,
      source_document_id: f.source_document_id,
    };
    (figuresByClaim.get(f.claim_id) ?? figuresByClaim.set(f.claim_id, []).get(f.claim_id)!).push(fig);
    // a figure's house counts toward its claim's support even if no separate citation row resolved to it
    if (!houseById.has(f.house_id)) {
      const reg = registry.find((r) => r.id === f.house_id);
      houseById.set(f.house_id, { house_id: f.house_id, display_name: reg?.canonical_name ?? f.house_id });
    }
    (housesByClaim.get(f.claim_id) ?? housesByClaim.set(f.claim_id, new Set()).get(f.claim_id)!).add(f.house_id);
  }

  const claims: ClaimGrounding[] = claimRows.map((c) => {
    const depQ = DEPENDS_ON_BY_QINDEX[c.question_index] ?? [];
    const dependsOn = depQ.map((qi) => idByQIndex.get(qi)).filter(Boolean) as string[];
    const baseStatus = c.claim_status as ClaimStatus;
    return {
      finding_id: c.claim_id,
      label: c.question_text,
      base_status: baseStatus,
      is_derived: dependsOn.length > 0 || baseStatus === "synthesis_inference",
      supporting_houses: [...(housesByClaim.get(c.claim_id) ?? [])],
      figures: figuresByClaim.get(c.claim_id) ?? [],
      depends_on: dependsOn,
    };
  });

  const houses = [...houseById.values()];
  const as_delivered_weights: Record<string, number> = {};
  for (const h of houses) as_delivered_weights[h.house_id] = 1;

  return { report_id: sessionId, base_snapshot_id: "", claims, houses, sources, as_delivered_weights };
}
