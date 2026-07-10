// trace_interrogation — the INTERROGATE TRACE (Delphia enforcement lane, piece 4; baton cdb7693c /
// conf 75d90356; ruling msg 6a0cd457). The grounding gate an interrogate answer passes through BELOW
// THE MODEL, built on the live element_dependency graph (Eames a2310ece) that write_element_dependency
// already populates. Its job is NOT the model's job of writing prose — it is the SERVER's verdict on
// whether each assertion the model drafted is a GROUNDED claim or the MODEL advancing a claim of its own.
//
// THE LOAD-BEARING DISTINCTION (Napoleon's ruling): the test is not "does this assertion have a source"
// but "is this grounded, or is the model becoming the claimant?"
//   KEEP     — a claim that RESOLVES in the graph: a synthesis_claim with ≥1 claim_on_fact edge to a
//              real ground_fact/claim_figure, or a fact/figure cited directly. Carried with the tier of
//              what actually grounds it (a contested political statement grounds fine AS AN ATTRIBUTION —
//              what is grounded is "X asserted it," tiered tier-3, not the causal claim itself).
//   WITHHOLD — the same causal claim in the model's OWN VOICE with no source, OR a citation that does not
//              resolve. Withheld because it launders a contested inference into the neutral authority of
//              the grounded record and silently takes a side. The model may report that someone made a
//              claim; it may not make the claim.
//   BLEND    — the model is required to SPLIT: "Net migration fell to 685k [figure -> KEEP], a clear sign
//              the strategy is working [model's own leap -> WITHHOLD]." Figure kept, tail withheld.
//
// The gap-note states the SHAPE OF THE EVIDENCE — an ABSENCE OF SOURCE, not an absence of truth. Never
// "the evidence doesn't support this" (that concedes the causal link is an open question the Dossier
// merely hasn't closed). It reports what is present and what is absent and gets out of the way.
//
// The verdict is the SERVER's: the graph walk runs here, so a citation that does not resolve cannot be
// dressed as grounded, and an uncited factual segment cannot pass. RESIDUAL (documented for Aegis's
// Denial Proof): the server cannot semantically detect a leap smuggled INSIDE a segment that cites a real
// figure — hence the split requirement + tier-labelling narrow it, and delivery-only-via-trace-token is a
// noted piece-4b hardening. This tool is ungated by the sealed permit: it is Delphia's SANCTIONED answer
// path (the free_write gate, elsewhere, is what makes it her ONLY path).

import type { Tool, ToolContext } from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEGMENTS = 60;

type Grounding = "synthesis_claim" | "ground_fact" | "claim_figure" | "model_voice";

interface SegmentIn {
  text?: unknown;
  grounding?: unknown;
  ref_id?: unknown;
  as_attribution?: unknown;
  attributed_to?: unknown;
}

