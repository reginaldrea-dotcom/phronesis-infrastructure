// write_ground_fact — Angelia's harness tool to write a qualitative ground_fact (the evidence-anchored
// counterpart to a claim, for the Ground Facts / element-store). Thin wrapper over Connie's write contract
// public.write_ground_fact() (message 2e517533): SECURITY DEFINER, validates authority_tier {T1,T2,T3} and
// contestability {settled,contested} with clear rejections, logs to execution_ledger. This tool is the
// mechanism; per MST_EvidenceAnchoringProtocol (9b8b607f) the authority_tier value is set at capture
// (Theo's judgment) and passed through here — the contract rejects an invalid tier, we surface it.

import type { Tool, ToolContext } from "./types.ts";

function fail(msg: string): string {
  return `write_ground_fact error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const writeGroundFactTool: Tool = {
  definition: {
    name: "write_ground_fact",
    description:
      "Write a qualitative, evidence-anchored ground fact to the element store, via the write_ground_fact contract. REQUIRED: title, content, source_url, content_hash (the source integrity anchor at capture), authority_tier (T1/T2/T3 — set at capture per the evidence-anchoring protocol; 'noise' is not persisted and an invalid tier is rejected). OPTIONAL: definition_scope; period_start / period_end (ISO dates) / period_label; source_document_id (the frozen source_document snapshot, if the source was captured); contestability (settled [default] / contested). Returns the created ground_fact row (its id is the confirmation the write landed). After writing, link the fact into a dossier via element_dependency (slice_on_fact) so it surfaces with its integrity state.",
    input_schema: {
      type: "object",
      properties: {
        title:            { type: "string", description: "Short title of the fact." },
        content:          { type: "string", description: "The fact itself — the qualitative statement." },
        source_url:       { type: "string", description: "The source URL the fact rests on." },
        content_hash:     { type: "string", description: "Hash of the source content at capture (the integrity anchor)." },
        authority_tier:   { type: "string", enum: ["T1", "T2", "T3"], description: "Source authority tier, set at capture (T1 highest). 'noise' is never persisted." },
        definition_scope: { type: "string", description: "Optional: scope / definition qualifier." },
        period_start:     { type: "string", description: "Optional: ISO date (YYYY-MM-DD) the fact's period starts." },
        period_end:       { type: "string", description: "Optional: ISO date the fact's period ends." },
        period_label:     { type: "string", description: "Optional: human label for the period." },
        source_document_id: { type: "string", description: "Optional: id of the frozen source_document snapshot, if the source was captured." },
        contestability:   { type: "string", enum: ["settled", "contested"], description: "Optional: settled (default) or contested." },
      },
      required: ["title", "content", "source_url", "content_hash", "authority_tier"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const i = input as { title?: unknown; authority_tier?: unknown };
    return `write_ground_fact: ${String(i?.title ?? "").slice(0, 50)} [${String(i?.authority_tier ?? "")}]`;
  },

  run: async (input, ctx: ToolContext) => {
    const i = input as Record<string, unknown>;
    const s = (k: string) => (typeof i?.[k] === "string" && (i[k] as string).trim() ? (i[k] as string).trim() : null);

    const title = s("title"), content = s("content"), sourceUrl = s("source_url"),
      contentHash = s("content_hash"), tier = s("authority_tier");
    if (!title)       return fail("title is required.");
    if (!content)     return fail("content is required.");
    if (!sourceUrl)   return fail("source_url is required.");
    if (!contentHash) return fail("content_hash is required (the source integrity anchor).");
    if (!tier)        return fail("authority_tier is required (T1 / T2 / T3).");

    const args = {
      p_title: title,
      p_content: content,
      p_source_url: sourceUrl,
      p_content_hash: contentHash,
      p_authority_tier: tier,
      p_definition_scope: s("definition_scope"),
      p_period_start: s("period_start"),
      p_period_end: s("period_end"),
      p_period_label: s("period_label"),
      p_source_document_id: s("source_document_id"),
      p_contestability: s("contestability") ?? "settled",
      p_captured_by_lineage: ctx.lineageName || "angelia",
    };

    try {
      const res = await ctx.supabase.rpc("write_ground_fact", args);
      if (res.error) return fail(`write contract rejected: ${res.error.message}`);
      const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
        { id?: string; authority_tier?: string; contestability?: string } | null;
      if (!row?.id) return fail("write returned no row id — treat as NOT persisted.");
      return JSON.stringify({
        ok: true,
        ground_fact_id: row.id,
        authority_tier: row.authority_tier,
        contestability: row.contestability,
        "[SYSTEM]": `PERSISTED + CONFIRMED. ground_fact ${row.id} written (tier ${row.authority_tier}, ${row.contestability}). This id IS the confirmation the write landed — a rejected write returns an error, not an id. Next: link it into a dossier via element_dependency (edge_kind slice_on_fact) so it surfaces and gets its integrity state.`,
      });
    } catch (err) {
      return fail(`write_ground_fact call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
