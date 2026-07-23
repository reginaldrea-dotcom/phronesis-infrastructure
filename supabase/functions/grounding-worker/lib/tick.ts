// grounding-worker tick. One invocation = one tick. All state lives in the substrate (grounding_queue);
// no in-memory state across ticks.
//
// Per tick: reap stranded rows -> claim one pending row at a time (FOR UPDATE SKIP LOCKED, so overlapping
// ticks are safe) -> ground it by invoking Angelia through the Prime EF -> judge the outcome by a DB SIDE
// EFFECT (did a claim_on_fact edge appear?), NOT by parsing the model's prose (the confabulation lesson) ->
// mark grounded / retry / failed. Bounded by MAX_PER_TICK and a wall-clock budget so a tick never races the
// ~150s gateway wall. Newly-failed claims are routed to Theo as a wake_delta (Reg decision 4).

import type { SupabaseClient } from "./supabase.ts";
import { env } from "./env.ts";
import {
  GROUNDING_LINEAGE, MAX_PER_TICK, PRIME_INVOKE_TIMEOUT_MS, PRIME_INVOKE_URL, STALE_MINUTES, TICK_BUDGET_MS,
} from "./config.ts";

interface QRow {
  id: string; claim_id: string; synthesis_id: string | null; attempts: number; max_attempts: number;
  source_hint: Record<string, unknown> | null;
}

export interface TickSummary {
  tick: string; reaped: number; processed: number; grounded: number; failed: number;
  pending_remaining: number | null; elapsed_ms: number;
}

export async function tick(supabase: SupabaseClient): Promise<TickSummary> {
  const tickId = crypto.randomUUID().slice(0, 8);
  const started = Date.now();

  const reap = await supabase.rpc("grounding_reap", { p_stale_minutes: STALE_MINUTES });
  const reaped = typeof reap.data === "number" ? reap.data : 0;

  let grounded = 0, failed = 0, processed = 0;
  const newlyFailed: Array<{ claim_id: string; error: string }> = [];

  while (processed < MAX_PER_TICK && (Date.now() - started) < TICK_BUDGET_MS) {
    const claim = await supabase.rpc("grounding_claim_one", { p_tick_id: tickId });
    if (claim.error) throw new Error(`grounding_claim_one failed: ${claim.error.message}`);
    const r = (Array.isArray(claim.data) ? claim.data[0] : claim.data) as QRow | null;
    if (!r || !r.id) break; // queue empty
    processed++;

    const outcome = await groundOne(supabase, r);
    if (outcome.grounded) {
      await supabase.rpc("grounding_mark", { p_id: r.id, p_state: "grounded" });
      grounded++;
    } else if (r.attempts >= r.max_attempts) {
      await supabase.rpc("grounding_mark", { p_id: r.id, p_state: "failed", p_error: outcome.note });
      failed++;
      newlyFailed.push({ claim_id: r.claim_id, error: outcome.note });
    } else {
      // transient miss - back to pending for a later tick (attempts already counted at claim).
      await supabase.rpc("grounding_mark", { p_id: r.id, p_state: "pending", p_error: outcome.note });
    }
  }

  if (newlyFailed.length > 0) await notifyTheo(supabase, newlyFailed);

  const pend = await supabase.from("grounding_queue").select("*", { count: "exact", head: true }).eq("state", "pending");
  return {
    tick: tickId, reaped, processed, grounded, failed,
    pending_remaining: pend.count ?? null, elapsed_ms: Date.now() - started,
  };
}

