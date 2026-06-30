// commit_synthesis — the "Commit synthesis" action: the deliberate pivot from the
// PRODUCTION posture to the READING posture (Conf 089858ad, MR 1ad5b49e — Eames's hinge).
// It finalises the assembled synthesis and transitions the session to its terminal
// 'delivered' state, GUARDED so the ratified invariant holds in the tool, not by memory:
//
//     NO SESSION REACHES A TERMINAL STATE WITHOUT ITS SYNTHESIS ROWS.
//
// (Argos's standing audit is the belt; this guard is the brace. A DB trigger is the
// eventual second wall — Connie's DDL lane.)
//
// Write-path v1: synthesis + synthesis_section (the document) persist as rows — sections
// via write_synthesis_section, the finalise here. The claim/citation organs are v2. The
// stored rows ARE the delivered document: deliver-by-query reads them; the render is a
// SELECT, never a regeneration (the forgery floor in pixels). layer_1_synthesis_md is the
// canonical delivered text — set here from the ordered knit of sections unless an explicit
// final (de-told) document is supplied.
//
// Refuses to commit on incomplete dispatch (engines still pending/dispatched) unless
// allow_incomplete=true — synthesising on incomplete dispatch is the known anti-pattern.
//
// Parameterised writes via api-prime-invoke's service-role client (synthesis/synthesis_section
// are RLS-sealed; same channel the worker writes engine_dispatch on).

import type { Tool, ToolContext } from "./types.ts";
import { assertCaptureTarget } from "../lib/captureTarget.ts";

const ID_RE = /^[0-9a-f-]{4,36}$/i;
const TERMINAL_STATE = "delivered";

