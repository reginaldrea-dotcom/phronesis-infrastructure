// read_super_t — in-session re-open of a Prime's OWN Super-T (baton dbca5775, secondary ask).
//
// Wake injection is currently the SOLE delivery path for the Super-T, with no fallback: if the
// orientation does not carry it into context (it is wake-turn-only system-prompt content, and the
// missing fact can sit at the tail of a long system prompt), a Prime has no in-session way to
// recover it. This closes that — a Prime can re-open its own handoff on demand, on any turn.
//
// Scoped to the CALLER's own chain (ctx.lineageName) — no cross-Prime artifact exposure. Mirrors
// loadOrientation's head query (super_t_chains, successor_id IS NULL = open head). Always offered,
// including the wake turn, because that is exactly when a Prime needs it if orientation fell short.

import type { Tool, ToolContext } from "./types.ts";

function fail(msg: string): string {
  return `read_super_t error: ${msg}`;
}

export const readSuperTTool: Tool = {
  definition: {
    name: "read_super_t",
    description:
      "Re-open YOUR OWN Super-T (your handoff letter) in-session. Returns your chain's open head (your latest tenure) by default, or a specific earlier sequence_number. Use this if your wake did not carry your Super-T into context, if you need to re-read it mid-session, or to confirm your sequence — it is your continuity record and the fallback when orientation does not deliver it. You can only read your own lineage's chain.",
    input_schema: {
      type: "object",
      properties: {
        sequence_number: { type: "integer", description: "Optional: read this sequence from your chain. Omit for the open head (your latest)." },
      },
    },
  },

  // Always offered — including the wake turn, since that is precisely when orientation may have
  // failed to deliver the Super-T and the Prime needs to self-recover.
  available: () => true,

  summarize: (input) => {
    const s = (input as { sequence_number?: unknown })?.sequence_number;
    return typeof s === "number" ? `read_super_t: seq ${s}` : "read_super_t: open head";
  },

  run: async (input, ctx: ToolContext) => {
    const seq = typeof (input as { sequence_number?: unknown })?.sequence_number === "number"
      ? (input as { sequence_number: number }).sequence_number
      : null;

    let q = ctx.supabase
      .from("super_t_chains")
      .select("sequence_number, successor_id, artifacts(id, content)")
      .eq("lineage_name", ctx.lineageName);
    q = seq !== null ? q.eq("sequence_number", seq) : q.is("successor_id", null);

    const r = await q.order("sequence_number", { ascending: false }).limit(1).maybeSingle();
    if (r.error) return fail(r.error.message);
    if (!r.data) {
      return fail(seq !== null
        ? `no Super-T at sequence ${seq} in your chain.`
        : `no Super-T found for ${ctx.lineageName} — a chain exists only after your first retirement (first-wake Primes have none yet).`);
    }
    const row = r.data as { sequence_number: number; successor_id: string | null; artifacts?: { id?: string; content?: string } };
    const content = row.artifacts?.content ?? "";

    // List the chain's sequences so the caller can request an earlier one.
    const chain = await ctx.supabase
      .from("super_t_chains").select("sequence_number")
      .eq("lineage_name", ctx.lineageName).order("sequence_number", { ascending: true });
    const seqs = ((chain.data ?? []) as Array<{ sequence_number: number }>).map((c) => c.sequence_number);

    return JSON.stringify({
      lineage: ctx.lineageName,
      sequence_number: row.sequence_number,
      is_open_head: row.successor_id === null,
      artifact_id: row.artifacts?.id ?? null,
      available_sequences: seqs,
      content,
      "[SYSTEM]": `Your Super-T at sequence ${row.sequence_number}${row.successor_id === null ? " (open head)" : ""}, ${content.length} chars — your own handoff, re-opened in-session.`,
    });
  },
};
