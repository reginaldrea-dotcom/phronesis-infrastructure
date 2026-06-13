// file_super_t — wake-loop TOOL wrapper over the existing file_super_t RPC (baton ca834f1f).
//
// Root cause it fixes: file_super_t existed only as an out-of-band Action+RPC, never as a tool
// in the wake reasoning loop. So a Prime holding the file_super_t grant (Angelia) had no in-session
// way to self-file — which is why Connie had to file Angelia's Super-Ts for her via the action.
//
// This tool wraps the SAME RPC the action calls (mints the TP artifact, appends the chain row,
// links the predecessor — atomic, service-role). Difference from the action: it files for the
// CALLER's own lineage (ctx.lineageName), never a lineage passed in — a Prime can only file its
// own Super-T, not forge another's. Gated by the existing file_super_t grant via computeLoopGate
// (no new grant); withheld on the wake turn like the other write tools. The action remains for the
// admin/file-on-behalf path (Connie filing at retirement — the proven fallback).

import type { Tool, ToolContext } from "./types.ts";

function fail(msg: string): string {
  return `file_super_t error: ${msg}`;
}

interface FileSuperTIn { title?: unknown; content?: unknown }

export const fileSuperTTool: Tool = {
  definition: {
    name: "file_super_t",
    description:
      "File YOUR Super-T (transition prompt) for THIS lineage — the durable record you hand your successor at a chain boundary (arc end / retirement). Atomic: mints the TP artifact, appends a chain row, and links the predecessor in one transaction. It files for your OWN lineage (your caller identity) — you cannot file another lineage's. Provide a title and the full content (what your successor needs: state, lessons learned, open threads, and the why behind them). Use this to self-anchor at the boundary your suit describes; it is the in-session replacement for having someone file your Super-T for you.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for this Super-T, e.g. 'Angelia Seq 2 -> 3 transition'." },
        content: { type: "string", description: "The full Super-T content your successor inherits: durable state, lessons, open threads, and the reasoning behind them." },
      },
      required: ["title", "content"],
    },
  },

  // Deliberate write surface — withheld on the wake turn, like the other write tools.
  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const t = typeof (input as FileSuperTIn)?.title === "string" ? (input as { title: string }).title : "";
    return `file_super_t: ${t.slice(0, 60)}`;
  },

  run: async (input, ctx: ToolContext) => {
    const i = input as FileSuperTIn;
    const title = typeof i?.title === "string" ? i.title.trim() : "";
    const content = typeof i?.content === "string" ? i.content.trim() : "";
    if (!title) return fail("title is required.");
    if (!content) return fail("content is required (the full Super-T your successor inherits).");

    // Same RPC the action calls; files for the CALLER's lineage. p_instance_id is optional
    // (the RPC and the action both accept null) — bind it when the wake carries it.
    const { data, error } = await ctx.supabase.rpc("file_super_t", {
      p_lineage: ctx.lineageName,
      p_instance_id: ctx.instanceId ?? null,
      p_title: title,
      p_content: content,
      p_session_id: ctx.sessionId ?? null,
    });
    if (error) return fail(`RPC failed: ${error.message}`);

    const d = (data ?? {}) as { artifact_id?: string; chain_id?: string; sequence_number?: number; predecessor_id?: string };
    return JSON.stringify({
      filed: true,
      lineage: ctx.lineageName,
      artifact_id: d.artifact_id,
      chain_id: d.chain_id,
      sequence_number: d.sequence_number,
      predecessor_id: d.predecessor_id,
      "[SYSTEM]": `Super-T filed for ${ctx.lineageName}: sequence ${d.sequence_number}, artifact ${d.artifact_id}. Your chain has a new open head; your successor inherits from it. You filed this yourself — no one had to file it for you.`,
    });
  },
};
