// api-prime-invoke | action verify_capture | Roadmap Phase 1 capture live verification | 8 Jun 2026
//
// Zero-Prime-impact proof of the capture machinery. Like verify_cut2, an action short-circuits
// BEFORE the wake/orientation path, so this consumes NO wake_deltas, writes NO Super-T, opens NO
// Prime session. It runs the real captureSource path (fetch -> hash -> immutable source_document)
// against a caller-supplied url (default a small stable page), then reads the row back and
// confirms the stored content re-hashes to the recorded content_hash — the round-trip the whole
// roadmap rests on, proven in isolation before any real report exercises it.
//
// NOTE: source_document is append-only by design (DELETE refused), so the test row is permanent —
// a legitimate captured public page, not a fake. Use a throwaway url; example.com is the default.

import type { Action } from "./types.ts";
import { corsHeaders } from "../lib/http.ts";
import { captureSource } from "../lib/captureSource.ts";

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mirror of write_ground_fact's numeric gate normaliser — lets the probe prove the figure match too.
function figurePresent(hayRaw: string, needleRaw: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[,\s£$€%]/g, "");
  const hay = norm(hayRaw), needle = norm(needleRaw);
  if (needle.length < 2) return false;
  return hay.includes(needle);
}

export const verifyCaptureAction: Action = {
  name: "verify_capture",
  handle: async ({ supabase, body }) => {
    const url = (typeof body?.url === "string" && body.url.trim()) ? body.url.trim() : "https://example.com/";
    const sessionId = (typeof body?.session_id === "string" && body.session_id.trim()) ? body.session_id.trim() : "verify-capture";
    // Opt-in: exercise the RENDERED-EVIDENCE path (Firecrawl render + full-page screenshot -> Storage +
    // Wayback), and optionally test the numeric figure gate against the rendered text.
    const wantShot = body?.screenshot === true || body?.screenshot === "true";
    const figure = (typeof body?.figure === "string" && body.figure.trim()) ? body.figure.trim() : null;
    try {
      const id = await captureSource(supabase, { url, title: "verify_capture probe", sessionId, captureScreenshot: wantShot });
      if (!id) {
        return new Response(
          JSON.stringify({ ok: false, captured: false, url, screenshot_requested: wantShot, reason: "captureSource returned null — fetch/render failed / non-text / non-web. Capture path ran but anchored nothing (see EF logs)." }, null, 2),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Read the held row back and re-hash the stored content — proves recoverability + integrity.
      const row = await supabase
        .from("source_document")
        .select("id, content_hash, content, payload_state, origin, captured_at, forgetting_exempt, attestation")
        .eq("id", id)
        .single();
      if (row.error || !row.data) {
        return new Response(
          JSON.stringify({ ok: false, captured: true, source_document_id: id, reason: `row read-back failed: ${row.error?.message ?? "no row"}` }, null, 2),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const d = row.data as Record<string, unknown>;
      const rehash = await sha256Hex(typeof d.content === "string" ? d.content : "");
      const hashMatch = rehash === d.content_hash;
      const att = (d.attestation ?? {}) as Record<string, unknown>;
      const figureFound = figure ? figurePresent(typeof d.content === "string" ? d.content : "", figure) : null;
      return new Response(
        JSON.stringify({
          ok: hashMatch,
          chain: wantShot ? "render -> markdown+screenshot -> storage upload -> wayback -> source_document -> read-back -> re-hash"
                          : "fetch -> hash -> source_document insert -> read-back -> re-hash",
          url,
          source_document_id: id,
          payload_state: d.payload_state,
          origin: d.origin,
          forgetting_exempt: d.forgetting_exempt,
          content_hash: d.content_hash,
          rehash_matches: hashMatch,
          captured_at: d.captured_at,
          // rendered-evidence surface
          captured_via: att.captured_via,
          http_status: att.http_status,
          screenshot_url: att.screenshot_url ?? null,
          archive_url: att.archive_url ?? null,
          content_bytes: att.bytes,
          // numeric gate probe (only when a figure was supplied)
          figure: figure,
          figure_found: figureFound,
        }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(
        JSON.stringify({ ok: false, error: msg, hint: "names the failed step — fetch / hash / insert / read-back; contains no secret" }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  },
};
