// operator-source-ingest — Component C (Napoleon 169f00e0). The operator "grab what I'm reading/watching"
// acquisition, with FOUR renderers DESIGNED IN, not bolted on (Reg's ruling): html article / pdf text-layer
// / scanned-pdf image+OCR / VIDEO TRANSCRIPT. This EF is the substrate the browser-grab front-end feeds:
// it receives the content the operator is already viewing and freezes it AT LOCUS, with a generalized
// self-identifying model that spans a PDF page and a video timestamp-range alike.
//
// THE GENERALIZED LOCUS/EVIDENCE MODEL (in attestation, so no schema churn; evidence_scope + origin are the
// only DB axes, and Connie has them live: origin='transcript', evidence_scope ∈ general|personal|licensed_private):
//   attestation.locus       = { kind: 'page' | 'time_range' | 'document', ref: <page# | {start_s,end_s} | null> }
//   attestation.evidence_kind = 'html_text' | 'text_layer' | 'ocr' | 'publisher_transcript' | 'auto_caption'
//   attestation.deep_link   = the CONTEXT path (evidence path is the frozen content): url#page=N / url&t=Ns / url#:~:text=
//   attestation.self_id     = the R8 self-identity a bare span lacks (title/page OR video_title+channel+range+date)
//   attestation.custody     = chain-of-custody (Reg's route), page-invariant, applies_to:'document'
//
// THREE ASSUMPTIONS THE TRANSCRIPT BREAKS, handled here (Napoleon 169f00e0):
//   1. NO PAGES — the locus is a TIMESTAMP RANGE, and it deep-links better than a page (url&t=123s = the moment).
//   2. A SEGMENT DOES NOT SELF-IDENTIFY — it carries video_title+channel+timestamp_range+capture_date+hash (self_id).
//   3. AUTO-CAPTIONS ARE NOT VERBATIM — a machine transcription that may MISHEAR; the co-location gate would pass
//      a mishearing because the error is UPSTREAM of the bytes we hold. So we RECORD auto vs publisher on the
//      EVIDENCE-KIND axis (what you can CHECK), not tier, and FLAG it. Whether an auto_caption may reach the same
//      reviewable state as a publisher transcript on a verbatim span alone is EAMES'S GATE RULING — flagged here,
//      NOT decided (Napoleon's steer: show him a real captured example, let him rule).
//
// AEGIS (all four renderers): licensed tag WRITE-ONCE at ingest (evidence_scope='licensed_private'); promotion to
// general STRUCTURALLY ABSENT for licensed_private (this EF never writes 'general' onto a licensed grab); one
// page/video Reg chose to open, on his explicit trigger — "pull all forty" impossible BY CONSTRUCTION (this EF
// ingests exactly ONE source per call; there is no list/iterate entry point). And the free property: because Reg
// is already at the right page/moment when he triggers it, capture is AT THE CORRECT LOCUS BY CONSTRUCTION —
// structurally immune to the landing-page failure class.
//
// Auth: WORKER_INVOKE_KEY apikey (the browser front-end holds the operator's key). verify_jwt=false.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { extractText, getDocumentProxy } from "npm:unpdf@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function env(k: string): string { const v = Deno.env.get(k); if (!v) throw new Error(`missing env ${k}`); return v; }
function json(b: unknown, s = 200): Response { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
async function sha256Hex(t: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sanitizeTitle(t: string): string { return (t || "").replace(/�/g, "-").replace(/[‒–—―]/g, "-").replace(/\s+/g, " ").trim(); }
function hms(s: number): string { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(x).padStart(2, "0")}`; }

interface Custody { obtained_by?: string; source?: string; obtained_via?: string; verified_by?: string; verified_statement?: string; }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if ((req.headers.get("apikey") ?? "") !== Deno.env.get("WORKER_INVOKE_KEY")) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const kind = typeof body.kind === "string" ? body.kind : "";
  const licensed = body.licensed === true;                 // Aegis: WRITE-ONCE at ingest; licensed => private scope
  const evidenceScope = licensed ? "licensed_private" : "general";
  const custody = (body.custody ?? null) as Custody | null; // Reg's route, if supplied at grab time
  const dryRun = body.dry_run === true;
  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));
  const nowIso = new Date().toISOString();
  const docKey = crypto.randomUUID();

  function custodyBlock(docSlug: string) {
    if (!custody || !custody.obtained_by) return undefined;
    return {
      kind: "chain_of_custody", applies_to: "document", doc_slug: docSlug,
      obtained_by: custody.obtained_by, source: custody.source ?? null, obtained_via: custody.obtained_via ?? null,
      shared_via: "operator grab", verified_by: custody.verified_by ?? custody.obtained_by,
      verified_statement: custody.verified_statement ?? "Verified personally by the operator.",
      recorded_by: "hephaestus", recorded_on: nowIso, wording_source: "operator-supplied at grab",
    };
  }

  // ---- VIDEO TRANSCRIPT — the hard case that breaks the three assumptions ----
  if (kind === "video_transcript") {
    const videoUrl = typeof body.video_url === "string" ? body.video_url.trim() : "";
    const videoId = typeof body.video_id === "string" ? body.video_id.trim() : (videoUrl.match(/[?&]v=([^&]+)/)?.[1] ?? "");
    const videoTitle = sanitizeTitle(typeof body.title === "string" ? body.title : "");
    const channel = sanitizeTitle(typeof body.channel === "string" ? body.channel : "");
    const publishedDate = typeof body.published_date === "string" ? body.published_date : null;
    const isAuto = body.is_auto === true;                    // ASSUMPTION 3: auto-captions are NOT verbatim
    const segments = Array.isArray(body.segments) ? body.segments as Array<{ start_s?: number; end_s?: number; text?: string }> : [];
    if (!videoUrl && !videoId) return json({ error: "video_url or video_id is required" }, 400);
    if (!videoTitle) return json({ error: "title is required (a segment must self-identify — R8)" }, 400);
    if (!segments.length) return json({ error: "segments[] required ({start_s,end_s,text})" }, 400);

    // The grabbed range = the span the operator chose (ASSUMPTION 1: locus is a TIME RANGE, not a page).
    const startS = Math.min(...segments.map((s) => Number(s.start_s) || 0));
    const endS = Math.max(...segments.map((s) => Number(s.end_s ?? s.start_s) || 0));
    // Content = the transcript text WITH inline timestamps, so the frozen evidence is self-locating within the range.
    const content = segments.map((s) => `[${hms(Number(s.start_s) || 0)}] ${(s.text ?? "").trim()}`).join("\n").trim();
    const canonicalUrl = videoUrl || `https://www.youtube.com/watch?v=${videoId}`;
    const deepLink = `${canonicalUrl}${canonicalUrl.includes("?") ? "&" : "?"}t=${Math.floor(startS)}s`;
    const evidenceKind = isAuto ? "auto_caption" : "publisher_transcript";
    // ASSUMPTION 2: self-identity a bare span lacks.
    const selfId = { video_title: videoTitle, channel: channel || null, timestamp_range: `${hms(startS)}–${hms(endS)}`, video_id: videoId || null, published_date: publishedDate, capture_date: nowIso };

    const attestation: Record<string, unknown> = {
      kind: "video_transcript",
      evidence_kind: evidenceKind,
      // THE FLAG (not a decision): an auto-caption is a machine transcription that may mishear; the gate would
      // pass a mishearing because the error is upstream of these bytes. Eames rules whether this may reach the
      // same reviewable state as a publisher transcript. Recorded so the reviewer and the gate can both see it.
      auto_caption: isAuto,
      evidence_kind_warning: isAuto ? "AUTO-GENERATED captions — machine transcription, may mishear; NOT verbatim-equivalent to a text layer. Reviewer confirms against audio; gate treatment pending Eames ruling." : null,
      locus: { kind: "time_range", ref: { start_s: startS, end_s: endS } },
      deep_link: deepLink,
      self_id: selfId,
      captured_via: "operator_grab_transcript", document_title: videoTitle, chars: content.length,
      custody: custodyBlock(`yt-${videoId || docKey}`),
    };

    if (dryRun) return json({ ok: true, dry_run: true, kind, evidence_kind: evidenceKind, auto_caption: isAuto, locus: attestation.locus, deep_link: deepLink, self_id: selfId, chars: content.length });

    const ins = await supabase.from("source_document").insert({
      document_key: docKey, version_index: 1, origin: "transcript",
      source_url: deepLink, title: `${videoTitle}${channel ? " — " + channel : ""} [${selfId.timestamp_range}]`,
      source_date: publishedDate, captured_at: nowIso, client_scope: null,
      content_hash: await sha256Hex(content), attestation, retention_basis: "operator_source",
      content, content_ref: null, payload_state: "present", evidence_scope: evidenceScope, forgetting_exempt: true,
    }).select("id").single();
    if (ins.error) return json({ error: `insert: ${ins.error.message}` }, 500);
    return json({ ok: true, kind, source_document_id: (ins.data as { id: string }).id, evidence_kind: evidenceKind, auto_caption: isAuto, licensed, deep_link: deepLink, self_id: selfId });
  }

  // ---- HTML ARTICLE — grabbed reader-mode text; locus = the document, deep-link via text-fragment ----
  if (kind === "html") {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const title = sanitizeTitle(typeof body.title === "string" ? body.title : "");
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!url || !title || !text) return json({ error: "html needs url, title, text (the grabbed reader-mode article)" }, 400);
    const frag = text.replace(/\s+/g, " ").trim().slice(0, 100);
    const attestation = {
      kind: "html", evidence_kind: "html_text",
      locus: { kind: "document", ref: null },
      deep_link: url.split("#")[0] + "#:~:text=" + encodeURIComponent(frag),
      self_id: { title, url, capture_date: nowIso },
      captured_via: "operator_grab_html", document_title: title, chars: text.length,
      custody: custodyBlock("html-" + docKey),
    };
    if (dryRun) return json({ ok: true, dry_run: true, kind, attestation });
    const ins = await supabase.from("source_document").insert({
      document_key: docKey, version_index: 1, origin: "upload", source_url: url, title,
      captured_at: nowIso, client_scope: null, content_hash: await sha256Hex(text), attestation,
      retention_basis: "operator_source", content: text, content_ref: null, payload_state: "present",
      evidence_scope: evidenceScope, forgetting_exempt: true,
    }).select("id").single();
    if (ins.error) return json({ error: `insert: ${ins.error.message}` }, 500);
    return json({ ok: true, kind, source_document_id: (ins.data as { id: string }).id, evidence_kind: "html_text", licensed });
  }

  // ---- PDF (text-layer, and scanned+OCR) — the page-locus renderer already lives in pdf-page-ingest, which this
  // component adopts as its PDF path (same generalized model: locus.kind='page'). A scanned page (no text layer)
  // is flagged there for the image+OCR path. Not duplicated here — dispatch documents the four-renderer design.
  if (kind === "pdf") {
    return json({ ok: false, dispatch: "pdf-page-ingest", note: "PDF text-layer + scanned-image/OCR is served by pdf-page-ingest (locus.kind='page'); call it with the operator's file url + custody. Kept as one renderer of Component C, not re-implemented here." }, 409);
  }

  return json({ error: "kind must be one of: video_transcript | html | pdf", got: kind }, 400);
});
