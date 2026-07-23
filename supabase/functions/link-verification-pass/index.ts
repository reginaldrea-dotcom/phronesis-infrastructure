// link-verification-pass — C11 (Napoleon 03df2aae; plan SP d7d1a532). Parses every URL an
// engine returned out of engine_dispatch.response_raw and verifies each one CHEAPLY and
// POINT-IN-TIME: does it resolve, is it junk (consent wall / paywall / login gate / soft-404 /
// empty shell), does it bear on the question it was returned for. Records the verdict as a
// fact with a timestamp — NOT a capture, NOT a freeze. VERIFIED != GROUNDED: grounding stays
// reserved for the load-bearing subset (write_ground_fact); this pass triages the other ~85%.
//
// R4 discipline: existence + junk detection are MECHANICAL (status, content shape, patterns) —
// no model. Only the bounded relevance judgment calls a model, and it is the CHEAPEST that
// works (Haiku). Index/landing-page suspicion (the C12 advance party) is CONTENT-based — link
// density, prose ratio, list structure — never URL-pattern-based (Napoleon's false-positive
// warning: a genuine briefing lived under /resources/).
//
// Shape: bounded + resumable, like interrogate-precompute. POST {theo_session_id, limit?} —
// parses once (idempotent), verifies up to `limit` DISTINCT URLs per call (each verdict is
// copied to every row citing that URL), returns remaining/done. Re-invoke until done:true.
// Access: UUID-addressed (session id is the capability), verify_jwt=false, service-role writes.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mirrors theo-dispatch-worker/lib/queue.ts URL_RE + trailing-punct trim, so parse counts
// reconcile with engine_dispatch.source_count (same derivation, different granularity).
const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/gi;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;
const TICK_BUDGET_MS = 100_000;   // EF wall is ~150s; leave finalize headroom
const FETCH_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 400_000;
const RELEVANCE_MODEL = "claude-haiku-4-5-20251001";
const UA = "Mozilla/5.0 (compatible; PhronesisLinkVerify/1.0; +https://clarev.ai)";

function env(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Normalization = the dedup key, nothing more. Lowercased host, no fragment, tracking params
// stripped. Path case is preserved (paths are case-sensitive on many hosts).
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    const drop: string[] = [];
    u.searchParams.forEach((_, k) => {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref_src)/i.test(k)) drop.push(k);
    });
    drop.forEach((k) => u.searchParams.delete(k));
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return null;
  }
}

function stripHtml(html: string): { text: string; links: number; listItems: number; pChars: number } {
  const links = (html.match(/<a[\s>]/gi) ?? []).length;
  const listItems = (html.match(/<li[\s>]/gi) ?? []).length;
  const pMatches = html.match(/<p[\s>][\s\S]*?<\/p>/gi) ?? [];
  const pChars = pMatches.reduce((n, p) => n + p.replace(/<[^>]+>/g, "").trim().length, 0);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text, links, listItems, pChars };
}

