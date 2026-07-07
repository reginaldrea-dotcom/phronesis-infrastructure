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
//
// RENDERED-EVIDENCE PATH (captureScreenshot=true; Heph 7 Jul 2026, design 1a9f0797 / a656ff1d).
// The default path is a raw server-side fetch — blind to JS-rendered figures (the ONS 171,000 was
// injected client-side and never appeared in the frozen bytes) and it froze 404/error pages as if
// they were solid anchors. For ground_fact evidence we need PROOF a human can see, so the caller
// opts in: we render via Firecrawl (executing the page's JS), store the RENDERED MARKDOWN as the
// searchable content, capture a FULL-PAGE SCREENSHOT into Storage (bucket evidence-captures), and
// fire a best-effort Wayback "Save Page Now" for a neutral third-party archive URL. All three land
// on source_document (attestation.screenshot_url / archive_url / http_status). The per-fact
// canonical-string MATCH (numeric gate) and the human-review flag (qualitative) are decided by the
// CALLER (write_ground_fact) against the rendered markdown — not here — because one URL can back
// several facts. This path is OFF by default, so the claim-citation callers are unchanged.

import type { SupabaseClient } from "../tools/types.ts";

const FETCH_TIMEOUT_MS = 8000;
const FIRECRAWL_TIMEOUT_MS = 30_000; // Firecrawl renders + solves challenges → slower than a raw fetch
const WAYBACK_TIMEOUT_MS = 20_000;   // Save-Page-Now; best-effort, never blocks anchoring
const MAX_CONTENT_BYTES = 800_000; // inline text cap; larger → truncated + attested (blob is the follow-up)
const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";
const SCREENSHOT_BUCKET = "evidence-captures";

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

