// write_ground_fact — Angelia's harness tool to write a qualitative ground_fact (the evidence-anchored
// counterpart to a claim, for the Ground Facts / element-store). Thin wrapper over Connie's write contract
// public.write_ground_fact() (message 2e517533): SECURITY DEFINER, validates authority_tier {T1,T2,T3} and
// contestability {settled,contested}, logs to execution_ledger.
//
// CAPTURE-AND-VERIFY (7 Jul, design 1a9f0797 / a656ff1d, after the re-ground gave citations not proof).
// The tool RENDERS the source_url (Firecrawl, executing JS so dynamic figures like the ONS 171,000 appear),
// freezes a FULL-PAGE SCREENSHOT + rendered markdown + a Wayback archive, and derives content_hash from the
// fetched bytes. It then decides ONE of two HONEST states per fact kind (never one dishonest "anchored"):
//   • numeric      → strict gate: ANCHORED only if HTTP 200 AND the canonical figure string is present in
//                    the rendered capture; otherwise CITED_NOT_VERIFIED (figure not found on the page).
//   • qualitative  → no string gate (a legal proposition has no grep-able proof): SCREENSHOT_REVIEW with a
//                    stored PNG + canonical quote, flagged REQUIRES-HUMAN-REVIEW (Argos/Reg for load-bearing
//                    claims). A capture with no screenshot falls to CITED_NOT_VERIFIED.
// content_hash and the verification decision come from the FETCHED BYTES, not from the model's assertion.

import type { Tool, ToolContext } from "./types.ts";
import { captureSource } from "../lib/captureSource.ts";

