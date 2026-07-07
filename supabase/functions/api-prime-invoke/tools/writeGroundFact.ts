// write_ground_fact — Angelia's harness tool to write a qualitative ground_fact (the evidence-anchored
// counterpart to a claim, for the Ground Facts / element-store). Thin wrapper over Connie's write contract
// public.write_ground_fact() (message 2e517533): SECURITY DEFINER, validates authority_tier {T1,T2,T3} and
// contestability {settled,contested}, logs to execution_ledger.
//
// CAPTURE-AND-FREEZE (7 Jul, after the UK-Migration grounding shipped 31 URL-only facts, many with guessed
// URLs that 404): the tool now FETCHES the source_url and freezes an immutable source_document at write
// time (reusing captureSource — the same evidence-locker path claims use), and the content_hash is computed
// from the FETCHED BYTES, not asserted by the model. A URL that can't be fetched (dead / blocked / guessed)
// yields NO frozen capture: the fact is written cited-NOT-anchored with content_hash 'unverified' and the
// result says so LOUDLY — so a bad URL is caught at mint, never presented as a solid T1 anchor. This is why
// authority_tier alone was misleading: a tier is only as good as a source that actually resolves + is held.

import type { Tool, ToolContext } from "./types.ts";
import { captureSource } from "../lib/captureSource.ts";

function fail(msg: string): string {
  return `write_ground_fact error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

async function hashOfDoc(ctx: ToolContext, docId: string): Promise<string | null> {
  const doc = await ctx.supabase.from("source_document").select("content_hash").eq("id", docId).maybeSingle();
  return (doc.data as { content_hash?: string } | null)?.content_hash ?? null;
}

export const writeGroundFactTool: Tool = {
  definition: {
    name: "write_ground_fact",
    description:
      "Write a qualitative, evidence-anchored ground fact to the element store. The tool FETCHES the source_url and freezes an immutable snapshot at write time, and derives content_hash from the fetched bytes — so you do NOT supply a hash, and you must give a source_url that actually resolves. If the URL can't be fetched (dead / blocked / guessed), the fact is still written but CITED-NOT-ANCHORED (no frozen capture, hash 'unverified') and the result says so — fix the URL and re-mint rather than leaving a load-bearing claim on an unfetchable source. REQUIRED: title, content, source_url, authority_tier (T1/T2/T3, set at capture; 'noise' is rejected). OPTIONAL: definition_scope; period_start / period_end (ISO) / period_label; contestability (settled [default] / contested); source_document_id (only if you already froze the source yourself). Returns the created ground_fact row and whether it anchored. Then link it to the claim(s) it supports via write_element_dependency (edge_kind claim_on_fact).",
    input_schema: {
      type: "object",
      properties: {
        title:            { type: "string", description: "Short title of the fact." },
        content:          { type: "string", description: "The fact itself — the qualitative statement." },
        source_url:       { type: "string", description: "The source URL — MUST resolve; it is fetched and frozen at write time." },
        authority_tier:   { type: "string", enum: ["T1", "T2", "T3"], description: "Source authority tier, set at capture (T1 highest). 'noise' is never persisted." },
        definition_scope: { type: "string", description: "Optional: scope / definition qualifier." },
        period_start:     { type: "string", description: "Optional: ISO date (YYYY-MM-DD) the fact's period starts." },
        period_end:       { type: "string", description: "Optional: ISO date the fact's period ends." },
        period_label:     { type: "string", description: "Optional: human label for the period." },
        source_document_id: { type: "string", description: "Optional: id of an already-frozen source_document (skip capture). Normally leave unset — the tool captures for you." },
        contestability:   { type: "string", enum: ["settled", "contested"], description: "Optional: settled (default) or contested." },
      },
      required: ["title", "content", "source_url", "authority_tier"],
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

    const title = s("title"), content = s("content"), sourceUrl = s("source_url"), tier = s("authority_tier");
    if (!title)     return fail("title is required.");
    if (!content)   return fail("content is required.");
    if (!sourceUrl) return fail("source_url is required.");
    if (!tier)      return fail("authority_tier is required (T1 / T2 / T3).");

    // Capture + freeze NOW. A caller-supplied source_document_id (rare) is trusted; otherwise fetch+freeze
    // the URL. captureSource returns null on a dead/blocked/non-text URL → cited-not-anchored.
    let sourceDocId = s("source_document_id");
    let anchored = false;
    if (sourceDocId) {
      anchored = true;
    } else {
      const capturedId = await captureSource(ctx.supabase, { url: sourceUrl, title, sessionId: ctx.sessionId ?? "ground_fact_capture" });
      if (capturedId) { sourceDocId = capturedId; anchored = true; }
    }
    // content_hash is of the FROZEN bytes when anchored; 'unverified' when the source couldn't be captured.
    let contentHash: string | null = null;
    if (sourceDocId) contentHash = await hashOfDoc(ctx, sourceDocId);
    if (!contentHash) { contentHash = "unverified"; anchored = false; }

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
      p_source_document_id: sourceDocId,
      p_contestability: s("contestability") ?? "settled",
      p_captured_by_lineage: ctx.lineageName || "angelia",
    };

    try {
      const res = await ctx.supabase.rpc("write_ground_fact", args);
      if (res.error) return fail(`write contract rejected: ${res.error.message}`);
      const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
        { id?: string; authority_tier?: string; contestability?: string } | null;
      if (!row?.id) return fail("write returned no row id — treat as NOT persisted.");

      const sys = anchored
        ? `PERSISTED + ANCHORED. ground_fact ${row.id} (tier ${row.authority_tier}, ${row.contestability}) written with a FROZEN capture (source_document ${sourceDocId}); content_hash is of the fetched bytes. Next: link it to the claim(s) it supports via write_element_dependency (edge_kind claim_on_fact).`
        : `PERSISTED but CITED-NOT-ANCHORED. ground_fact ${row.id} written, BUT source_url '${sourceUrl}' could not be fetched/frozen (dead, blocked, or a guessed URL) — no frozen capture, content_hash 'unverified'. The dossier will show this as an unverified source. STRONGLY prefer to verify the real URL resolves and re-mint; do not leave a load-bearing claim resting only on an unfetchable link.`;
      return JSON.stringify({ ok: true, ground_fact_id: row.id, anchored, source_document_id: sourceDocId, authority_tier: row.authority_tier, contestability: row.contestability, "[SYSTEM]": sys });
    } catch (err) {
      return fail(`write_ground_fact call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
