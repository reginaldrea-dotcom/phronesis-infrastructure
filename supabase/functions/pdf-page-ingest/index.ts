// pdf-page-ingest — C14 page-locus ingest (Napoleon cda68b43 / d893b43c). Splits a born-digital PDF
// into PAGE-UNITS: one source_document per page, each carrying its own identity (document title, PAGE
// NUMBER, total pages, capture date, content hash) so page 34 of ISO/DIS 14060 stands alone as evidence
// (R8 self-identifying unit). Split EVERY page, not only the ones a claim needs — pages are tiny and any
// future claim can point at any page with no re-processing.
//
// COST: born-digital text extraction only — NO model, NO OCR (verified per page: a page whose text layer
// is empty/near-empty is FLAGGED, not silently accepted — that page is a scanned figure needing OCR or an
// image-only capture, caught at ingest not mid-grounding). Grounding LOCATES the page later (Check 1, the
// same O(n) substring gate, scoped to a page). The edge points at the PAGE, not the document.
//
// evidence_scope carries document-vs-locus: page units are 'page' (locus), never 'general'.
//
// Auth: worker-style — apikey header == WORKER_INVOKE_KEY (manual admin trigger). verify_jwt=false.
// Fetch: the PDF must be reachable by URL (a link-shared Drive file, or any public URL). The server has
// no access to a private Drive, by design — that boundary is what keeps operator sources legitimate.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { extractText, getDocumentProxy } from "npm:unpdf@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const TEXT_LAYER_MIN_CHARS = 40; // a page with fewer than this many chars is flagged (likely scanned/figure)

