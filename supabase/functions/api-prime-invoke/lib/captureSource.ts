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
const MAX_CONTENT_BYTES = 800_000; // inline text cap; larger → truncated + attested (blob is the follow-up)

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

  // Fetch the content NOW.
  let content = "", contentType = "", httpStatus = 0, truncated = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Phronesis-Capture/1 (+evidence-locker)" } });
    clearTimeout(timer);
    httpStatus = res.status;
    contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) { console.error(`capture: ${url} -> HTTP ${res.status}`); return null; }
    // v1 inlines TEXT/HTML/JSON/XML. Binary (PDF filings etc.) is left un-anchored pending the blob
    // follow-up — a loud gap, not a fake row. An empty content-type is tolerated (treated as text).
    if (contentType !== "" && !/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(contentType)) {
      console.error(`capture: ${url} -> non-text '${contentType}' deferred to blob follow-up`);
      return null;
    }
    const raw = await res.text();
    truncated = raw.length > MAX_CONTENT_BYTES;
    content = truncated ? raw.slice(0, MAX_CONTENT_BYTES) : raw;
  } catch (e) {
    console.error(`capture: ${url} -> fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

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
        attestation: { http_status: httpStatus, content_type: contentType, bytes: content.length, truncated, fetched_at: nowIso },
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