function fail(msg: string): string {
  return `write_ground_fact error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

// Read back what we froze: rendered text (for the numeric string match), the screenshot/archive URLs,
// the content_hash, and the http status recorded in attestation.
async function readCapture(ctx: ToolContext, docId: string): Promise<{
  renderedText: string; contentHash: string | null; screenshotUrl: string | null; archiveUrl: string | null; httpStatus: number;
}> {
  const doc = await ctx.supabase.from("source_document")
    .select("content, content_hash, attestation").eq("id", docId).maybeSingle();
  const d = doc.data as { content?: string; content_hash?: string; attestation?: Record<string, unknown> } | null;
  const att = (d?.attestation ?? {}) as { screenshot_url?: string; archive_url?: string; http_status?: number };
  return {
    renderedText: d?.content ?? "",
    contentHash: d?.content_hash ?? null,
    screenshotUrl: att.screenshot_url ?? null,
    archiveUrl: att.archive_url ?? null,
    httpStatus: typeof att.http_status === "number" ? att.http_status : 0,
  };
}

// Normalise for the numeric gate: lower-case, strip commas/whitespace/currency so "171,000" matches
// "171000" / "171 000" / "£171,000" as rendered. Substring test on the normalised forms.
function figurePresent(renderedText: string, canonical: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[,\s£$€%]/g, "");
  const hay = norm(renderedText), needle = norm(canonical);
  if (needle.length < 2) return false; // too short to be meaningful evidence
  return hay.includes(needle);
}

export const writeGroundFactTool: Tool = {
  definition: {
    name: "write_ground_fact",
    description:
      "Write an evidence-anchored ground fact to the element store. The tool RENDERS the source_url (executing page JS so dynamic figures appear), freezes a FULL-PAGE SCREENSHOT + rendered text + a Wayback archive, and derives content_hash from the fetched bytes — so you do NOT supply a hash, and the source_url must actually resolve. It then decides the verification state from the FETCHED PAGE, by fact_kind: for a NUMERIC fact, give canonical_string = the exact figure (e.g. '171,000') and the fact is ANCHORED only if that figure is present on the rendered page (else CITED_NOT_VERIFIED — figure not found); for a QUALITATIVE fact, give canonical_string = the shortest quote that makes the claim, and the fact is SCREENSHOT_REVIEW (a human — Argos/Reg — confirms the screenshot supports the claim). REQUIRED: title, content, authority_tier (T1/T2/T3), fact_kind (numeric/qualitative), canonical_string, and EITHER source_url (fetch + freeze a live page) OR source_document_id (rest the fact on an already-captured document such as an operator-supplied upload — no fetch; the co-location gate reads that document's own bytes). OPTIONAL: definition_scope; period_start/period_end (ISO)/period_label; contestability (settled [default]/contested). Returns the created ground_fact row and its verification_state. Then link it to the claim(s) it supports via write_element_dependency (edge_kind claim_on_fact).",
    input_schema: {
      type: "object",
      properties: {
        title:            { type: "string", description: "Short title of the fact." },
        content:          { type: "string", description: "The fact itself — the qualitative statement or the figure in context." },
        source_url:       { type: "string", description: "The source URL — MUST resolve; it is rendered, screenshotted and frozen at write time. Omit when passing source_document_id." },
        source_document_id: { type: "string", description: "Rest this fact on an ALREADY-CAPTURED source_document (e.g. an operator-supplied uploaded PDF) instead of fetching a URL. The tool skips capture, binds the fact to that stored document, and the co-location gate at write_element_dependency reads the document's own frozen bytes. Provide EITHER this OR source_url." },
        authority_tier:   { type: "string", enum: ["T1", "T2", "T3"], description: "Source authority tier, set at capture (T1 highest). 'noise' is never persisted." },
        fact_kind:        { type: "string", enum: ["numeric", "qualitative"], description: "numeric = a figure that must be present on the page (strict gate); qualitative = a proposition a human confirms from the screenshot." },
        canonical_string: { type: "string", description: "For numeric: the exact figure to find on the page (e.g. '171,000'). For qualitative: the shortest quote that makes the claim — what a reviewer looks for in the screenshot." },
        definition_scope: { type: "string", description: "Optional: scope / definition qualifier." },
        period_start:     { type: "string", description: "Optional: ISO date (YYYY-MM-DD) the fact's period starts." },
        period_end:       { type: "string", description: "Optional: ISO date the fact's period ends." },
        period_label:     { type: "string", description: "Optional: human label for the period." },
        contestability:   { type: "string", enum: ["settled", "contested"], description: "Optional: settled (default) or contested." },
      },
      required: ["title", "content", "authority_tier", "fact_kind", "canonical_string"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const i = input as { title?: unknown; authority_tier?: unknown; fact_kind?: unknown };
    return `write_ground_fact: ${String(i?.title ?? "").slice(0, 50)} [${String(i?.authority_tier ?? "")}/${String(i?.fact_kind ?? "")}]`;
  },

  run: async (input, ctx: ToolContext) => {
    const i = input as Record<string, unknown>;
    const s = (k: string) => (typeof i?.[k] === "string" && (i[k] as string).trim() ? (i[k] as string).trim() : null);

    const title = s("title"), content = s("content"), tier = s("authority_tier");
    const providedDocId = s("source_document_id");
    let sourceUrl = s("source_url");
    if (!title)   return fail("title is required.");
    if (!content) return fail("content is required.");
    if (!tier)    return fail("authority_tier is required (T1 / T2 / T3).");
    if (!sourceUrl && !providedDocId) return fail("source_url is required (or source_document_id to rest a fact on an already-captured document).");
    const factKind = (s("fact_kind") === "numeric") ? "numeric" : "qualitative"; // default qualitative — never auto-anchor without explicit numeric intent
    const canonical = s("canonical_string");
    if (!canonical) return fail("canonical_string is required — the figure (numeric) or the shortest quote (qualitative) that the capture is checked against.");

    let sourceDocId: string | null;
    let renderedText = "", screenshotUrl: string | null = null, archiveUrl: string | null = null, httpStatus = 0;
    let contentHash: string | null = null;

    if (providedDocId) {
      // OPERATOR-SUPPLIED / PRE-CAPTURED PATH (baton e3aecc76). Rest the fact on an already-captured
      // source_document (e.g. an uploaded PDF stored + hashed by the operator-document capture path). No
      // fetch — the bytes are already frozen. The co-location gate at write_element_dependency reads THIS
      // document's own content, UNCHANGED. Dedup here is by (source_document_id + title).
      const doc = await ctx.supabase.from("source_document")
        .select("id, source_url, content, content_hash, attestation").eq("id", providedDocId).maybeSingle();
      const dd = doc.data as { id?: string; source_url?: string; content?: string; content_hash?: string; attestation?: Record<string, unknown> } | null;
      if (!dd?.id) return fail(`source_document_id ${providedDocId} not found — cannot rest a fact on a missing document.`);
      sourceDocId = providedDocId;
      renderedText = dd.content ?? "";
      contentHash = dd.content_hash ?? "unverified";
      sourceUrl = sourceUrl ?? dd.source_url ?? providedDocId;
      const att = (dd.attestation ?? {}) as { screenshot_url?: string; archive_url?: string; retrievable_url?: string };
      screenshotUrl = att.screenshot_url ?? null;
      archiveUrl = att.archive_url ?? att.retrievable_url ?? null; // operator docs: the retrievable file IS the proof
      httpStatus = 200; // the document is present + retrievable — no live fetch
      try {
        const dup = await ctx.supabase.from("ground_fact")
          .select("id, verification_state, review_state, authority_tier, contestability")
          .eq("source_document_id", providedDocId).eq("title", title).limit(1).maybeSingle();
        const d = dup.data as { id?: string; verification_state?: string; review_state?: string; authority_tier?: string; contestability?: string } | null;
        if (d?.id) {
          return JSON.stringify({
            ok: true, ground_fact_id: d.id, deduped: true, verification_state: d.verification_state, review_state: d.review_state,
            authority_tier: d.authority_tier, contestability: d.contestability,
            "[SYSTEM]": `ALREADY GROUNDED on this document — reused, NOT duplicated. ground_fact ${d.id}. Link claims to THIS id via write_element_dependency (pass anchor_quote + claim_canonical_string; the co-location gate reads the document's own bytes).`,
          });
        }
      } catch (_e) { /* best-effort */ }
    } else {
      // IDEMPOTENCY GUARD: reuse a fact with the same source_url + TITLE rather than minting a duplicate
      // (title is the fact's identity). Genuinely distinct facts from one source carry distinct titles.
      try {
        const dup = await ctx.supabase.from("ground_fact")
          .select("id, authority_tier, contestability, source_document_id, verification_state, review_state")
          .eq("source_url", sourceUrl!).eq("title", title).limit(1).maybeSingle();
        const d = dup.data as { id?: string; authority_tier?: string; contestability?: string; source_document_id?: string; verification_state?: string; review_state?: string } | null;
        if (d?.id) {
          return JSON.stringify({
            ok: true, ground_fact_id: d.id, anchored: d.verification_state === "anchored", deduped: true,
            verification_state: d.verification_state, review_state: d.review_state,
            authority_tier: d.authority_tier, contestability: d.contestability,
            "[SYSTEM]": `ALREADY GROUNDED — reused, NOT duplicated. ground_fact ${d.id} already exists for this source_url + title (state: ${d.verification_state}). Link claims to THIS id via write_element_dependency. Give genuinely different facts from the same source distinct titles.`,
          });
        }
      } catch (_e) { /* dedup is best-effort; on error fall through and mint normally */ }

      // Capture + verify NOW: render, screenshot, archive, freeze (captureScreenshot:true).
      sourceDocId = await captureSource(ctx.supabase, {
        url: sourceUrl!, title, sessionId: ctx.sessionId ?? "ground_fact_capture", captureScreenshot: true,
      });
      if (sourceDocId) {
        const cap = await readCapture(ctx, sourceDocId);
        renderedText = cap.renderedText; screenshotUrl = cap.screenshotUrl; archiveUrl = cap.archiveUrl;
        httpStatus = cap.httpStatus; contentHash = cap.contentHash;
      }
      if (!contentHash) contentHash = "unverified";
    }

    const ok200 = httpStatus === 0 ? !!sourceDocId : (httpStatus >= 200 && httpStatus < 300);
    let verificationState: "anchored" | "screenshot_review" | "cited_not_verified";
    let reviewState: "not_required" | "pending";
    let figureFound = false;
    if (!sourceDocId || !ok200) {
      verificationState = "cited_not_verified"; reviewState = factKind === "qualitative" ? "pending" : "not_required";
    } else if (factKind === "numeric") {
      figureFound = figurePresent(renderedText, canonical);
      verificationState = figureFound ? "anchored" : "cited_not_verified";
      reviewState = "not_required";
    } else {
      // qualitative: reviewable if there is visible proof — a screenshot OR (operator-supplied) a
      // retrievable frozen document a human can open. Fact-level state is legacy; the per-edge co-location
      // gate at write_element_dependency is what actually earns 'anchored'.
      verificationState = (screenshotUrl || archiveUrl) ? "screenshot_review" : "cited_not_verified";
      reviewState = "pending";
    }

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
      // NULL is the PERMANENT, by-design value (Connie ruled, 6f9be3ef): ground_facts are dossier-agnostic
      // — a capture belongs to its SOURCE, not to whichever dossier requested it, so the same page serves any
      // dossier citing it. The dossier binding lives on the claim_on_fact EDGE (element_dependency), not the
      // fact node — the same per-edge architecture the co-location gate rests on. Do NOT thread a real
      // dossier_instance_id here; it would make facts non-shareable and duplicate captures.
      // (History: the redundant 12-arg overload that made a 12-arg call ambiguous was dropped 13 Jul; the
      // 13-arg superset accepts all prior calls, so passing this param explicitly is unambiguous.)
      p_dossier_instance_id: null,
    };

    try {
      const res = await ctx.supabase.rpc("write_ground_fact", args);
      if (res.error) return fail(`write contract rejected: ${res.error.message}`);
      const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
        { id?: string; authority_tier?: string; contestability?: string } | null;
      if (!row?.id) return fail("write returned no row id — treat as NOT persisted.");

      // Annotate the freshly-minted row with the per-fact verification (Connie's RPC owns the mint; the
      // capture-verification fields are Heph's capture lane — set post-insert with service role).
      try {
        await ctx.supabase.from("ground_fact")
          .update({ fact_kind: factKind, canonical_string: canonical, verification_state: verificationState, review_state: reviewState })
          .eq("id", row.id);
      } catch (e) {
        console.error(`write_ground_fact: verification annotate failed for ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }

      let sys: string;
      if (verificationState === "anchored") {
        sys = `PERSISTED + ANCHORED. ground_fact ${row.id} (numeric) — the figure '${canonical}' WAS found on the rendered page (HTTP ${httpStatus}); screenshot + rendered text frozen${archiveUrl ? ", Wayback archived" : ""}. Next: link it to the claim(s) via write_element_dependency (edge_kind claim_on_fact).`;
      } else if (verificationState === "screenshot_review") {
        sys = `PERSISTED + SCREENSHOT_REVIEW. ground_fact ${row.id} (qualitative) — a full-page screenshot is frozen${archiveUrl ? " and Wayback archived" : ""}, flagged REQUIRES-HUMAN-REVIEW (Argos/Reg confirm the page supports the claim: '${canonical}'). This is NOT a fake anchor; it is honestly awaiting review. Link it to the claim(s) via write_element_dependency.`;
      } else if (factKind === "numeric") {
        sys = `PERSISTED but CITED_NOT_VERIFIED. ground_fact ${row.id} (numeric) — the figure '${canonical}' was NOT found on the rendered page${sourceDocId ? ` (HTTP ${httpStatus})` : " (source could not be fetched/rendered)"}. Either the URL is wrong/dead, the figure is served in a way the render missed, or the number differs. Fix the URL/figure and re-mint; do NOT leave a load-bearing numeric claim on an unverified source.`;
      } else {
        sys = `PERSISTED but CITED_NOT_VERIFIED. ground_fact ${row.id} (qualitative) — source_url '${sourceUrl}' could not be rendered/screenshotted (dead, blocked, or a guessed URL), so there is no visible proof to review. Verify the real URL resolves and re-mint.`;
      }
      return JSON.stringify({
        ok: true, ground_fact_id: row.id, verification_state: verificationState, review_state: reviewState,
        fact_kind: factKind, figure_found: factKind === "numeric" ? figureFound : undefined,
        source_document_id: sourceDocId, screenshot_url: screenshotUrl, archive_url: archiveUrl,
        http_status: httpStatus, authority_tier: row.authority_tier, contestability: row.contestability, "[SYSTEM]": sys,
      });
    } catch (err) {
      return fail(`write_ground_fact call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
