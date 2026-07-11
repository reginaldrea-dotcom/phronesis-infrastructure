// verify_figure — the Mode-1 figure-verification gate (baton b28d6e36; capability 'verify_figure';
// Phase-1 map SP 67b43866). READ-ONLY and mechanical: it answers ONE question — is THIS figure, as a value,
// actually present on the cited source page? — using the format-independent canonical_string match (Eames
// SP 6df44541, ported to TS in ../lib/canonicalString.ts). It writes nothing; it is the narrowest Mode-1 core.
//
// Verdict is ANCHORED or CITED_NOT_VERIFIED. Governing principle (Napoleon): ERR FALSE-NEGATIVE, NEVER
// FALSE-POSITIVE. A false CITED_NOT_VERIFIED is safe (the caller re-anchors); a false ANCHORED to the wrong
// figure is career-grade. So no tolerance band (7.6bn != 7.63bn), currency identity is strict (£ != $), and a
// bare number over a page that carries the same value in TWO currencies returns CITED_NOT_VERIFIED (ambiguous),
// never a guess. Financial Dossiers pass strict_currency=true (a bare number never matches a currency page).
//
// The page text is the FROZEN source: pass it directly (source_text) or by ground_fact_id (its captured
// content is scanned). Verifying against a frozen ground_fact is Mode-1 re-verification of a category-one figure.

import type { Tool, ToolContext } from "./types.ts";
import { figurePresent } from "../lib/canonicalString.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(msg: string): string {
  return `verify_figure error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const verifyFigureTool: Tool = {
  definition: {
    name: "verify_figure",
    description:
      "Verify that a cited figure is actually present on its source page — the Mode-1 check. Read-only and mechanical: give the figure exactly as a token (e.g. '£290m', '7.6bn', '12%') and the source, and it returns ANCHORED (the value is on the page, in any equivalent format) or CITED_NOT_VERIFIED. It matches VALUE, not presentation (7.6bn = 7,600,000,000 = 7,600 million), with NO tolerance (7.6bn is not 7.63bn), and currency identity is strict (£ never matches $). If a bare number could match two different currencies on the page, it returns CITED_NOT_VERIFIED rather than guess. Provide the page as source_text, or as ground_fact_id to scan a frozen ground-fact's captured content. Set strict_currency=true for financial Dossiers.",
    input_schema: {
      type: "object",
      properties: {
        figure: { type: "string", description: "The figure token to verify, exactly as it should read (e.g. '£290m', '7.6bn', '171,000', '12%')." },
        source_text: { type: "string", description: "The source page text to scan. Provide this OR ground_fact_id." },
        ground_fact_id: { type: "string", description: "A frozen ground_fact id whose captured content is the source page. Provide this OR source_text." },
        strict_currency: { type: "boolean", description: "Default false. True for financial Dossiers: a bare number never matches a currency-tagged figure." },
      },
      required: ["figure"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => `verify_figure: ${String((input as { figure?: unknown })?.figure ?? "").slice(0, 30)}`,

  run: async (input, ctx: ToolContext) => {
    const i = input as { figure?: unknown; source_text?: unknown; ground_fact_id?: unknown; strict_currency?: unknown };
    const figure = typeof i.figure === "string" ? i.figure.trim() : "";
    if (!figure) return fail("figure is required (the token to verify, e.g. '£290m').");
    const strictCurrency = i.strict_currency === true;

    // Resolve the page text: explicit source_text, or a frozen ground_fact's content.
    let pageText = typeof i.source_text === "string" ? i.source_text : "";
    let sourceRef: string | null = null;
    const gfId = typeof i.ground_fact_id === "string" ? i.ground_fact_id.trim() : "";
    if (!pageText && gfId) {
      if (!UUID_RE.test(gfId)) return fail("ground_fact_id must be a full UUID.");
      const gf = await ctx.supabase.from("ground_fact").select("id, title, content, source_url").eq("id", gfId).maybeSingle();
      if (gf.error) return fail(`ground_fact lookup failed: ${gf.error.message}`);
      if (!gf.data) return `${JSON.stringify({ verdict: "CITED_NOT_VERIFIED", reason: "source_not_found", ground_fact_id: gfId })}\n[SYSTEM: no ground_fact with that id; nothing to verify against. This is the answer.]`;
      const row = gf.data as { title: string | null; content: string | null; source_url: string | null };
      pageText = [row.title ?? "", row.content ?? ""].join("\n");
      sourceRef = gfId;
    }
    if (!pageText) return fail("provide the source: either source_text or a ground_fact_id whose content is the page.");

    const res = figurePresent(figure, pageText, strictCurrency);
    const verdict = res.anchored ? "ANCHORED" : "CITED_NOT_VERIFIED";

    const systemNote = res.anchored
      ? `ANCHORED: '${figure}' is present on the cited page as a matching value (format-independent, exact, currency-consistent). This figure is verified.`
      : res.reason === "page_ambiguous_currency"
        ? `CITED_NOT_VERIFIED (ambiguous): the page carries this value in more than one currency (${(res.matched_currencies ?? []).join(", ")}) and '${figure}' has no currency, so anchoring would be a guess. Re-cite with the currency, or verify against the specific frozen source. Erring false-negative is the safe answer.`
        : `CITED_NOT_VERIFIED: '${figure}' is NOT present on the cited page as an equivalent value. Do not anchor to a figure the source does not carry — re-anchor to what is actually on the page (the rounded token, if the page is rounded), or the figure needs grounding (Mode 2/3), not a Mode-1 anchor.`;

    return JSON.stringify({
      verdict,
      figure,
      strict_currency: strictCurrency,
      reason: res.reason,
      ...(res.matched_currencies ? { matched_currencies: res.matched_currencies } : {}),
      ...(sourceRef ? { ground_fact_id: sourceRef } : {}),
      "[SYSTEM]": systemNote,
    });
  },
};