// Ground ONE claim. Judge success by whether a VERIFIED claim_on_fact edge exists AFTER the invocation, never
// by the model's words. Returns grounded + a short note (the model's reason on a miss, for Theo's triage).
//
// RE-GROUND MODE (C13, Napoleon 9e10eb02 — the landing-page correction run): a source_hint carrying
// "reground": true means the claim ALREADY has a verified edge (typically screenshot_review on an
// index-suspect landing page) and the task is to ground the underlying DOCUMENT instead. Two changes,
// both ADDITIVE: (1) the already-grounded short-circuit is skipped — it would otherwise return
// success without invoking Angelia at all; (2) success is judged ONLY by a verified edge CREATED
// AFTER this invocation started — the pre-existing edge cannot fake a pass. The old edge is never
// touched: Angelia mints a NEW fact from the document and links a NEW parallel edge; supersession of
// the landing edge is a later, human-gated act once the replacement has verified better.
async function groundOne(supabase: SupabaseClient, r: QRow): Promise<{ grounded: boolean; note: string }> {
  const reground = (r.source_hint as { reground?: boolean } | null)?.reground === true;
  const startedIso = new Date().toISOString();
  if (!reground && await hasVerifiedEdge(supabase, r.claim_id)) return { grounded: true, note: "already grounded" };

  let respText = "";
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PRIME_INVOKE_TIMEOUT_MS);
    const resp = await fetch(PRIME_INVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "apikey": env("THEO_DISPATCH_SECRET_KEY") },
      body: JSON.stringify({
        lineage_name: GROUNDING_LINEAGE,
        session_id: crypto.randomUUID(),                  // fresh short session per claim (clean context)
        user_message: groundingPrompt(r.claim_id, r.source_hint),
        request_id: `grounding-${r.claim_id}-${crypto.randomUUID().slice(0, 8)}`, // UNIQUE per invocation: a deterministic id let the idempotency cache replay a prior failure across retries
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const j = await resp.json().catch(() => ({}));
    respText = typeof (j as { response?: unknown })?.response === "string"
      ? (j as { response: string }).response
      : JSON.stringify(j).slice(0, 400);
  } catch (e) {
    respText = `prime invoke error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const grounded = await hasVerifiedEdge(supabase, r.claim_id, reground ? startedIso : undefined);
  return { grounded, note: grounded ? "grounded" : excerpt(respText) };
}

// A claim counts as GROUNDED only when its claim_on_fact edge is VERIFIED - anchored (numeric co-location) or
// screenshot_review (qualitative, awaiting a human) - NOT a bare cited_not_verified edge. Judging mere
// edge-EXISTENCE let a first attempt that wrote an UNANCHORED edge short-circuit every retry ("already
// grounded"), so the anchor could never land (repro: claim 47ffb727 stuck cited_not_verified across 4
// re-queues - the worker skipped Angelia on the pre-existing bare edge). Now a bare edge is a MISS: the worker
// re-grounds up to max_attempts, then routes to Theo (decision 4) rather than silently marking it done.
// Optional `sinceIso` (re-ground mode): only an edge CREATED after that instant counts — the
// pre-existing landing-page edge must not satisfy the judge for a re-grounding run.
async function hasVerifiedEdge(supabase: SupabaseClient, claimId: string, sinceIso?: string): Promise<boolean> {
  let q = supabase.from("element_dependency")
    .select("id").eq("dependent_synthesis_claim_id", claimId).eq("edge_kind", "claim_on_fact")
    .in("verification_state", ["anchored", "screenshot_review"]);
  if (sinceIso) q = q.gt("created_at", sinceIso);
  const { data } = await q.limit(1);
  return Array.isArray(data) && data.length > 0;
}

function groundingPrompt(claimId: string, hint: Record<string, unknown> | null): string {
  const url = typeof hint?.url === "string" ? hint.url as string : "";
  const docId = typeof hint?.source_document_id === "string" ? hint.source_document_id as string : "";
  const anchorHint = typeof hint?.anchor_hint === "string" ? hint.anchor_hint as string
    : (typeof hint?.key === "string" ? hint.key as string : "");
  const kind = typeof hint?.kind === "string" ? hint.kind as string : "";
  const tier = typeof hint?.tier === "string" ? hint.tier as string : "";
  // Step 2 differs for an ALREADY-CAPTURED operator-supplied document vs a URL to fetch.
  const captureStep = docId
    ? `2. The source is an ALREADY-CAPTURED document (operator-supplied, e.g. an uploaded PDF). Call write_ground_fact with source_document_id = ${docId} (NOT source_url) - the document is already stored, hashed and frozen; do NOT fetch a URL and do NOT look for another source. Choose fact_kind = 'numeric' if the claim's load-bearing element is a figure, else 'qualitative'; set canonical_string to the exact figure (numeric) or the shortest quote (qualitative). Set authority_tier by the SOURCE's own authority (e.g. a BSI Statement of Verification is T2; a company's own report body is T3). The tool binds the fact to the stored document and you anchor against the document's own text.`
    : "2. Capture and freeze its authoritative source with write_ground_fact. Pass the source_url; choose fact_kind = 'numeric' if the claim's load-bearing element is a figure, else 'qualitative'; set canonical_string to the exact figure (numeric) or the shortest quote that makes the claim (qualitative). The tool renders + screenshots + freezes the page and derives the hash itself - do NOT supply a hash.";
  const lines = [
    "GROUNDING TASK - one claim, full grounding (capture/attach + verify + link).",
    `Ground synthesis_claim ${claimId}.`,
    "1. Read the claim.",
    captureStep,
    `3. Then link it AND prove it: write_element_dependency (dependent_type=synthesis_claim, dependent_id=${claimId}, depends_on_type=ground_fact, depends_on_id=<the ground_fact you just wrote>, edge_kind=claim_on_fact). Verification is EARNED on this edge by CO-LOCATION, not by the figure being somewhere in the source:`,
    "   - For a NUMERIC claim: also pass claim_canonical_string = the claim's load-bearing figure exactly as the claim states it, AND anchor_quote = a SHORT VERBATIM span copied word-for-word from the source's own text that contains BOTH that figure AND the claim's subject. The edge ANCHORS only if that span is in the source and the figure + the claim's subject terms co-locate inside it. CRITICAL for TABLES / key-value / statement-of-verification layouts: the bare value is NOT a valid anchor_quote - 'Limited / 10%' or '294,999.6' on its own carries no subject and will FAIL. You MUST include the ROW LABEL / field name in the SAME span, e.g. 'GHG Emissions avoidance: 294,999.6 t CO2e (over a 10-year product in service period)' or 'Level of assurance / materiality: Limited / 10%'. Do NOT paraphrase the quote, do NOT stitch a span from two places, and do NOT pick a span where the figure belongs to a DIFFERENT subject. If no single span carries both the figure and the subject, omit anchor_quote and leave it cited_not_verified - do not force it.",
    "   - For a QUALITATIVE claim: omit claim_canonical_string; pass anchor_quote = the shortest verbatim span that makes the claim. The edge goes to SCREENSHOT_REVIEW for a human. Both anchored and cited_not_verified/screenshot_review are honest outcomes - proceed either way, never fake an anchor.",
  ];
  if (docId) {
    lines.push(`SOURCE ALREADY CAPTURED - source_document_id: ${docId}. Pass it to write_ground_fact as source_document_id (do NOT fetch a URL).`);
    if (anchorHint) lines.push(`Anchor hint (the figure/quote to LOCATE in the document, then quote verbatim for anchor_quote): ${anchorHint}`);
  } else if (url) {
    lines.push(`SOURCE PROVIDED (use this exact URL): ${url}`);
    if (anchorHint) lines.push(`Key ${kind === "numeric" ? "figure" : "quote"} to check for: ${anchorHint}`);
    if (kind) lines.push(`Suggested fact_kind: ${kind}${tier ? `; authority_tier: ${tier}` : ""}`);
  } else {
    lines.push("No source URL was provided - identify the single most authoritative source yourself and capture it. Do not dispatch a web search.");
  }
  lines.push("If write_ground_fact returns cited_not_verified (source dead/blocked/figure absent), report that plainly and do NOT fabricate a source.");
  // C12 (Napoleon 16918c96): FOLLOW TO CONTENT. An index/FAQ/contents/catalogue/landing page can
  // MENTION the claim while the page that STATES it sits one click deeper (origin: the Scope-3 FAQ
  // false landing). The tools detect this from the captured page's SHAPE and will demote instead of
  // anchoring; the craft is to go one level deeper yourself.
  lines.push("If write_ground_fact reports the page is INDEX/LANDING-SUSPECT (or you can see the capture is a contents/FAQ/catalogue/hub page): do NOT settle for it. Find within it the link to the page or document that actually STATES the claim (often the underlying PDF or section page), re-mint from THAT URL, and link the claim there. Never anchor to a page that merely mentions. If no deeper page exists, leave the fact in review honestly.");
  // C13 re-ground run: the claim already has a landing-page edge; the task is the DOCUMENT.
  if (hint?.reground === true) {
    lines.push("RE-GROUNDING NOTE: this claim is ALREADY linked to a fact whose source was a landing/index page (it merely MENTIONS the material). Your task is the DOCUMENT given above — the page that STATES it. Mint a NEW ground_fact from that source and link a NEW claim_on_fact edge. Do NOT modify, supersede, or delete the existing fact or edge — the comparison and any supersession happen later, by a human, once your replacement has verified better.");
  }
  lines.push("Do exactly this ONE claim. Do not ground others.");
  return lines.join("\n");
}

function excerpt(s: string): string {
  const t = (s || "").trim();
  return t.length > 300 ? t.slice(0, 300) + " ..." : t;
}

// Route newly-failed claims to Theo (decision 4) so he can re-source, reword, or drop them.
async function notifyTheo(supabase: SupabaseClient, failed: Array<{ claim_id: string; error: string }>): Promise<void> {
  const lines = failed.map((f) => `- ${f.claim_id}: ${f.error}`).join("\n");
  const note =
    `Grounding worker could not ground ${failed.length} claim(s) after max attempts (no frozen source supported them, ` +
    `or the figure was not present in the frozen source). Triage: re-source (capture a real source), reword, or drop.\n\n${lines}`;
  const { error } = await supabase.from("wake_deltas").insert({
    to_lineage: "theophrastus", from_lineage: "grounding-worker", note,
  });
  if (error) console.error("notifyTheo wake_delta insert failed:", error.message);
}