function env(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A link-shared Drive file downloads from uc?export=download for files under the ~25MB scan-warning
// threshold (ours are 1.7 / 2.5 MB). Accept a raw URL too.
function resolveUrl(input: string): string {
  const m = input.match(/drive\.google\.com\/file\/d\/([^/]+)/) || input.match(/[?&]id=([^&]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  if (/^[A-Za-z0-9_-]{20,}$/.test(input)) return `https://drive.google.com/uc?export=download&id=${input}`;
  return input;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const started = Date.now();

  // Auth: constant-ish check against the worker invoke key.
  const apikey = req.headers.get("apikey") ?? "";
  if (!apikey || apikey !== Deno.env.get("WORKER_INVOKE_KEY")) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const docSlug = typeof body.doc_key === "string" ? body.doc_key.trim() : "";
  const docKey = crypto.randomUUID(); // document_key is a uuid; the human slug (if any) rides in attestation
  const dryRun = body.dry_run === true; // extract + report only, write nothing
  if (!rawUrl) return json({ error: "url (or Drive id/link) is required" }, 400);
  if (!title && !dryRun) return json({ error: "title is required" }, 400);

  const url = resolveUrl(rawUrl);

  // 1. Fetch the PDF bytes (server-side; no Drive credentials — the file must be reachable by URL).
  let bytes: Uint8Array;
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "Phronesis-PDFIngest/1" } });
    if (!r.ok) return json({ error: `fetch: HTTP ${r.status} for ${url} (is the file link-shared / public?)` }, 502);
    const ct = (r.headers.get("content-type") ?? "").toLowerCase();
    const buf = new Uint8Array(await r.arrayBuffer());
    // Google returns an HTML interstitial (not a PDF) if the file is NOT link-shared, or for a scan
    // warning. Detect it so the caller gets a clear message instead of a parse failure.
    const head = new TextDecoder().decode(buf.slice(0, 200)).toLowerCase();
    if (ct.includes("text/html") || head.includes("<!doctype html") || head.includes("<html")) {
      return json({ error: "fetched HTML, not a PDF — the file is not publicly reachable (link-share it: Anyone with the link → Viewer), or it hit Google's large-file warning" }, 502);
    }
    bytes = buf;
  } catch (e) {
    return json({ error: `fetch failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
  const fetch_ms = Date.now() - started;

  // 2. Extract per-page text (born-digital; text extraction needs no canvas/render).
  let pages: string[] = [];
  let totalPages = 0;
  const t1 = Date.now();
  try {
    const pdf = await getDocumentProxy(bytes);
    const res = await extractText(pdf, { mergePages: false });
    totalPages = res.totalPages;
    pages = (Array.isArray(res.text) ? res.text : [res.text]).map((p) => (p ?? "").toString());
  } catch (e) {
    return json({ error: `pdf parse failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  const extract_ms = Date.now() - t1;

  // Per-page text-layer report (the honest check — catch a scanned page NOW).
  const pageInfo = pages.map((txt, i) => {
    const clean = txt.replace(/\s+/g, " ").trim();
    return { page: i + 1, chars: clean.length, has_text: clean.length >= TEXT_LAYER_MIN_CHARS };
  });
  const flagged = pageInfo.filter((p) => !p.has_text).map((p) => p.page);
  const chars = pageInfo.map((p) => p.chars);
  const stats = {
    total_pages: totalPages,
    pages_with_text: pageInfo.filter((p) => p.has_text).length,
    pages_flagged_no_text: flagged,
    chars_min: chars.length ? Math.min(...chars) : 0,
    chars_max: chars.length ? Math.max(...chars) : 0,
    chars_mean: chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) : 0,
  };

  if (dryRun) {
    return json({ ok: true, dry_run: true, url, title, stats, cost: { fetch_ms, extract_ms, model_calls: 0, ocr_pages: 0, usd: 0 } });
  }

  // 3. Write one source_document per page. document_key groups the pages of one document; version_index
  // = the PAGE NUMBER so a page is addressable and self-identifying. content_hash from the page's own text.
  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));
  const nowIso = new Date().toISOString();
  const rows = [];
  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    const content = pages[i] ?? "";
    rows.push({
      document_key: docKey,
      version_index: pageNo,               // page number is the version index within this document_key
      supersedes_id: null,
      origin: "upload",  // operator-supplied PDF; the mechanism (unpdf page split) is in attestation.captured_via
      source_url: `${rawUrl}#page=${pageNo}`,
      title: `${title} — p.${pageNo}/${totalPages}`,
      captured_at: nowIso,
      client_scope: null,
      content_hash: await sha256Hex(content),
      attestation: {
        document_title: title, doc_slug: docSlug || null, page_number: pageNo, total_pages: totalPages,
        has_text_layer: content.replace(/\s+/g, " ").trim().length >= TEXT_LAYER_MIN_CHARS,
        chars: content.length, captured_via: "unpdf_page_split", source: url,
      },
      retention_basis: "public_source",
      content,
      content_ref: null,
      payload_state: "present",
      // evidence_scope is a VISIBILITY axis (general/personal, CHECK-constrained) — NOT document-vs-locus.
      // Overloading it would conflate who-can-see with page-vs-document. These standards are general
      // visibility; the PAGE-LOCUS fact lives in attestation (page_number, total_pages, captured_via).
      // A dedicated granularity column is a Connie decision if one is wanted; flagged to Napoleon.
      evidence_scope: "general",
      forgetting_exempt: true,
    });
  }
  // Batch insert (chunks) to keep each statement modest.
  const created: string[] = [];
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    const ins = await supabase.from("source_document").insert(chunk).select("id");
    if (ins.error) return json({ error: `insert (pages ${i + 1}-${i + chunk.length}): ${ins.error.message}`, created_so_far: created.length }, 500);
    for (const r of (ins.data ?? []) as Array<{ id: string }>) created.push(r.id);
  }

  return json({
    ok: true, document_key: docKey, title, pages_created: created.length,
    stats,
    cost: { fetch_ms, extract_ms, write_ms: Date.now() - t1 - extract_ms, model_calls: 0, ocr_pages: 0, usd: 0 },
  });
});
