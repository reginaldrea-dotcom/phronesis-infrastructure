// write_figure — the research-side writer for the structured-figure spine (claim_figure).
// Contract: SP 1ed3037a (Theo); claim_figure schema: Connie msg 1768734a; Decision 1 on
// SP 2e97d74e. A load-bearing number is authored as FIELDS by the researcher who verified
// it — never parsed from prose, always pinned to a RESOLVED citation. Closes the
// "claim_figure has no writer" block; keeps the front-capture/verification checkpoint
// UPSTREAM of the structured spine the recompute engine trusts as ground truth.
//
// Signature: write_figure(claim_id, claim_citation_id, value, unit, as_of_year, scope,
//                         house, divergence_note?) -> inserts one claim_figure row.
//
// The seven methodological guards (SP §contract, non-negotiable):
//  1. RESOLVED-PIN  — reject unless the citation's resolution = 'resolved'. A figure
//     inherits trust solely from its pinned citation; structure only after the checkpoint.
//  2. NO PARSE      — value/unit/as_of_year/scope are caller-supplied; the tool never reads
//     claim_text (the field interface forbids year-binding/Earth-Mars drift by construction).
//  3. PIN INTEGRITY — the citation must belong to claim_id; source_document_id is taken FROM
//     the citation row, never supplied — a figure cannot be pinned to a source the citation
//     does not carry.
//  4. YEAR MANDATORY — as_of_year is required at the tool (the anti-year-binding guard),
//     though the column is nullable.
//  5. HOUSE REGISTERED — `house` resolves to house_id via Connie's source_house_id_for()
//     resolver (canonical_name + aliases); unregistered -> reject. Keeps circularity keyed
//     on canonical houses (reweight a house, all its figures move as one).
//  6. ANCHORED SOURCED ONLY — fixes provenance_tier='sourced', figure_kind='anchored'.
//     Derived/formula figures are the recompute engine's output, not this tool; client tiers
//     are phase-2 intake.
//  7. DIVERGENCE PRESERVED — divergence_note carries year/scope/house splits; distinct-year
//     figures of one house are SEPARATE rows (one write_figure call each), never merged.

