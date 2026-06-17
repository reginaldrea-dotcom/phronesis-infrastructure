// read_synthesis — read the assembled synthesis for a theo_session.
//
// Two modes (controlled by `knit`):
//   knit=false (default): returns the synthesis header + per-section list with
//                          short excerpts. Use to scan / check structure / find
//                          flagged sections without pulling the full text.
//   knit=true:             returns the full assembled markdown — the ordered
//                          concatenation of all sections — under `knit_md`.
//                          Use BEFORE delivery to verify the document reads as
//                          intended; the same concatenation is what the
//                          interface's query-path delivery returns to the panel.
//
// Always surfaces:
//   - sections flagged needs_review (with their join_note) at the top, so a
//     Ghostwheel review pass can be spotted immediately.
//   - any "gaps" the worker may have left (engine_dispatch rows still pending
//     or failed for this session) — synthesising on incomplete dispatch is a
//     known anti-pattern; the tool nudges Theo to check.

import type { Tool, ToolContext } from "./types.ts";

const ID_RE = /^[0-9a-f-]{4,36}$/i;
const EXCERPT_LEN = 400;

function excerpt(text: string | null): string | null {
  if (!text) return null;
  return text.length > EXCERPT_LEN ? text.slice(0, EXCERPT_LEN) + " …[truncated]" : text;
}