// MECHANICAL junk classification — content-based patterns, each paired with a smallness
// condition so a footer cookie-notice on a real page never condemns it.
function classifyJunk(status: number, text: string, html: string, textLen: number): string | null {
  const t = text.toLowerCase().slice(0, 6000);
  if (status === 200 && textLen < 400) return "empty_shell";
  if (status === 200 && textLen < 3000 &&
    /(page (you requested )?(was|could) not (be )?found|doesn'?t exist|no longer available|error 404|404 not found)/.test(t)) {
    return "soft_404";
  }
  if (textLen < 2500 &&
    /(accept (all )?cookies|we use (some essential )?cookies|cookies? on gov\.uk|before you continue|cookie (settings|preferences|consent))/.test(t)) {
    return "consent_wall";
  }
  if (textLen < 3000 &&
    /(subscribe (now|today|to (read|continue))|sign in to (read|continue)|to continue reading|this (article|content) is (for|reserved for) (subscribers|members))/.test(t)) {
    return "paywall";
  }
  if (textLen < 2000 && /type=["']?password/i.test(html) && /\b(log ?in|sign ?in)\b/.test(t)) {
    return "login_gate";
  }
  return null;
}

// C12 advance party: index-ness from CONTENT SHAPE. High link density + low prose share +
// list-dominated structure. A flag for the audit, never a verdict.
function indexSignals(textLen: number, links: number, listItems: number, pChars: number) {
  const kb = Math.max(textLen, 1) / 1000;
  const linkDensity = links / kb;              // anchors per KB of visible text
  const proseRatio = pChars / Math.max(textLen, 1);
  const suspect = textLen > 400 && linkDensity > 8 && proseRatio < 0.35 && (links > 30 || listItems > 25);
  return { suspect, signals: { links, list_items: listItems, text_kb: Math.round(kb * 10) / 10, link_density: Math.round(linkDensity * 10) / 10, prose_ratio: Math.round(proseRatio * 100) / 100 } };
}

// The ONE model call — bounded relevance, cheapest model that works. Fail-open on parse
// failure (a good link must not be condemned by a formatting hiccup), with the failure noted.
async function judgeRelevance(questions: string[], pageText: string): Promise<{ relevant: boolean; note: string }> {
  const qs = questions.length ? questions.map((q, i) => `${i + 1}. ${q}`).join("\n") : "(no question text on file — judge general research usefulness)";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: RELEVANCE_MODEL,
      max_tokens: 150,
      messages: [{
        role: "user",
        content: `Research question(s) an engine was answering:\n${qs}\n\nPage text (truncated):\n${pageText.slice(0, 4000)}\n\nDoes this page contain content bearing on ANY of the questions? Answer with ONLY a JSON object: {"relevant": true|false, "note": "<=120 chars why"}`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const textOut = (data?.content?.[0]?.text ?? "") as string;
  const m = textOut.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const p = JSON.parse(m[0]);
      if (typeof p.relevant === "boolean") return { relevant: p.relevant, note: String(p.note ?? "").slice(0, 200) };
    } catch { /* fall through */ }
  }
  return { relevant: true, note: "(judgment unparsed — kept)" };
}

interface VerifyResult {
  verdict: string;
  junk_class: string | null;
  http_status: number | null;
  final_url: string | null;
  content_type: string | null;
  text_length: number | null;
  index_suspect: boolean;
  index_signals: unknown;
  relevance_note: string | null;
  relevance_model: string | null;
  verify_error: string | null;
}

async function verifyOne(url: string, questions: string[]): Promise<VerifyResult> {
  const base: VerifyResult = {
    verdict: "error", junk_class: null, http_status: null, final_url: null, content_type: null,
    text_length: null, index_suspect: false, index_signals: null, relevance_note: null,
    relevance_model: null, verify_error: null,
  };
  let res: Response;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/pdf,*/*" } });
    } finally { clearTimeout(t); }
  } catch (e) {
    // Unreachable at verification time = dead, point-in-time. DNS failure, refused, timeout.
    return { ...base, verdict: "dead", verify_error: String(e).slice(0, 300) };
  }
  base.http_status = res.status;
  base.final_url = res.url && res.url !== url ? res.url : null;
  base.content_type = res.headers.get("content-type");
  if (res.status >= 400) {
    res.body?.cancel();
    return { ...base, verdict: "dead" };
  }
  const ct = (base.content_type ?? "").toLowerCase();
  // Non-HTML (PDF, data files): resolving with substance is enough for point-in-time
  // verification — text-level relevance would mean parsing binaries, out of C11 scope.
  if (!ct.includes("html") && ct !== "") {
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 300) return { ...base, verdict: "junk", junk_class: "empty_shell", text_length: buf.byteLength };
    return { ...base, verdict: "usable", text_length: buf.byteLength, relevance_note: `non-HTML (${ct.split(";")[0]}) — resolves with substance; content not judged` };
  }
  const reader = res.body?.getReader();
  let html = "";
  if (reader) {
    const dec = new TextDecoder();
    let got = 0;
    while (got < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      html += dec.decode(value, { stream: true });
    }
    try { await reader.cancel(); } catch { /* fine */ }
  } else {
    html = await res.text();
  }
  const { text, links, listItems, pChars } = stripHtml(html);
  base.text_length = text.length;
  const junk = classifyJunk(res.status, text, html, text.length);
  if (junk) return { ...base, verdict: "junk", junk_class: junk };
  const idx = indexSignals(text.length, links, listItems, pChars);
  base.index_suspect = idx.suspect;
  base.index_signals = idx.signals;
  try {
    const rel = await judgeRelevance(questions, text);
    base.relevance_model = RELEVANCE_MODEL;
    base.relevance_note = rel.note;
    base.verdict = rel.relevant ? "usable" : "irrelevant";
  } catch (e) {
    // Mechanical checks passed; the model leg failed — keep the link pending for retry rather
    // than inventing a judgment.
    return { ...base, verdict: "pending", verify_error: `relevance: ${String(e).slice(0, 200)}` };
  }
  return base;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const started = Date.now();

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const sessionId = typeof body.theo_session_id === "string" ? body.theo_session_id.trim() : "";
  if (!UUID_RE.test(sessionId)) return json({ error: "theo_session_id must be a full UUID" }, 400);
  const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  // ---- PARSE (idempotent): extract every URL from every returned dispatch into pending rows.
  const disp = await supabase.from("engine_dispatch")
    .select("id, engine_name, question_id, response_raw")
    .eq("theo_session_id", sessionId)
    .not("response_raw", "is", null);
  if (disp.error) return json({ error: `dispatch read: ${disp.error.message}` }, 500);
  let parsedNew = 0;
  for (const d of (disp.data ?? []) as Array<Record<string, unknown>>) {
    const raw = String(d.response_raw ?? "");
    const found = raw.match(URL_RE) ?? [];
    const seen = new Map<string, string>();
    for (const f of found) {
      const trimmed = f.replace(/[.,;:'")\]}>]+$/, "");
      const norm = normalizeUrl(trimmed);
      if (norm && !seen.has(norm)) seen.set(norm, trimmed);
    }
    if (!seen.size) continue;
    const rows = [...seen.entries()].map(([norm, orig]) => ({
      theo_session_id: sessionId,
      engine_dispatch_id: d.id,
      engine_name: d.engine_name,
      question_id: d.question_id ?? null,
      url: orig,
      normalized_url: norm,
    }));
    const ins = await supabase.from("link_verification")
      .upsert(rows, { onConflict: "engine_dispatch_id,normalized_url", ignoreDuplicates: true, count: "exact" });
    if (ins.error) return json({ error: `parse insert: ${ins.error.message}` }, 500);
    parsedNew += ins.count ?? 0;
  }

  // ---- VERIFY: claim up to `limit` distinct pending URLs; verdicts copy to all citing rows.
  const pend = await supabase.from("link_verification")
    .select("normalized_url, url, question_id, attempts")
    .eq("theo_session_id", sessionId)
    .eq("verdict", "pending")
    .order("created_at", { ascending: true });
  if (pend.error) return json({ error: `pending read: ${pend.error.message}` }, 500);
  const pendRows = (pend.data ?? []) as Array<Record<string, unknown>>;

  const byUrl = new Map<string, { url: string; questionIds: Set<string>; attempts: number }>();
  for (const r of pendRows) {
    const k = String(r.normalized_url);
    if (!byUrl.has(k)) byUrl.set(k, { url: String(r.url), questionIds: new Set(), attempts: Number(r.attempts) || 0 });
    if (r.question_id) byUrl.get(k)!.questionIds.add(String(r.question_id));
  }
  const distinctPending = byUrl.size;
  const batch = [...byUrl.entries()].slice(0, limit);

  // Question texts for the relevance judgment (one read for the batch).
  const qIds = [...new Set(batch.flatMap(([, v]) => [...v.questionIds]))];
  const qText = new Map<string, string>();
  if (qIds.length) {
    const qs = await supabase.from("research_question").select("id, question_text").in("id", qIds);
    if (!qs.error) for (const q of (qs.data ?? []) as Array<Record<string, unknown>>) qText.set(String(q.id), String(q.question_text));
  }

  const results: Array<{ url: string; verdict: string; junk_class: string | null; index_suspect: boolean }> = [];
  // Parallel within the batch — the wall-clock cost is max(fetch), not sum.
  await Promise.all(batch.map(async ([norm, meta]) => {
    if (Date.now() - started > TICK_BUDGET_MS) return;
    const questions = [...meta.questionIds].map((id) => qText.get(id)).filter(Boolean) as string[];
    let r: VerifyResult;
    try { r = await verifyOne(meta.url, questions); }
    catch (e) { r = { verdict: "error", junk_class: null, http_status: null, final_url: null, content_type: null, text_length: null, index_suspect: false, index_signals: null, relevance_note: null, relevance_model: null, verify_error: String(e).slice(0, 300) } as VerifyResult; }
    // Retry ladder: a pending verdict (model-leg failure) retries up to 3 attempts, then error.
    const attempts = meta.attempts + 1;
    const finalVerdict = r.verdict === "pending" && attempts >= 3 ? "error" : r.verdict;
    const upd = await supabase.from("link_verification")
      .update({
        verdict: finalVerdict, junk_class: r.junk_class, http_status: r.http_status,
        final_url: r.final_url, content_type: r.content_type, text_length: r.text_length,
        index_suspect: r.index_suspect, index_signals: r.index_signals,
        relevance_note: r.relevance_note, relevance_model: r.relevance_model,
        verify_error: r.verify_error, attempts,
        verified_at: finalVerdict === "pending" ? null : new Date().toISOString(),
      })
      .eq("theo_session_id", sessionId).eq("normalized_url", norm).eq("verdict", "pending");
    if (!upd.error) results.push({ url: meta.url, verdict: finalVerdict, junk_class: r.junk_class, index_suspect: r.index_suspect });
  }));

  const verifiedNow = results.filter((r) => r.verdict !== "pending").length;
  const remaining = Math.max(distinctPending - verifiedNow, 0);
  return json({
    theo_session_id: sessionId,
    parsed_new_rows: parsedNew,
    distinct_pending_before: distinctPending,
    verified_this_call: results,
    remaining_distinct: remaining,
    done: remaining === 0,
  });
});
