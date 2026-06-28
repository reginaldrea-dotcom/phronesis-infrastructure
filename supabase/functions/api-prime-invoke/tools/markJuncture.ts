// mark_juncture — record reaching a NON-TOOL reasoning juncture (conf d36d9609, MR ac84a3d9;
// baton 3305e3d0, component 3).
//
// Most junctures that matter for the delivery-at-need metric coincide with a tool call (write_claims
// at a VALIDATION, commit_synthesis at a DECISION, a sign-off artifact) — those are observable already
// and Argos's F leg derives them. But a Prime also reaches junctures purely in reasoning, with no tool
// fired: it arrives at a DECISION it will only state in prose. mark_juncture is how that non-tool
// juncture becomes OBSERVABLE — the denominator's non-tool tail named in Argos's F baton (5dfb4003).
//
// It also operationalizes the option-B ritual the conference ratified ("at this juncture, load the MSTs
// tagged for it"): marking a juncture returns the POINTERS to the MSTs mapped to you for it, so the
// natural next move is a load_mst pull. Marking does NOT auto-pull — pull-only; the Prime decides.
//
// Lineage-scoped (ctx.lineageName); the marker is a metrics signal, never load-bearing on the Prime's
// own reasoning. Read/write is the single ledger insert; best-effort, always offered.

import type { Tool, ToolContext } from "./types.ts";

export const markJunctureTool: Tool = {
  definition: {
    name: "mark_juncture",
    description:
      "Record that you have reached a reasoning juncture (e.g. VALIDATION — about to rely on a fact/figure; " +
      "DECISION — about to commit a choice) when NO other tool call already marks it. This makes the juncture " +
      "observable for the delivery-at-need metric, and returns the MSTs mapped to you for that juncture as " +
      "pointers — pull the one you need with load_mst. Use it at a high-stakes juncture you would otherwise " +
      "pass through silently in prose. If a tool call already represents the juncture, you need not also mark it.",
    input_schema: {
      type: "object",
      properties: {
        juncture: { type: "string", description: "The juncture reached, e.g. VALIDATION or DECISION." },
        note: { type: "string", description: "Optional: a short note on what the juncture is (recorded with the marker)." },
      },
      required: ["juncture"],
    },
  },

  available: () => true,

  summarize: (input) => {
    const j = (input as { juncture?: string })?.juncture;
    return j ? `mark_juncture: ${j}` : "mark_juncture";
  },

  run: async (input, ctx: ToolContext) => {
    const i = (input ?? {}) as { juncture?: string; note?: string };
    const raw = (i.juncture ?? "").trim();
    if (!raw) return "mark_juncture error: a juncture is required (e.g. VALIDATION, DECISION).";
    const juncture = raw.toUpperCase();
    const lineage = ctx.lineageName;

    // The denominator event (an unattended juncture:reached) is recorded by the harness execution_ledger
    // row for this very call — tool='mark_juncture' with the first-class juncture key — so F (baton
    // 5dfb4003) joins on the ledger. No tool-side metrics write here.

    // Return the pointers mapped to this juncture (over Connie's D-lite view), so the ritual completes
    // with a load_mst pull. Best-effort: a read failure still leaves the marker recorded.
    const vRes = await ctx.supabase
      .from("juncture_mst_index")
      .select("mst_id, mst_title, mst_genre, map_reason")
      .eq("lineage", lineage)
      .eq("juncture", juncture);

    const rows = (vRes.error ? [] : (vRes.data ?? [])) as any[];
    const pointers = rows.map((r) => ({
      mst_id: r.mst_id, title: r.mst_title, genre: r.mst_genre, map_reason: r.map_reason,
    }));

    const sys = pointers.length > 0
      ? `Juncture ${juncture} recorded. ${pointers.length} MST(s) are mapped to you for it — pull what you need with load_mst({juncture:"${juncture}"}) or load_mst({mst_id}).`
      : `Juncture ${juncture} recorded. No MST is mapped to ${lineage} for it (nothing to pull). If one should be, that is a mapping gap for the librarian.`;

    return JSON.stringify({ juncture, lineage, recorded: true, pointers, "[SYSTEM]": sys });
  },
};