function fail(msg: string): string {
  return `trace_interrogation error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

// A claim/fact/figure the answer rests on, as the graph reports it.
interface ClaimResolution {
  claim_id: string;
  found: boolean;
  claim_text: string | null;
  assertion_contestability: string | null;
  claim_role: string | null;
  support: Array<{ kind: "ground_fact" | "claim_figure"; id: string; tier: string | null; source_url: string | null }>;
}

export const traceInterrogationTool: Tool = {
  definition: {
    name: "trace_interrogation",
    description:
      "The grounding gate for answering a Dossier interrogation. You DRAFT your answer as an ordered list of atomic segments; this tool returns the SERVER-VETTED answer, walking the live claim->fact dependency graph below the model. A segment that cites a synthesis_claim/ground_fact/claim_figure is KEPT only if it actually resolves to supporting evidence (you cannot dress an unresolved citation as grounded); a segment in your own voice with no source, or an unresolved citation, is WITHHELD and replaced with a gap-note that states the absence of a SOURCE (never absence of truth). SPLIT leaps out: cite the figure in one segment, put the inference it suggests in its own model_voice segment — the figure is kept, the leap withheld. A contested/attributed claim grounds fine AS AN ATTRIBUTION (tiered as what it is). Deliver the returned vetted_answer verbatim; it is the answer.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The interrogation question being answered (context + audit)." },
        dossier_id: { type: "string", description: "The Dossier (synthesis) being interrogated — the scope of this answer." },
        segments: {
          type: "array",
          description: "Your drafted answer, atomised. Each segment is one assertion. Split any figure from the inference it suggests.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The assertion, as you would say it." },
              grounding: {
                type: "string",
                enum: ["synthesis_claim", "ground_fact", "claim_figure", "model_voice"],
                description: "What backs this segment. model_voice = your own inference/framing with no source (it will be withheld if factual).",
              },
              ref_id: { type: "string", description: "Id of the synthesis_claim / ground_fact / claim_figure this rests on. Required unless grounding is model_voice." },
              as_attribution: { type: "boolean", description: "True if this reports THAT someone asserted a claim (grounded as an attribution), not the house asserting it." },
              attributed_to: { type: "string", description: "Who the claim is attributed to, when as_attribution is true." },
            },
            required: ["text", "grounding"],
          },
        },
      },
      required: ["question", "dossier_id", "segments"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const segs = (input as { segments?: unknown[] })?.segments;
    return `trace_interrogation: ${Array.isArray(segs) ? segs.length : 0} segment(s)`;
  },

  run: async (input, ctx: ToolContext) => {
    const i = input as { question?: unknown; dossier_id?: unknown; segments?: unknown };
    const question = typeof i.question === "string" ? i.question.trim() : "";
    const dossierId = typeof i.dossier_id === "string" ? i.dossier_id.trim() : "";
    if (!question) return fail("question is required.");
    if (!dossierId) return fail("dossier_id is required (the Dossier being interrogated).");
    if (!Array.isArray(i.segments) || i.segments.length === 0) return fail("segments must be a non-empty array of drafted assertions.");
    if (i.segments.length > MAX_SEGMENTS) return fail(`too many segments (${i.segments.length} > ${MAX_SEGMENTS}). Answer more concisely.`);

    // Normalise + validate each segment. A cited grounding needs a UUID ref; a bad ref is treated as an
    // unresolved citation (withheld), never trusted.
    const segs = (i.segments as SegmentIn[]).map((s, idx) => {
      const grounding = String(s.grounding ?? "") as Grounding;
      const ref = typeof s.ref_id === "string" ? s.ref_id.trim() : "";
      return {
        index: idx,
        text: typeof s.text === "string" ? s.text.trim() : "",
        grounding,
        ref_id: ref,
        ref_valid: UUID_RE.test(ref),
        as_attribution: s.as_attribution === true,
        attributed_to: typeof s.attributed_to === "string" ? s.attributed_to.trim() : null,
      };
    });

    // Collect the ids we must resolve against the graph, by kind. Only well-formed UUIDs go to the DB.
    const claimIds = [...new Set(segs.filter(s => s.grounding === "synthesis_claim" && s.ref_valid).map(s => s.ref_id))];
    const factIds = [...new Set(segs.filter(s => s.grounding === "ground_fact" && s.ref_valid).map(s => s.ref_id))];
    const figureIds = [...new Set(segs.filter(s => s.grounding === "claim_figure" && s.ref_valid).map(s => s.ref_id))];

    const claimRes = new Map<string, ClaimResolution>();
    const factRes = new Map<string, { tier: string | null; source_url: string | null }>();
    const figureRes = new Map<string, { tier: string | null; value: number | null; unit: string | null }>();

    const sqlList = (ids: string[]) => ids.map(id => `'${id}'`).join(","); // ids are UUID_RE-validated

    try {
      // Reverse graph walk: for each cited synthesis_claim, its claim_on_fact support (fact or figure),
      // joined to the tier of what grounds it. LEFT JOINs so a claim with zero support still returns one row.
      if (claimIds.length > 0) {
        const q = `
          SELECT sc.id AS claim_id, sc.claim_text, sc.assertion_contestability, sc.claim_role,
                 gf.id AS gf_id, gf.authority_tier AS gf_tier, gf.source_url AS gf_source,
                 cf.id AS cf_id, cf.provenance_tier AS cf_tier
          FROM synthesis_claim sc
          LEFT JOIN element_dependency ed
            ON ed.dependent_synthesis_claim_id = sc.id AND ed.edge_kind = 'claim_on_fact'
          LEFT JOIN ground_fact gf ON gf.id = ed.depends_on_ground_fact_id
          LEFT JOIN claim_figure cf ON cf.id = ed.depends_on_claim_figure_id
          WHERE sc.id IN (${sqlList(claimIds)})`;
        const r = await ctx.supabase.rpc("execute_raw_sql", { query: q });
        if (r.error) return fail(`claim resolution failed: ${r.error.message}`);
        for (const row of (r.data ?? []) as Array<Record<string, unknown>>) {
          const cid = String(row.claim_id);
          let cr = claimRes.get(cid);
          if (!cr) {
            cr = {
              claim_id: cid, found: true,
              claim_text: (row.claim_text as string) ?? null,
              assertion_contestability: (row.assertion_contestability as string) ?? null,
              claim_role: (row.claim_role as string) ?? null,
              support: [],
            };
            claimRes.set(cid, cr);
          }
          if (row.gf_id) cr.support.push({ kind: "ground_fact", id: String(row.gf_id), tier: (row.gf_tier as string) ?? null, source_url: (row.gf_source as string) ?? null });
          else if (row.cf_id) cr.support.push({ kind: "claim_figure", id: String(row.cf_id), tier: (row.cf_tier as string) ?? null, source_url: null });
        }
      }

      if (factIds.length > 0) {
        const r = await ctx.supabase.rpc("execute_raw_sql", {
          query: `SELECT id, authority_tier, source_url FROM ground_fact WHERE id IN (${sqlList(factIds)})`,
        });
        if (r.error) return fail(`ground_fact resolution failed: ${r.error.message}`);
        for (const row of (r.data ?? []) as Array<Record<string, unknown>>) {
          factRes.set(String(row.id), { tier: (row.authority_tier as string) ?? null, source_url: (row.source_url as string) ?? null });
        }
      }

      if (figureIds.length > 0) {
        const r = await ctx.supabase.rpc("execute_raw_sql", {
          query: `SELECT id, provenance_tier, value, unit FROM claim_figure WHERE id IN (${sqlList(figureIds)})`,
        });
        if (r.error) return fail(`claim_figure resolution failed: ${r.error.message}`);
        for (const row of (r.data ?? []) as Array<Record<string, unknown>>) {
          figureRes.set(String(row.id), { tier: (row.provenance_tier as string) ?? null, value: (row.value as number) ?? null, unit: (row.unit as string) ?? null });
        }
      }
    } catch (err) {
      return fail(`graph walk failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Adjudicate each segment against what the graph actually returned. The verdict is the server's.
    const GAP_MODEL_VOICE = "[Withheld: this is an inference in the assistant's own voice; no source in the Dossier makes this claim.]";
    const GAP_UNGROUNDED_CLAIM = "no source in the Dossier grounds this claim";
    const GAP_UNRESOLVED = "[Withheld: the cited record could not be resolved in this Dossier; it grounds nothing.]";

    const ledger = segs.map((s) => {
      // 1. Own-voice / uncited factual segment — the model becoming the claimant. Withheld.
      if (s.grounding === "model_voice" || !s.ref_id) {
        return { index: s.index, disposition: "withheld", reason: "model_voice", tier: null,
                 text: s.text, rendered: GAP_MODEL_VOICE, attribution: null as string | null };
      }
      // 2. Malformed / unresolvable citation — never trusted as grounded.
      if (!s.ref_valid) {
        return { index: s.index, disposition: "withheld", reason: "unresolved_ref", tier: null,
                 text: s.text, rendered: GAP_UNRESOLVED, attribution: null };
      }

      if (s.grounding === "synthesis_claim") {
        const cr = claimRes.get(s.ref_id);
        if (!cr || !cr.found) {
          return { index: s.index, disposition: "withheld", reason: "unresolved_ref", tier: null,
                   text: s.text, rendered: GAP_UNRESOLVED, attribution: null };
        }
        if (cr.support.length === 0) {
          // The claim exists in the record but rests on nothing. State present-and-absent, not "unsupported".
          const note = `[Withheld: the Dossier records this claim, but ${GAP_UNGROUNDED_CLAIM}.]`;
          return { index: s.index, disposition: "withheld", reason: "ungrounded_claim", tier: null,
                   text: s.text, rendered: note, attribution: null };
        }
        // Grounded. Tier = the strongest thing that grounds it (first support's tier is representative).
        const tier = cr.support.find(x => x.tier)?.tier ?? null;
        const contested = (cr.assertion_contestability && cr.assertion_contestability !== "settled") || s.as_attribution;
        const attribution = s.as_attribution ? (s.attributed_to || cr.claim_role || null) : null;
        return { index: s.index, disposition: "kept", reason: contested ? "grounded_attribution" : "grounded",
                 tier, text: s.text, rendered: s.text, attribution };
      }

      if (s.grounding === "ground_fact") {
        const f = factRes.get(s.ref_id);
        if (!f) return { index: s.index, disposition: "withheld", reason: "unresolved_ref", tier: null,
                         text: s.text, rendered: GAP_UNRESOLVED, attribution: null };
        return { index: s.index, disposition: "kept", reason: "grounded", tier: f.tier,
                 text: s.text, rendered: s.text, attribution: s.as_attribution ? (s.attributed_to || null) : null };
      }

      // claim_figure
      const fg = figureRes.get(s.ref_id);
      if (!fg) return { index: s.index, disposition: "withheld", reason: "unresolved_ref", tier: null,
                        text: s.text, rendered: GAP_UNRESOLVED, attribution: null };
      return { index: s.index, disposition: "kept", reason: "grounded", tier: fg.tier,
               text: s.text, rendered: s.text, attribution: s.as_attribution ? (s.attributed_to || null) : null };
    });

    const kept = ledger.filter(l => l.disposition === "kept").length;
    const withheld = ledger.length - kept;

    // The vetted answer: kept segments carry their (attribution/tier) framing; withheld ones become the
    // gap-note in place, so the answer's shape is preserved and the reader sees exactly where a source ran out.
    const vetted_answer = ledger.map(l =>
      l.disposition === "kept"
        ? { text: l.rendered, tier: l.tier, ...(l.attribution ? { attributed_to: l.attribution } : {}), ...(l.reason === "grounded_attribution" ? { framing: "attribution" } : {}) }
        : { withheld: true, note: l.rendered, reason: l.reason }
    );

    const systemNote =
      withheld === 0
        ? `All ${kept} segment(s) resolved to supporting evidence in the graph. Deliver vetted_answer verbatim — every line is grounded (attributions tiered as attributions).`
        : `${kept} grounded, ${withheld} WITHHELD below the model. Deliver vetted_answer verbatim: the withheld lines are gap-notes stating absence-of-source, not absence-of-truth. Do NOT re-assert a withheld claim in your prose, and do NOT soften a gap-note into a hedge — the server has ruled these are the model's own leaps or unresolved citations, and that ruling stands.`;

    return JSON.stringify({
      ok: true,
      question,
      dossier_id: dossierId,
      kept,
      withheld,
      vetted_answer,
      ledger,
      "[SYSTEM]": systemNote,
    });
  },
};
