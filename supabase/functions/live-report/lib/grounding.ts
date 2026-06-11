// Read the LOCKED cells (the anchored claim spine + structured figures) for a report
// into the immutable Grounding object. This live read runs ONCE, to mint the baseline
// snapshot; thereafter recompute derives from the frozen grounding pinned in that
// snapshot (SP 2e97d74e — recompute never re-reads live tables, so v2+ is reproducible).
//
// Built against the PROPOSED schema (claim_figure pending Connie). The figure read is
// wrapped so the engine degrades to STATUS-ONLY cleanly before the table exists, and
// lights up numeric the moment it lands and Theo populates it — no redeploy needed.

import type { Grounding, ClaimGrounding, ClaimStatus, House, SourceCell, StructuredFigure } from "./types.ts";
import { houseForCitation } from "./houses.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

// PROVISIONAL dependency edges for the AESSEAL spine, by question_index — pending Theo's
// A2 confirmation (msg 8479ef1c). Market size (index 0) is the denominator; the share /
// breakdown findings derive from it. Swap this for Theo's confirmed edge set before freeze.
const DEPENDS_ON_BY_QINDEX: Record<number, number[]> = {
  0: [],     // global market size — the denominator
  1: [],     // how houses size the market — sibling to 0, not downstream
  2: [0],    // regional breakdown — share of market size
  3: [0],    // end-use breakdown — share of market size
  4: [0],    // product-line split — share of market size
  5: [],     // named research houses
  6: [],     // engine-failure meta-claim
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

  // Structured figures (PROPOSED claim_figure). Degrade to [] if the table is absent.
  let figRows: Array<{ claim_citation_id: string; house_key: string; value: number; unit: string | null; as_of_year: string | null; scope: string | null; source_document_id?: string | null }> = [];
  try {
    const figRes = await supabase
      .from("claim_figure")
      .select("claim_citation_id, house_key, value, unit, as_of_year, scope");
    if (!figRes.error && figRes.data) figRows = figRes.data;
  } catch {
    // table not yet created — status-only until it lands + is populated
  }

  // Build house registry + source cells, keyed by house (dedup across citations/engines).
  const houseById = new Map<string, House>();
  const houseByCitation = new Map<string, string>();
  const sources: SourceCell[] = [];
  for (const c of citRows) {
    const h = houseForCitation(c.url, c.title);
    houseById.set(h.house_key, h);
    houseByCitation.set(c.id, h.house_key);
    sources.push({
      source_id: c.id,
      house_key: h.house_key,
      title: c.title,
      url: c.url,
      source_document_id: c.source_document_id,
      content_hash: c.source_document_id ? (hashByDoc.get(c.source_document_id) ?? null) : null,
      resolution: c.resolution,
    });
  }

  // Figures grouped to their claim (via citation), carrying the house_key authored research-side.
  const claimByCitation = new Map(citRows.map((c) => [c.id, c.claim_id]));
  const figuresByClaim = new Map<string, StructuredFigure[]>();
  for (const f of figRows) {
    const claimId = claimByCitation.get(f.claim_citation_id);
    if (!claimId) continue;
    const docForCit = citRows.find((c) => c.id === f.claim_citation_id)?.source_document_id ?? null;
    const fig: StructuredFigure = {
      house_key: f.house_key,
      value: Number(f.value),
      unit: f.unit,
      as_of_year: f.as_of_year,
      scope: f.scope,
      claim_citation_id: f.claim_citation_id,
      source_document_id: docForCit,
    };
    (figuresByClaim.get(claimId) ?? figuresByClaim.set(claimId, []).get(claimId)!).push(fig);
  }

  // Supporting houses per claim (deduped) from its citations.
  const housesByClaim = new Map<string, Set<string>>();
  for (const c of citRows) {
    const hk = houseByCitation.get(c.id)!;
    (housesByClaim.get(c.claim_id) ?? housesByClaim.set(c.claim_id, new Set()).get(c.claim_id)!).add(hk);
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
  for (const h of houses) as_delivered_weights[h.house_key] = 1;

  return {
    report_id: sessionId,
    base_snapshot_id: "",   // filled by the snapshot layer when the baseline is minted
    claims,
    houses,
    sources,
    as_delivered_weights,
  };
}
