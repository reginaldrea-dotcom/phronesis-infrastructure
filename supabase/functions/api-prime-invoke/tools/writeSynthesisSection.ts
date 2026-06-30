// write_synthesis_section — Theo's tool for writing one chapter of an assembled synthesis.
//
// One row per section_index IS the section. Re-call with the same theo_session_id
// + section_index to revise that section (UPDATE the row, do not create a new one).
//
// The synthesis row (parent) is auto-created on first section write for a
// session. Convention: section_index 0 is the executive summary; 1..N are
// chapters. Knit consumer = SELECT content_md ORDER BY section_index.
//
// needs_review + join_note serve Ghostwheel's editorial gate: flag a section
// when a join between chapters needs human eyes (mismatched register, unclear
// transition, contested claim spanning two sources). The note explains WHAT
// needs review so a reviewer can act without re-reading the whole chapter.
//
// De-tell convention (MST standing rule): no em-dashes in delivery docs; show
// don't tell; verified-source labelling. This is content discipline enforced
// in prose, not in code — the model owns it.
//
// RLS: synthesis_section is sealed deny-all. This tool relies on api-prime-invoke's
// service-role client (bypasses RLS) — same channel that writes the section as
// the worker writes engine_dispatch.

import type { Tool, ToolContext } from "./types.ts";
import { resolveCaptureSession } from "../lib/resolveCaptureSession.ts";

const ID_RE = /^[0-9a-f-]{4,36}$/i;

function fail(msg: string): string {
  return `write_synthesis_section error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const writeSynthesisSectionTool: Tool = {
  definition: {
    name: "write_synthesis_section",
    description:
      "Write or revise one chapter/section of an assembled synthesis. One row per section_index IS the section — re-call with the same theo_session_id + section_index to UPDATE that section (not create a new one). The synthesis row is auto-created on first call for a session. Convention: section_index 0 is the executive summary; 1..N are chapters. needs_review + join_note flag a section for Ghostwheel review at a specific join point. Follow MST de-tell discipline in the content_md itself (no em-dashes in delivery docs; show don't tell; verified-source labelling).",
    input_schema: {
      type: "object",
      properties: {
        theo_session_id: { type: "string", description: "Session id — full UUID or a leading hex prefix." },
        section_index: { type: "integer", minimum: 0, description: "0 for executive summary; 1..N for chapters in order. Same index = revise same section." },
        title: { type: "string", description: "Optional section title (heading). Omit to leave existing unchanged on revision." },
        content_md: { type: "string", description: "Section body as markdown. Replaces existing content on revision." },
        needs_review: { type: "boolean", description: "Optional: flag this section for Ghostwheel review at a specific join point. Pair with join_note." },
        join_note: { type: "string", description: "Optional: explain WHAT needs review (e.g. 'register shift from chapter 2 — verify tone match'). Required-in-spirit when needs_review=true." },
      },
      required: ["theo_session_id", "section_index", "content_md"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const i = (input as { section_index?: unknown })?.section_index;
    const review = (input as { needs_review?: unknown })?.needs_review === true ? " (needs_review)" : "";
    return `write_synthesis_section: idx=${typeof i === "number" ? i : "?"}${review}`;
  },

  run: async (input, ctx: ToolContext) => {
    const i = input as Record<string, unknown>;
    const sessionRaw = typeof i?.theo_session_id === "string" ? i.theo_session_id.trim() : "";
    const sectionIdx = typeof i?.section_index === "number" ? i.section_index : NaN;
    const contentMd = typeof i?.content_md === "string" ? i.content_md : "";
    const title = typeof i?.title === "string" ? i.title : null;
    const needsReview = i?.needs_review === true;
    const joinNote = typeof i?.join_note === "string" ? i.join_note : null;

    if (!ID_RE.test(sessionRaw)) return fail(`theo_session_id must be a UUID or hex prefix. Got: ${sessionRaw.slice(0, 40)}`);
    if (!Number.isInteger(sectionIdx) || sectionIdx < 0) return fail("section_index must be a non-negative integer.");
    if (!contentMd) return fail("content_md is required (non-empty string).");
    if (needsReview && !joinNote) {
      return fail("needs_review=true requires join_note (explain what to review at this join point).");
    }

    // Resolve theo_session_id (prefix-tolerant; also accepts a synthesis_id and maps
    // it to its session — the model routinely conflates the two ids).
    const resolved = await resolveCaptureSession(ctx.supabase, sessionRaw);
    if ("err" in resolved) return fail(resolved.err);
    const theoSessionId = resolved.sessionId;
    const idNote = resolved.note ? ` (note: ${resolved.note})` : "";

    // Find-or-create the synthesis row for this session. Single synthesis per
    // session in Phase 1 (no explicit UNIQUE on synthesis.theo_session_id, but
    // the tool enforces the convention here).
    let synthesisId: string;
    {
      const existing = await ctx.supabase
        .from("synthesis")
        .select("id")
        .eq("theo_session_id", theoSessionId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing.error) return fail(`synthesis lookup failed: ${existing.error.message}`);
      if (existing.data?.id) {
        synthesisId = existing.data.id as string;
      } else {
        const insert = await ctx.supabase
          .from("synthesis")
          .insert({ theo_session_id: theoSessionId })
          .select("id")
          .single();
        if (insert.error) return fail(`synthesis insert failed: ${insert.error.message}`);
        synthesisId = insert.data.id as string;
      }
    }

    // Upsert the section. UNIQUE(synthesis_id, section_index) means we can use
    // PostgREST upsert with onConflict.
    const upsert = await ctx.supabase
      .from("synthesis_section")
      .upsert({
        synthesis_id: synthesisId,
        section_index: sectionIdx,
        title,
        content_md: contentMd,
        needs_review: needsReview,
        join_note: joinNote,
      }, { onConflict: "synthesis_id,section_index" })
      .select("id, section_index, title, needs_review")
      .single();
    if (upsert.error) return fail(`section upsert failed: ${upsert.error.message}`);

    return JSON.stringify({
      synthesis_id: synthesisId,
      theo_session_id: theoSessionId,
      section: {
        id: upsert.data.id,
        section_index: upsert.data.section_index,
        title: upsert.data.title,
        needs_review: upsert.data.needs_review,
        content_md_length: contentMd.length,
      },
      "[SYSTEM]": (needsReview
        ? `section ${sectionIdx} written and FLAGGED for Ghostwheel review (join_note recorded). The whole knit will surface this flag when read.`
        : `section ${sectionIdx} written. Continue with the next section, or call read_synthesis to assemble the knit and verify.`) + idNote,
    });
  },
};