function fail(msg: string): string {
  return `commit_synthesis error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const commitSynthesisTool: Tool = {
  definition: {
    name: "commit_synthesis",
    description:
      "Commit the assembled synthesis for a theo_session — the deliberate finalise that makes the stored rows the document of record and moves the session to its terminal 'delivered' state. GUARDED: refuses unless a synthesis row with at least one section exists (no terminal state without synthesis rows), and refuses if engines are still in flight unless allow_incomplete=true. Call AFTER writing the sections with write_synthesis_section and verifying the knit with read_synthesis. Optionally pass layer_1_synthesis_md (the final assembled, de-told document); if omitted it is set from the ordered knit of the sections. This is the production→reading pivot — a deliberate act, not an autosave.",
    input_schema: {
      type: "object",
      properties: {
        theo_session_id: { type: "string", description: "Session id — full UUID or a leading hex prefix." },
        layer_1_synthesis_md: { type: "string", description: "Optional: the final assembled, de-told synthesis document. If omitted, set from the ordered concatenation (knit) of the sections." },
        allow_incomplete: { type: "boolean", description: "Set true to commit even though engines are still pending/dispatched. Default false — committing on incomplete dispatch is the known anti-pattern." },
      },
      required: ["theo_session_id"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: () => "commit_synthesis",

  run: async (input, ctx: ToolContext) => {
    const i = input as Record<string, unknown>;
    const sessionRaw = typeof i?.theo_session_id === "string" ? i.theo_session_id.trim() : "";
    if (!ID_RE.test(sessionRaw)) return fail(`theo_session_id must be a UUID or hex prefix. Got: ${sessionRaw.slice(0, 40)}`);
    const allowIncomplete = i?.allow_incomplete === true;

    // Resolve theo_session_id (prefix-tolerant; sessionRaw is ID_RE-validated).
    const sessionLookup = await ctx.supabase.rpc("execute_raw_sql", {
      query: `SELECT id, state FROM theo_session WHERE id::text LIKE '${sessionRaw}%' LIMIT 2`,
    });
    if (sessionLookup.error) return fail(`session lookup failed: ${sessionLookup.error.message}`);
    const sessRows = (sessionLookup.data ?? []) as Array<{ id: string; state: string }>;
    if (sessRows.length === 0) return fail(`no theo_session with id starting '${sessionRaw}'.`);
    if (sessRows.length > 1) return fail(`prefix '${sessionRaw}' matches ${sessRows.length} sessions — supply more characters.`);
    const sessionId = sessRows[0].id;

    // Ownership-bind (a90e1410 inst 3): commit terminalises a synthesis — never let a run commit
    // (and flip to 'delivered') a synthesis other than the one it declared.
    const own = await assertCaptureTarget(ctx.supabase, ctx.sessionId, sessionId);
    if ("err" in own) return fail(own.err);

    // GUARD 1 — a synthesis row with at least one section must exist. This is the
    // ratified invariant, enforced at the transition: no terminal state without rows.
    const synth = await ctx.supabase
      .from("synthesis").select("id").eq("theo_session_id", sessionId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (synth.error) return fail(`synthesis lookup failed: ${synth.error.message}`);
    if (!synth.data?.id) {
      return fail("cannot commit — no synthesis row for this session. Write the synthesis with write_synthesis_section first (section 0 = executive summary). Guard: no terminal state without synthesis rows.");
    }
    const synthesisId = synth.data.id as string;

    const sectionsQ = await ctx.supabase
      .from("synthesis_section").select("section_index, content_md")
      .eq("synthesis_id", synthesisId).order("section_index", { ascending: true });
    if (sectionsQ.error) return fail(`sections read failed: ${sectionsQ.error.message}`);
    const sections = (sectionsQ.data ?? []) as Array<{ section_index: number; content_md: string | null }>;
    if (sections.length === 0) {
      return fail("cannot commit — synthesis row exists but has no sections. Write at least section_index 0 (executive summary) first. Guard: no terminal state without synthesis rows.");
    }

    // GUARD 2 — incomplete dispatch (unless deliberately overridden).
    const disp = await ctx.supabase
      .from("engine_dispatch").select("status").eq("theo_session_id", sessionId);
    if (disp.error) return fail(`dispatch counts failed: ${disp.error.message}`);
    const inFlight = (disp.data ?? []).filter((r) => r.status === "pending" || r.status === "dispatched").length;
    if (inFlight > 0 && !allowIncomplete) {
      return fail(`${inFlight} engine(s) still in flight (pending/dispatched) — committing now synthesises on incomplete dispatch. Wait for the completion wake_delta, or pass allow_incomplete=true if this is deliberate.`);
    }

    // Finalise the synthesis header. layer_1 = explicit final doc, else the ordered knit.
    const knit = sections.map((s) => s.content_md ?? "").join("\n\n");
    const explicit = typeof i?.layer_1_synthesis_md === "string" && i.layer_1_synthesis_md.trim().length > 0;
    const layer1 = explicit ? (i.layer_1_synthesis_md as string) : knit;
    const headUpd = await ctx.supabase
      .from("synthesis").update({ layer_1_synthesis_md: layer1 }).eq("id", synthesisId).select("id").single();
    if (headUpd.error) return fail(`synthesis header update failed: ${headUpd.error.message}`);

    // The guarded transition. Only reached with synthesis + sections present.
    const nowIso = new Date().toISOString();
    const trans = await ctx.supabase
      .from("theo_session").update({ state: TERMINAL_STATE, delivered_at: nowIso })
      .eq("id", sessionId).select("id, state, delivered_at").single();
    if (trans.error) return fail(`state transition failed: ${trans.error.message}`);

    return JSON.stringify({
      theo_session_id: sessionId,
      synthesis_id: synthesisId,
      state: trans.data.state,
      delivered_at: trans.data.delivered_at,
      sections_committed: sections.length,
      layer_1_chars: layer1.length,
      layer_1_source: explicit ? "supplied" : "knit-of-sections",
      "[SYSTEM]": `Synthesis committed: ${sections.length} section(s); session now '${TERMINAL_STATE}'. The stored rows are the document of record — the renderer reads them, never re-generates. This is the production→reading pivot; the work is now persisted, not living in chat.`,
    });
  },
};