// Rendered-evidence capture: Firecrawl in render mode returning MARKDOWN (searchable text after JS
// executes — where dynamic figures like the ONS 171,000 actually appear) plus a FULL-PAGE screenshot
// URL. Returns null if no key / failure, so the caller can fall back to a text-only freeze.
async function captureRendered(url: string): Promise<{ markdown: string; screenshotUrl: string | null; httpStatus: number } | null> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) { console.error("capture(render): FIRECRAWL_API_KEY unset — cannot render/screenshot"); return null; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FIRECRAWL_TIMEOUT_MS);
    const res = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "authorization": `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ["markdown", "screenshot@fullPage"], onlyMainContent: false, timeout: FIRECRAWL_TIMEOUT_MS - 3000 }),
    });
    clearTimeout(timer);
    if (!res.ok) { console.error(`capture(render): ${url} -> HTTP ${res.status}`); return null; }
    const j = await res.json().catch(() => null) as
      { success?: boolean; data?: { markdown?: string; screenshot?: string; metadata?: { statusCode?: number } } } | null;
    const markdown = j?.data?.markdown ?? "";
    if (!j?.success || !markdown) { console.error(`capture(render): ${url} -> empty/unsuccessful`); return null; }
    return { markdown, screenshotUrl: j.data?.screenshot ?? null, httpStatus: j.data?.metadata?.statusCode ?? 200 };
  } catch (e) {
    console.error(`capture(render): ${url} -> ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Pull the Firecrawl screenshot bytes and freeze them in our own Storage bucket (Firecrawl's hosted
// URL is temporary). Returns { path, publicUrl } or null. Best-effort — a failed screenshot upload
// must not sink the whole capture (the markdown + hash still anchor).
async function freezeScreenshot(
  supabase: SupabaseClient,
  screenshotUrl: string | null,
): Promise<{ path: string; publicUrl: string } | null> {
  if (!screenshotUrl) return null;
  try {
    let bytes: Uint8Array | null = null;
    if (/^https?:\/\//i.test(screenshotUrl)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const r = await fetch(screenshotUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) { console.error(`capture(shot): fetch screenshot -> HTTP ${r.status}`); return null; }
      bytes = new Uint8Array(await r.arrayBuffer());
    } else if (screenshotUrl.startsWith("data:")) {
      const b64 = screenshotUrl.slice(screenshotUrl.indexOf(",") + 1);
      bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    }
    if (!bytes || bytes.length === 0) return null;
    const path = `shot-${crypto.randomUUID()}.png`; // random per capture — NEVER derive from a secret
    const up = await supabase.storage.from(SCREENSHOT_BUCKET).upload(path, bytes, { contentType: "image/png", upsert: true });
    if (up.error) { console.error(`capture(shot): upload failed: ${up.error.message}`); return null; }
    const pub = supabase.storage.from(SCREENSHOT_BUCKET).getPublicUrl(path);
    return { path, publicUrl: pub.data.publicUrl };
  } catch (e) {
    console.error(`capture(shot): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Wayback "Save Page Now" — a neutral, tamper-evident, publicly-openable third-party archive. The
// strongest accessible proof for a skeptical outside reader (we are not vouching for ourselves).
// Best-effort: returns the archived snapshot URL or null; never blocks anchoring.
async function archiveToWayback(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WAYBACK_TIMEOUT_MS);
    const res = await fetch(`https://web.archive.org/save/${url}`, {
      method: "GET",
      redirect: "manual",
      signal: ctrl.signal,
      headers: { "user-agent": "Phronesis-Capture/1 (+evidence-locker)" },
    });
    clearTimeout(timer);
    // SPN reports the frozen snapshot path via content-location (/web/<ts>/<url>); location on redirect.
    const cl = res.headers.get("content-location") || res.headers.get("location") || "";
    if (cl.startsWith("/web/")) return `https://web.archive.org${cl}`;
    if (/^https?:\/\/web\.archive\.org\/web\//i.test(cl)) return cl;
    return null;
  } catch (e) {
    console.error(`capture(wayback): ${url} -> ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export interface CaptureInput {
  url: string;
  title?: string | null;
  sourceDate?: string | null;
  sessionId: string;
  captureScreenshot?: boolean; // opt-in rendered-evidence path (ground_fact); default false = cheap fetch
}

// Returns the source_document id to pin, or null (cited-not-anchored — logged, never thrown).
export async function captureSource(supabase: SupabaseClient, input: CaptureInput): Promise<string | null> {
  const url = (input.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return null; // web/public only here; non-web origins wait on Phase 0
  const wantShot = input.captureScreenshot === true;

  // Reuse an already-frozen snapshot across the CONVERSATION, not just this session (Conf d36d9609 /
  // baton 8cb99efa; Connie ruling 82d38a8f). The session is a workflow partition; the CONVERSATION is
  // the evidence-ownership boundary. Capture still WRITES into its own session (the insert below is
  // unchanged), but a sibling session in the same conversation may already have frozen this exact url —
  // reuse that immutable anchor rather than re-freezing a duplicate, so an arc can cite capture-session
  // evidence. client_scope must MATCH (IS NOT DISTINCT FROM) so client-scoped evidence cannot leak
  // across the widening; web/public captures carry client_scope = null. Re-capture-as-a-new-version is
  // for content that changes across TIME (Phase 4), never within one conversation.
  //
  // When a screenshot is REQUIRED, only reuse a prior capture that HAS one — a text-only claim-path
  // freeze of the same URL is not sufficient evidence for a ground_fact, so we capture fresh instead.
  const clientScope: string | null = null; // v1: web/public only (mirrors the insert below)
  try {
    const convRow = await supabase
      .from("theo_session").select("conversation_id").eq("id", input.sessionId).maybeSingle();
    const conversationId = (convRow.data as { conversation_id?: string } | null)?.conversation_id ?? null;
    let siblingIds: string[] = [input.sessionId];
    if (conversationId) {
      const sibs = await supabase.from("theo_session").select("id").eq("conversation_id", conversationId);
      const ids = ((sibs.data ?? []) as Array<{ id: string }>).map((r) => String(r.id));
      if (ids.length > 0) siblingIds = ids;
    }
    let q = supabase
      .from("source_document").select("id, attestation")
      .eq("source_url", url)
      .eq("payload_state", "present")
      .in("captured_in_session", siblingIds);
    q = clientScope === null ? q.is("client_scope", null) : q.eq("client_scope", clientScope);
    const existing = await q.order("version_index", { ascending: false }).limit(1).maybeSingle();
    const row = existing.data as { id?: string; attestation?: { screenshot_url?: string } } | null;
    if (row?.id && (!wantShot || row.attestation?.screenshot_url)) return row.id as string;
  } catch (_) { /* fall through and capture fresh */ }

  let content: string | null = null;
  let contentType = "", httpStatus = 0, capturedVia = "direct";
  let screenshotUrl: string | null = null, screenshotPath: string | null = null, archiveUrl: string | null = null;

  if (wantShot) {
    // Rendered-evidence path: render (markdown) + full-page screenshot, freeze the PNG, archive to Wayback.
    const rendered = await captureRendered(url);
    if (rendered) {
      content = rendered.markdown;
      contentType = "text/markdown";
      httpStatus = rendered.httpStatus;
      capturedVia = "firecrawl_render";
      const shot = await freezeScreenshot(supabase, rendered.screenshotUrl);
      if (shot) { screenshotUrl = shot.publicUrl; screenshotPath = shot.path; }
      archiveUrl = await archiveToWayback(url); // best-effort neutral archive
    } else {
      // Render failed / no key: fall back to a text-only direct freeze so we still hold SOMETHING, but
      // with no screenshot the caller will mark the fact cited-not-verified (honest — no visible proof).
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Phronesis-Capture/1 (+evidence-locker)" } });
        clearTimeout(timer);
        httpStatus = res.status;
        contentType = res.headers.get("content-type") ?? "";
        if (res.ok && (contentType === "" || /^(text\/|application\/(json|xml|xhtml\+xml))/i.test(contentType))) {
          content = await res.text();
        }
      } catch (e) {
        console.error(`capture(render-fallback): ${url} -> ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else {
    // Default cheap path (unchanged): direct fetch, Firecrawl-rawHtml fallback only for a block/timeout.
    let directFail: "" | "blocked" | "throw" | "nontext" = "";
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Phronesis-Capture/1 (+evidence-locker)" } });
      clearTimeout(timer);
      httpStatus = res.status;
      contentType = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        directFail = "blocked";
        console.error(`capture: ${url} -> HTTP ${res.status} (trying Firecrawl fallback)`);
      } else if (contentType !== "" && !/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(contentType)) {
        directFail = "nontext";
        console.error(`capture: ${url} -> non-text '${contentType}' deferred to blob follow-up`);
      } else {
        content = await res.text();
      }
    } catch (e) {
      directFail = "throw";
      console.error(`capture: ${url} -> fetch failed: ${e instanceof Error ? e.message : String(e)} (trying Firecrawl fallback)`);
    }
    if (content === null && (directFail === "blocked" || directFail === "throw")) {
      const fc = await captureViaFirecrawl(url);
      if (fc) { content = fc.content; contentType = "text/html"; httpStatus = fc.httpStatus; capturedVia = "firecrawl"; }
    }
  }

  if (content === null) return null; // cited-not-anchored: nothing fetchable to freeze

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
        attestation: {
          http_status: httpStatus, content_type: contentType, bytes: content.length, truncated,
          fetched_at: nowIso, captured_via: capturedVia,
          screenshot_url: screenshotUrl, screenshot_path: screenshotPath, archive_url: archiveUrl,
        },
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