import type { Tool, ToolContext } from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Caller-correctable validation errors (the researcher can fix these: resolve the
// citation, register the house, supply the year) — phrased to act on, not to escalate.
function reject(msg: string): string {
  return `write_figure rejected: ${msg}`;
}

interface FigureIn {
  claim_id?: unknown;
  claim_citation_id?: unknown;
  value?: unknown;
  unit?: unknown;
  as_of_year?: unknown;
  scope?: unknown;
  house?: unknown;
  divergence_note?: unknown;
}

export const writeFigureTool: Tool = {
  definition: {
    name: "write_figure",
    description:
      "Write ONE verified structured figure to the figure spine (claim_figure) — a load-bearing number authored as fields, pinned to a RESOLVED citation. Use this AFTER the citation has passed the verification checkpoint (resolution='resolved'); structure only what you have verified. The fields you pass ARE the figure — never transcribe from prose you have not checked. Required: claim_id, claim_citation_id (must be one of that claim's citations, and resolved), value, unit, as_of_year (mandatory — no sourced figure may be year-ambiguous), house (a research house registered in source_house — its canonical name or a known alias). Optional: scope, divergence_note (use it to keep distinct-year/scope/house splits apart — e.g. 'Mordor 7.62 FY2025 vs 7.97 2026'; write a SEPARATE figure per distinct year). The source_document_id is taken from the citation automatically; you cannot pin a figure to a source the citation does not carry. This tool writes only anchored, sourced figures — derived/formula values and client data are not written here.",
    input_schema: {
      type: "object",
      properties: {
        claim_id: { type: "string", description: "The synthesis_claim id this figure belongs to (full UUID)." },
        claim_citation_id: { type: "string", description: "The resolved claim_citation id this figure is pinned to (full UUID). Must be a citation of claim_id." },
        value: { type: "number", description: "The numeric value of the figure (e.g. 7.62)." },
        unit: { type: "string", description: "The unit, e.g. 'USD bn', '%'." },
        as_of_year: { type: "integer", description: "REQUIRED. The year the figure is as-of, e.g. 2025. Disambiguates year-bound figures." },
        scope: { type: "string", description: "What the figure measures (e.g. 'global market size', 'APAC share'). Optional but recommended." },
        house: { type: "string", description: "The research house that published the figure — its canonical name or a known alias (must be registered in source_house)." },
        divergence_note: { type: "string", description: "Optional: note preserving a year/scope/house split (distinct-year figures of one house are separate rows)." },
      },
      required: ["claim_id", "claim_citation_id", "value", "unit", "as_of_year", "house"],
    },
  },

  // Deliberate write surface — withheld on the wake turn, like the other writers.
  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const i = input as FigureIn;
    const v = typeof i?.value === "number" ? i.value : "?";
    const u = typeof i?.unit === "string" ? i.unit : "";
    const y = Number.isInteger(i?.as_of_year) ? i.as_of_year : "?";
    return `write_figure: ${v} ${u} @ ${y}`;
  },

  run: async (input, ctx: ToolContext) => {
    const i = input as FigureIn;

    // ── field validation ──────────────────────────────────────────────────
    const claimId = typeof i?.claim_id === "string" ? i.claim_id.trim() : "";
    const citationId = typeof i?.claim_citation_id === "string" ? i.claim_citation_id.trim() : "";
    if (!UUID_RE.test(claimId)) return reject("claim_id must be a full UUID.");
    if (!UUID_RE.test(citationId)) return reject("claim_citation_id must be a full UUID.");

    if (typeof i?.value !== "number" || !Number.isFinite(i.value)) return reject("value must be a finite number (the field interface forbids transcribing from prose — guard 2).");
    const unit = typeof i?.unit === "string" ? i.unit.trim() : "";
    if (!unit) return reject("unit is required (e.g. 'USD bn', '%').");

    // Guard 4 — YEAR MANDATORY.
    if (!Number.isInteger(i?.as_of_year)) return reject("as_of_year is required and must be an integer — no sourced figure may be year-ambiguous (guard 4).");
    const asOfYear = i.as_of_year as number;

    const house = typeof i?.house === "string" ? i.house.trim() : "";
    if (!house) return reject("house is required (the research house that published the figure).");
    const scope = typeof i?.scope === "string" && i.scope.trim() ? i.scope.trim() : null;
    const divergenceNote = typeof i?.divergence_note === "string" && i.divergence_note.trim() ? i.divergence_note.trim() : null;

    // ── Guard 1+3 — citation must exist, belong to the claim, be resolved, and carry a source ──
    const cit = await ctx.supabase
      .from("claim_citation")
      .select("id, claim_id, resolution, source_document_id")
      .eq("id", citationId)
      .maybeSingle();
    if (cit.error) return reject(`citation lookup failed: ${cit.error.message}`);
    if (!cit.data) return reject(`no claim_citation with id ${citationId}.`);
    const citation = cit.data as { id: string; claim_id: string; resolution: string; source_document_id: string | null };

    // Guard 3 — PIN INTEGRITY.
    if (citation.claim_id !== claimId) {
      return reject(`pin integrity: citation ${citationId} belongs to claim ${citation.claim_id}, not ${claimId}. A figure can only pin to one of its own claim's citations.`);
    }
    // Guard 1 — RESOLVED-PIN.
    if (citation.resolution !== "resolved") {
      return reject(`citation not verified (resolution='${citation.resolution}') — structure only after the checkpoint clears it to 'resolved'.`);
    }
    // Guard 3 — source taken FROM the citation (schema backstop: anchored requires a source).
    const sourceDocumentId = citation.source_document_id;
    if (!sourceDocumentId) {
      return reject(`citation ${citationId} has no source_document_id — an anchored figure must pin to a frozen source. Anchor the citation first.`);
    }

    // ── Guard 5 — HOUSE REGISTERED (via Connie's resolver; do not reimplement the alias match) ──
    const hr = await ctx.supabase.rpc("source_house_id_for", { p_source: house });
    if (hr.error) {
      return reject(`house resolver source_house_id_for unavailable (${hr.error.message}). The figure spine cannot accept writes until the resolver is in place.`);
    }
    const houseId = hr.data as string | null;
    if (!houseId) {
      return reject(`house '${house}' is not registered in source_house — register the house first, then write the figure (keeps reweighting keyed on canonical houses).`);
    }

    // ── Guard 6 — anchored, sourced only; insert one row ──────────────────
    const ins = await ctx.supabase
      .from("claim_figure")
      .insert({
        claim_id: claimId,
        claim_citation_id: citationId,
        source_document_id: sourceDocumentId,
        house_id: houseId,
        value: i.value,
        unit,
        as_of_year: asOfYear,
        scope,
        provenance_tier: "sourced",
        figure_kind: "anchored",
        divergence_note: divergenceNote,
      })
      .select("id")
      .single();
    if (ins.error) return reject(`claim_figure insert failed: ${ins.error.message}`);

    return JSON.stringify({
      figure_id: ins.data.id,
      claim_id: claimId,
      claim_citation_id: citationId,
      house_id: houseId,
      source_document_id: sourceDocumentId,
      value: i.value,
      unit,
      as_of_year: asOfYear,
      scope,
      "[SYSTEM]": `Figure written to the structured spine: ${i.value} ${unit} @ ${asOfYear}${scope ? ` (${scope})` : ""}, pinned to a resolved citation and its frozen source, keyed to a registered house. It is now ground truth the recompute engine trusts — anchored + sourced, verified upstream. Distinct-year figures of this house are separate rows; write each one.`,
    });
  },
};