function fail(msg: string): string {
  return `read_synthesis error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const readSynthesisTool: Tool = {
  definition: {
    name: "read_synthesis",
    description:
      "Read the assembled synthesis for a theo_session. Default mode returns the synthesis header + per-section list with short excerpts (good for scanning structure and finding flagged join points). Pass knit=true to return the full assembled markdown — use before delivery to verify the document reads as intended. Always surfaces sections flagged needs_review (with join_note), any in-flight or failed engine_dispatch rows that mean the synthesis is being built on incomplete dispatch, and a `citations` block with each citation's resolution status (resolved vs 'unchecked' — i.e. whether a liveness pass has verified it) and anchored state (frozen-snapshot vs live URL), with exact counts.",
    input_schema: {
      type: "object",
      properties: {
        theo_session_id: { type: "string", description: "Session id — full UUID or a leading hex prefix." },
        knit: { type: "boolean", description: "If true, return the full ordered concatenation of all sections under `knit_md`. Default false (header + excerpts only)." },
      },
      required: ["theo_session_id"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const k = (input as { knit?: unknown })?.knit === true;
    return `read_synthesis${k ? " (knit)" : ""}`;
  },

  run: async (input, ctx: ToolContext) => {
    const i = input as Record<string, unknown>;
    const sessionRaw = typeof i?.theo_session_id === "string" ? i.theo_session_id.trim() : "";
    const knit = i?.knit === true;
    if (!ID_RE.test(sessionRaw)) return fail(`theo_session_id must be a UUID or hex prefix. Got: ${sessionRaw.slice(0, 40)}`);

    // Resolve theo_session_id
    const sessionLookup = await ctx.supabase.rpc("execute_raw_sql", {
      query: `SELECT id, state, refined_prompt, created_at, delivered_at FROM theo_session WHERE id::text LIKE '${sessionRaw}%' LIMIT 2`,
    });
    if (sessionLookup.error) return fail(`session lookup failed: ${sessionLookup.error.message}`);
    const sessRows = (sessionLookup.data ?? []) as Array<{
      id: string; state: string; refined_prompt: string | null;
      created_at: string; delivered_at: string | null;
    }>;
    if (sessRows.length === 0) return `[]\n[SYSTEM: no theo_session with id starting '${sessionRaw}'. This is the answer; do not retry.]`;
    if (sessRows.length > 1) return fail(`prefix '${sessionRaw}' matches ${sessRows.length} sessions — supply more characters.`);
    const session = sessRows[0];

    // Dispatch state guardrail — synthesising on incomplete dispatch is the anti-pattern.
    const dispatchCounts = await ctx.supabase
      .from("engine_dispatch")
      .select("status")
      .eq("theo_session_id", session.id);
    if (dispatchCounts.error) return fail(`dispatch counts failed: ${dispatchCounts.error.message}`);
    const counts = { pending: 0, dispatched: 0, completed: 0, partial: 0, failed: 0 };
    for (const r of (dispatchCounts.data ?? [])) {
      if (r.status in counts) counts[r.status as keyof typeof counts]++;
    }
    const inFlight = counts.pending + counts.dispatched;

    // Synthesis row + sections
    const synth = await ctx.supabase
      .from("synthesis")
      .select("id, created_at, layer_1_synthesis_md, layer_2_engine_reports_json, layer_3_portable_prompt, convergence_points_json, divergence_points_json, gaps_json, confidence_ratings_json, sources_json")
      .eq("theo_session_id", session.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (synth.error) return fail(`synthesis read failed: ${synth.error.message}`);
    if (!synth.data?.id) {
      return JSON.stringify({
        session: { id: session.id, state: session.state, refined_prompt: session.refined_prompt },
        synthesis: null,
        sections: [],
        dispatch_counts: counts,
        "[SYSTEM]": "no synthesis row exists for this session yet — start with write_synthesis_section to create one. This is the answer; do not retry.",
      });
    }

    const synthesisId = synth.data.id as string;
    const sectionsQ = await ctx.supabase
      .from("synthesis_section")
      .select("id, section_index, title, content_md, needs_review, join_note, created_at")
      .eq("synthesis_id", synthesisId)
      .order("section_index", { ascending: true });
    if (sectionsQ.error) return fail(`sections read failed: ${sectionsQ.error.message}`);
    const sectionRows = (sectionsQ.data ?? []) as Array<{
      id: string; section_index: number; title: string | null; content_md: string | null;
      needs_review: boolean; join_note: string | null; created_at: string;
    }>;

    const flagged = sectionRows.filter(s => s.needs_review).map(s => ({
      section_index: s.section_index,
      title: s.title,
      join_note: s.join_note,
    }));

    const sectionsOut = sectionRows.map(s => ({
      id: s.id,
      section_index: s.section_index,
      title: s.title,
      needs_review: s.needs_review,
      join_note: s.join_note,
      content_md_length: s.content_md?.length ?? 0,
      content_md_excerpt: knit ? null : excerpt(s.content_md),
    }));

    // C3 (baton df7cafbb) — surface citation-RESOLUTION status so verification can see resolved-vs-unchecked
    // THROUGH the tool. resolution defaults 'unchecked' at write_claims time and is only moved by a
    // separate citation-liveness pass (not yet built — queue.ts:150). Anchoring (source_document_id) is an
    // INDEPENDENT dimension (frozen snapshot vs live URL); we surface both so "anchored but unchecked" and
    // "unanchored" are each visible, not conflated. Read is bounded (synthesis citations are dozens, not
    // thousands); per-row list is capped, counts are always exact.
    const CITATION_ROW_CAP = 200;
    const claimIdsQ = await ctx.supabase.from("synthesis_claim").select("id").eq("synthesis_id", synthesisId);
    if (claimIdsQ.error) return fail(`claim lookup failed: ${claimIdsQ.error.message}`);
    const claimIds = (claimIdsQ.data ?? []).map(r => r.id as string);
    let citationRows: Array<{ id: string; claim_id: string; url: string | null; resolution: string; resolved_at: string | null; source_document_id: string | null; note: string | null }> = [];
    if (claimIds.length > 0) {
      const citQ = await ctx.supabase
        .from("claim_citation")
        .select("id, claim_id, url, resolution, resolved_at, source_document_id, note")
        .in("claim_id", claimIds);
      if (citQ.error) return fail(`citation lookup failed: ${citQ.error.message}`);
      citationRows = (citQ.data ?? []) as typeof citationRows;
    }
    const byResolution: Record<string, number> = {};
    let anchoredCount = 0;
    for (const c of citationRows) {
      byResolution[c.resolution] = (byResolution[c.resolution] ?? 0) + 1;
      if (c.source_document_id) anchoredCount++;
    }
    const resolvedCount = citationRows.length - (byResolution["unchecked"] ?? 0);
    const citations = {
      total: citationRows.length,
      // anchoring (frozen snapshot) — independent of resolution
      anchored: anchoredCount,
      unanchored: citationRows.length - anchoredCount,
      // resolution (liveness/verification state) — the C3 surface
      by_resolution: byResolution,
      resolved_or_checked: resolvedCount,   // anything not 'unchecked'
      unchecked: byResolution["unchecked"] ?? 0,
      rows: citationRows.slice(0, CITATION_ROW_CAP).map(c => ({
        id: c.id,
        claim_id: c.claim_id,
        url: c.url,
        resolution: c.resolution,
        resolved_at: c.resolved_at,
        anchored: !!c.source_document_id,
        note: c.note,
      })),
      rows_truncated: citationRows.length > CITATION_ROW_CAP ? citationRows.length - CITATION_ROW_CAP : 0,
    };

    let systemNote: string;
    if (sectionRows.length === 0) {
      systemNote = "synthesis row exists but has no sections — write sections with write_synthesis_section, starting with section_index 0 (executive summary).";
    } else if (inFlight > 0) {
      systemNote = `WARNING: ${inFlight} engines still in flight for this session (${counts.pending} pending, ${counts.dispatched} dispatched). Synthesising on incomplete dispatch — confirm this is intentional, or wait for the completion wake_delta and re-read.`;
    } else if (flagged.length > 0) {
      systemNote = `${sectionRows.length} sections written; ${flagged.length} flagged for Ghostwheel review (see flagged_sections). Resolve flags before delivery.`;
    } else {
      systemNote = `${sectionRows.length} sections written; nothing flagged. ${knit ? "Knit is in knit_md — verify it reads as intended before delivery." : "Pass knit=true to read the full assembled markdown."}`;
    }
    // C3 — append citation-resolution status so the verification signal is in the system line, not just buried.
    if (citations.total > 0 && citations.resolved_or_checked === 0) {
      systemNote += ` CITATIONS: ${citations.total} present, ${citations.anchored} anchored, but 0 resolved (all 'unchecked') — no citation-liveness pass has run on this synthesis; resolved-vs-unchecked cannot be trusted as verified yet.`;
    } else if (citations.total > 0) {
      systemNote += ` CITATIONS: ${citations.resolved_or_checked}/${citations.total} resolved (non-'unchecked'), ${citations.anchored}/${citations.total} anchored.`;
    }

    const result: Record<string, unknown> = {
      session: {
        id: session.id,
        state: session.state,
        refined_prompt: session.refined_prompt,
        created_at: session.created_at,
        delivered_at: session.delivered_at,
      },
      synthesis: {
        id: synthesisId,
        created_at: synth.data.created_at,
        layer_1_present: !!synth.data.layer_1_synthesis_md,
        gaps_json: synth.data.gaps_json,
        convergence_points_json: synth.data.convergence_points_json,
        divergence_points_json: synth.data.divergence_points_json,
        sources_json: synth.data.sources_json,
      },
      dispatch_counts: counts,
      citations,                  // C3 (df7cafbb) — per-citation resolution + anchored state, with exact counts
      sections: sectionsOut,
      flagged_sections: flagged,
      "[SYSTEM]": systemNote,
    };

    if (knit) {
      result.knit_md = sectionRows.map(s => s.content_md ?? "").join("\n\n");
      result.knit_md_length = (result.knit_md as string).length;
    }

    return JSON.stringify(result);
  },
};
