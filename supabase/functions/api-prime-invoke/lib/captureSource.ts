// api-prime-invoke | captureSource | Roadmap Phase 1 — capture-at-research-time (conf 3b422dba, MR b5a5e658) | 8 Jun 2026
//
// When a citation is minted, freeze the source behind it: fetch the content NOW (research time,
// not recovery time — a year on the reading may be impossible), hash it, write an IMMUTABLE
// source_document, and return its id to pin on claim_citation.source_document_id. A URL is a
// pointer that rots; the held snapshot is the ground truth. This is the keystone the roadmap rests
// on (Connie's evidence locker is the store; this is its other half — the capture).
//
// BEST-EFFORT BY CONTRACT: a failed / slow / binary / non-web fetch returns null, and the citation
// is written cited-but-NOT-anchored — a LOUD gap (anchor-rate < 100%, visible to Homer's metric and
// the drill), NEVER a silent hole and NEVER a blocked claim write. Capture may not break synthesis.
//
// SCOPE v1: web/public sources only (origin='web', no Phase-0 gate). TEXT/HTML inline. Two named
// follow-ups: (a) binary payloads (PDF filings) need blob storage via content_ref; (b) non-web
// origins (the engineering-director email — origin='email'/'upload') wait on Aegis Phase 0.

import type { SupabaseClient } from "../tools/types.ts";

const FETCH_TIMEOUT_MS = 8000;
const FIRECRAWL_TIMEOUT_MS = 30_000; // Firecrawl renders + solves challenges → slower than a raw fetch
const MAX_CONTENT_BYTES = 800_000; // inline text cap; larger → truncated + attested (blob is the follow-up)
const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// da384853 — challenge-solving fallback. Grand-View-class sites bot-block plain server-side fetches
// with a Cloudflare MANAGED CHALLENGE (HTTP 403 "Just a moment…", JS-gated, UA/header-independent), so
// captureSource's raw fetch cannot anchor them. Firecrawl renders the page (executing the challenge)
// and returns the raw HTML, which we then hash + freeze exactly like a direct capture. Returns the
// rendered HTML + the upstream status, or null. NO-OP IF FIRECRAWL_API_KEY IS UNSET — so deploying this
// before the key is provisioned changes nothing; GVR-class sites simply stay cited-not-anchored as before.
async function captureViaFirecrawl(url: string): Promise<{ content: string; httpStatus: number } | null> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FIRECRAWL_TIMEOUT_MS);
    const res = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
      // rawHtml = the page's HTML after render/challenge — closest to the direct-fetch snapshot for the
      // evidence locker's hash. onlyMainContent:false to keep the whole document (it's the frozen source).
      body: JSON.stringify({ url, formats: ["rawHtml"], onlyMainContent: false, timeout: FIRECRAWL_TIMEOUT_MS - 3000 }),
    });
    clearTimeout(timer);
    if (!res.ok) { console.error(`capture(firecrawl): ${url} -> HTTP ${res.status}`); return null; }
    const j = await res.json().catch(() => null) as { success?: boolean; data?: { rawHtml?: string; html?: string; metadata?: { statusCode?: number } } } | null;
    const html = j?.data?.rawHtml ?? j?.data?.html ?? "";
    if (!j?.success || !html) { console.error(`capture(firecrawl): ${url} -> empty/unsuccessful`); return null; }
    return { content: html, httpStatus: j.data?.metadata?.statusCode ?? 200 };
  } catch (e) {
    console.error(`capture(firecrawl): ${url} -> ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export interface CaptureInput { url: string; title?: string | null; sourceDate?: string | null; sessionId: string; }

// Returns the source_document id to pin, or null (cited-not-anchored — logged, never thrown).
export async function captureSource(supabase: SupabaseClient, input: CaptureInput): Promise<string | null> {
  const url = (input.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return null; // web/public only here; non-web origins wait on Phase 0

  // Dedup WITHIN the research session: a url already captured this session is reused, not re-fetched.
  // Re-capture-as-a-new-version is for content that changes across TIME (a report update — Phase 4),
  // never within one synthesis. (Same-session capture also satisfies Connie's capture-in-own-session rule.)
  try {
    const existing = await supabase
      .from("source_document")
      .select("id")
      .eq("source_url", url)
      .eq("captured_in_session", input.sessionId)
      .eq("payload_state", "present")
      .order("version_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing.data?.id) return existing.data.id as string;
  } catch (_) { /* fall through and capture fresh */ }

  // Fetch the content NOW. Track WHY a direct fetch failed so the Firecrawl fallback fires only for a
  // BLOCK/timeout (da384853), never for a real binary (a PDF filing → the blob follow-up, not a challenge).
  let content: string | null = null;
  let contentType = "", httpStatus = 0, capturedVia = "direct";
  let directFail: "" | "blocked" | "throw" | "nontext" = "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Phronesis-Capture/1 (+evidence-locker)" } });
    clearTimeout(timer);
    httpStatus = res.status;
    contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      directFail = "blocked"; // 403 Cloudflare challenge / 401 / 5xx → Firecrawl-eligible
      console.error(`capture: ${url} -> HTTP ${res.status} (trying Firecrawl fallback)`);
    } else if (contentType !== "" && !/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(contentType)) {
      // v1 inlines TEXT/HTML/JSON/XML. Binary (PDF filings etc.) is left un-anchored pending the blob
      // follow-up — a loud gap, not a fake row. NOT Firecrawl-eligible (it's a real payload, not a block).
      directFail = "nontext";
      console.error(`capture: ${url} -> non-text '${contentType}' deferred to blob follow-up`);
    } else {
      // empty content-type is tolerated (treated as text)
      content = await res.text();
    }
  } catch (e) {
    directFail = "throw";
    console.error(`capture: ${url} -> fetch failed: ${e instanceof Error ? e.message : String(e)} (trying Firecrawl fallback)`);
  }

  // Fallback: only for a block or a timeout/throw (a challenge-class failure), never a real binary.
  if (content === null && (directFail === "blocked" || directFail === "throw")) {
    const fc = await captureViaFirecrawl(url);
    if (fc) {
      content = fc.content;
      contentType = "text/html"; // Firecrawl returns rendered HTML
      httpStatus = fc.httpStatus;
      capturedVia = "firecrawl";
    }
  }

  if (content === null) return null; // cited-not-anchored: direct failed AND (no Firecrawl key OR Firecrawl also failed)

  const truncated = content.length > MAX_CONTENT_BYTES;
  if (truncated) content = content.slice(0, MAX_CONTENT_BYTES);

  const contentHash = await sha256Hex(content);
  const nowIso = new Date().toISOString();
  try {
    const ins = await supabase
      .from("source_document")
      .insert({
        document_key: crypto.randomUUID(), // born as version 1 of its own chain
        version_index: 1,
        supersedes_id: null,
        origin: "web",
        source_url: url,
        title: input.title ?? null,
        source_date: input.sourceDate ?? null,
        captured_at: nowIso,
        captured_in_session: input.sessionId,
        client_scope: null, // web/public — no client scope
        content_hash: contentHash,
        attestation: { http_status: httpStatus, content_type: contentType, bytes: content.length, truncated, fetched_at: nowIso, captured_via: capturedVia },
        retention_basis: "public_source",
        content,
        content_ref: null,
        payload_state: "present",
        forgetting_exempt: true, // evidence is exempt from compaction/clearance by construction
      })
      .select("id")
      .single();
    if (ins.error) { console.error(`capture: source_document insert failed for ${url}: ${ins.error.message}`); return null; }
    return (ins.data as any).id as string;
  } catch (e) {
    console.error(`capture: insert threw for ${url}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
