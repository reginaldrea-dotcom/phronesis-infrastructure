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
      "Read the assembled synthesis for a theo_session. Default mode returns the synthesis header + per-section list with short excerpts (good for scanning structure and finding flagged join points). Pass knit=true to return the full assembled markdown — use before delivery to verify the document reads as intended. Always surfaces sections flagged needs_review (with join_note) and any in-flight or failed engine_dispatch rows that mean the synthesis is being built on incomplete dispatch.",
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
