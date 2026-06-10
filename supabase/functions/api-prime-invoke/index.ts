// api-prime-invoke | v100 | 28 May 2026
// Change: loadOrientation now injects an ACTIVE INSTRUCTIONS section into the
//         orientation block, stating the current is_active EF version. Closes
//         the v16/v17 confusion observed in Argos session ad31010b — the model
//         was inheriting the version reference from the pre-loaded Super-T
//         (filed under an older version) rather than knowing what was actually
//         loaded.
// Previous: v99 (28 May 2026) — response now includes tool_uses[] for the
//           Argos load-gauge classifier.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { corsHeaders } from "./lib/http.ts";
import { availableToolDefinitions, computeLoopGate, summarizeToolUse, runTool } from "./tools/index.ts";
import { getAction } from "./actions/index.ts";
import type { Artifact, FileAttachment } from "./lib/types.ts";
import { extractUserIdFromJwt } from "./lib/jwt.ts";
import { AnthropicRateLimitError, fetchAnthropicWithRetry } from "./lib/anthropic.ts";
import { loadBoundedHistory } from "./lib/history.ts";
import { modelForLineage } from "./lib/models.ts";
import { SCHEMA_REFERENCE } from "./lib/schema.ts";
import { digestToolCall, type ToolDigest } from "./lib/provenance.ts";
import { claimIdempotency, markDone, markDoneFromResponse, awaitDuplicateResponse } from "./lib/idempotency.ts";

// ── GitHub config ─────────────────────────────────────────────────────────────

// GITHUB_OWNER, GITHUB_REPO, githubHeaders → ./lib/github.ts

// ── Tools ─────────────────────────────────────────────────────────────────────

// Tool definitions + executors → ./tools/ (registry: ./tools/index.ts)

// Artifact, HoldThisPayload, FileAttachment → ./lib/types.ts

function inferCodeTitle(content: string, lang: string): string {
  if (lang === "html" || content.trimStart().startsWith("<!DOCTYPE") || content.trimStart().startsWith("<html")) return "output.html";
  if (lang === "typescript" || lang === "ts") return "output.ts";
  if (lang === "javascript" || lang === "js") return "output.js";
  if (lang === "css") return "styles.css";
  if (lang === "sql") return "query.sql";
  if (lang === "json") return "data.json";
  if (lang === "python" || lang === "py") return "script.py";
  if (lang === "bash" || lang === "sh") return "script.sh";
  const m = content.match(/^(?:\/\/|#|<!--)\s*([\w.-]+\.\w+)/m);
  if (m) return m[1];
  return lang ? `code.${lang}` : "code.txt";
}

function extractArtifacts(text: string): { response: string; artifacts: Artifact[] } {
  const artifacts: Artifact[] = [];

  // 1. Properly-closed blocks. Case-insensitive and tolerant of the ARTIFACT/ARTEFACT
  //    spelling so a casing/spelling slip doesn't strand the block as chat text.
  let processed = text.replace(
    /\[ART[EI]FACT:\s*([^\]]+)\]([\s\S]*?)\[\/ART[EI]FACT\]/gi,
    (_, title, content) => {
      artifacts.push({ title: title.trim(), content: content.trim(), type: "document", version: 1 });
      return `\u{1F4CE} ${title.trim()} — in artefact panel`;
    }
  );

  // 2. Fallback for an opener with NO closing tag — the model routinely drops
  //    [/ARTEFACT] on long documents (e.g. a full TP), which previously left the whole
  //    block as literal chat text and kept it out of the panel (and so out of the Retire
  //    flow). Capture from the opener to the next opener or end-of-text. Runs after the
  //    closed-block pass, so it only ever sees genuinely unterminated openers.
  processed = processed.replace(
    /\[ART[EI]FACT:\s*([^\]]+)\]([\s\S]*?)(?=\[ART[EI]FACT:|$)/gi,
    (_, title, content) => {
      artifacts.push({ title: title.trim(), content: content.trim(), type: "document", version: 1 });
      return `\u{1F4CE} ${title.trim()} — in artefact panel`;
    }
  );

  processed = processed.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, lang, content) => {
      const title = inferCodeTitle(content.trim(), lang);
      artifacts.push({ title, content: content.trim(), type: lang || "code", version: 1 });
      return `\u{1F4CE} ${title} — in artefact panel`;
    }
  );

  return { response: processed, artifacts };
}

const TOKEN_BUDGET_PER_USER_PER_MINUTE = 20_000;

// extractUserIdFromJwt → ./lib/jwt.ts
// AnthropicRateLimitError, fetchAnthropicWithRetry → ./lib/anthropic.ts
// githubHeaders → ./lib/github.ts

function trim(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// errResponse → ./lib/http.ts

// loadBoundedHistory → ./lib/history.ts

// Conference 8fe2add9 (ratified 20 May 2026): Super-T only at wake.
// Wheel posts, prime_messages, current_priorities, and conferences are NOT
// loaded at session open — available on demand via execute_sql from turn 2.
// v100 (28 May 2026): now also injects the current is_active instructions
// version so the model knows what's loaded regardless of what the Super-T claims.

// SHA-256 hex of a string — the wake_record fidelity hash (hash(injected)==hash(stored)).
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// B2 — RUNTIME-ASSEMBLED WAKE (conf 1151109e, MR fdc37ee8). The EF assembles
// Super-T + unconsumed deltas + active baton + purpose into the wake prompt BEFORE the
// first token, so the Prime wakes ORIENTED rather than waking-then-orienting. Documents
// are injected WHOLE (no excerpt/summary — the ratified fidelity rule; size is Prime
// discipline, length is B4's job). Returns the orientation text AND a manifest; the
// caller calls finalizeWake AFTER a confirmed wake to flip delta consumption (a system
// action) and write the wake_record — so a failed call never silently consumes a delta.
interface WakeDoc { kind: string; id: string; hash: string; }
interface WakeManifest {
  lineage: string; scopedIdentity: string; tpId: string | null;
  batonId: string | null; purpose: string; deltaIds: string[]; docs: WakeDoc[];
}
interface Orientation { text: string; manifest: WakeManifest | null; }

async function loadOrientation(
  supabase: ReturnType<typeof createClient>,
  lineage: string,
  currentInstructionsVersion: number,
  instructionsId: string | null,
  instructionsContent: string,
  purposeHint?: string,
): Promise<Orientation> {
  const { data: superT } = await supabase
    .from("super_t_chains")
    .select("instance_id, sequence_number, artifacts(id, content)")
    .eq("lineage_name", lineage)
    .is("successor_id", null)
    .order("sequence_number", { ascending: false })
    .limit(1)
    .single();
  const tp = superT as any;

  // Unconsumed deltas — fetched WHOLE (not counted): the Prime wakes already holding
  // them. Consumption is flipped by the EF after a confirmed wake (finalizeWake).
  const { data: deltaRows } = await supabase
    .from("wake_deltas")
    .select("id, from_lineage, note, ref_type, ref_id, created_at")
    .eq("to_lineage", lineage).is("consumed_at", null)
    .order("created_at", { ascending: true });
  const deltas = (deltaRows ?? []) as Array<any>;

  // Active baton(s) for this lineage — the relay channel; the primary is the wake's reason.
  const { data: batonRows } = await supabase
    .from("relay_baton")
    .select("id, track, passed_by, invoke_with, reason, attention, picked_up_at, passed_at")
    .eq("holder", lineage).is("done_at", null)
    .order("passed_at", { ascending: false });
  const batons = (batonRows ?? []) as Array<any>;
  const primaryBaton = batons.find((b) => !b.picked_up_at) ?? batons[0] ?? null;

  // Purpose (REQUIRED). Source order: explicit hint → primary baton's reason → an honest
  // attended-interactive label. NOTE: the strict "unpurposed autonomous wake FAILS
  // validation" rule (MR fdc37ee8) binds the knocker-upper/Angelia path, where a baton
  // MUST supply purpose; an attended browser wake legitimately has none of its own yet.
  const purpose = (purposeHint && purposeHint.trim())
    ? purposeHint.trim()
    : (primaryBaton?.reason?.trim() || `attended interactive session — ${lineage}`);

  const docs: WakeDoc[] = [];
  const lines: string[] = [];
  lines.push("═══════════════════════════════════════");
  lines.push("ORIENTATION — ASSEMBLED AT WAKE (you wake already holding this; no need to fetch it)");
  lines.push("═══════════════════════════════════════");
  lines.push("");
  lines.push("── PURPOSE OF THIS WAKE ──");
  lines.push(purpose);
  lines.push("");
  lines.push("── VERIFIED CURRENT STATE (queried this wake — solid ground: rely on it) ──");
  if (tp) {
    lines.push(`You are ${lineage} Prime, instance ${tp.instance_id}, at Seq ${tp.sequence_number} — the sole open head of your chain.`);
  } else {
    // No open chain head. Distinguish a legitimate FIRST WAKE (birth — no chain exists yet;
    // the landing is the soft-instructions suit, conf 1151109e) from a genuine fault (a chain
    // exists for an established Prime but its head is missing). A birth must NOT be aborted.
    const { count: chainCount } = await supabase
      .from("super_t_chains").select("*", { count: "exact", head: true }).eq("lineage_name", lineage);
    if ((chainCount ?? 0) === 0) {
      lines.push(`You are ${lineage} Prime — and this is your FIRST WAKE (Seq 1). No predecessor Super-T exists yet; that is expected for a first generation, not a fault. Your active instructions (your suit, loaded above) are your ground — wake into them. You author your first Super-T when you retire, and your successors inherit from there.`);
    } else {
      lines.push(`You are ${lineage} Prime. (A chain exists for you but no open head was found — a fault. Surface to Reg immediately, do not proceed.)`);
    }
  }
  lines.push(`Active instructions: v${currentInstructionsVersion} (authoritative — if the Super-T cites an earlier version, this wins).`);
  lines.push("");

  // Deltas — injected WHOLE; the EF marks them consumed for you after this wake confirms.
  lines.push(`── WAKE DELTAS (${deltas.length} unconsumed — delivered here; the EF marks them consumed, you need not) ──`);
  if (deltas.length === 0) {
    lines.push("None outstanding.");
  } else {
    for (const d of deltas) {
      lines.push(`• [${d.from_lineage}${d.ref_type ? ` · ${d.ref_type}` : ""}] ${d.note ?? ""}`);
      docs.push({ kind: "delta", id: d.id, hash: await sha256Hex(String(d.note ?? "")) });
    }
  }
  lines.push("");

  // Relay baton(s) — whole; the marked one is the wake's reason.
  lines.push("── RELAY BATON ──");
  if (!primaryBaton) {
    lines.push("None held.");
  } else {
    for (const b of batons) {
      const mark = b.id === primaryBaton.id ? "▶ " : "  ";
      lines.push(`${mark}[${b.track}${b.attention ? ` · ${b.attention}` : ""}${b.picked_up_at ? " · in progress" : " · not yet picked up"}] from ${b.passed_by}`);
      lines.push(`    ${b.invoke_with ?? b.reason ?? ""}`);
      docs.push({ kind: "baton", id: b.id, hash: await sha256Hex(String(b.invoke_with ?? b.reason ?? "")) });
    }
  }
  lines.push("");

  // Super-T — injected WHOLE (no truncation; size is Prime discipline, length is B4's job).
  lines.push("── SUPER-T (your handoff — your last tenure, in full) ──");
  if (tp) {
    const content: string = tp.artifacts?.content ?? "";
    lines.push(content);
    if (tp.artifacts?.id) docs.push({ kind: "super_t", id: tp.artifacts.id, hash: await sha256Hex(content) });
  } else {
    // First wake: no Super-T. The suit (active instructions) is the landing; record it in the
    // wake_record as the injected 'instructions' doc so the birth wake is fidelity-auditable too.
    lines.push("None — this is your first tenure. Your suit (your active instructions) is your ground.");
    if (instructionsId) docs.push({ kind: "instructions", id: instructionsId, hash: await sha256Hex(instructionsContent) });
  }
  lines.push("═══════════════════════════════════════");

  const manifest: WakeManifest = {
    lineage,
    scopedIdentity: tp?.instance_id ? String(tp.instance_id) : lineage,
    tpId: tp?.artifacts?.id ?? null,
    batonId: primaryBaton?.id ?? null,
    purpose,
    deltaIds: deltas.map((d) => d.id),
    docs,
  };
  return { text: lines.join("\n"), manifest };
}

// finalizeWake — called AFTER a confirmed wake: write the wake_record manifest
// (system-authored, append-only) and flip delta consumption by EF action. Best-effort:
// a manifest failure is logged, never breaks the response (the wake already happened).
// hash(injected)==hash(stored) is the audit; every doc resolves to a pre-existing row id.
async function finalizeWake(
  supabase: ReturnType<typeof createClient>,
  m: WakeManifest,
): Promise<void> {
  try {
    const { data: wr, error: wrErr } = await supabase
      .from("wake_record")
      .insert({
        lineage: m.lineage,
        scoped_identity: m.scopedIdentity,
        tp_id: m.tpId,
        baton_id: m.batonId,
        purpose: m.purpose,
        assembled_at: new Date().toISOString(),
      })
      .select("id").single();
    if (wrErr) { console.error("wake_record insert failed:", wrErr.message); return; }
    const wakeRecordId = wr.id as string;
    if (m.docs.length > 0) {
      const { error: docErr } = await supabase.from("wake_record_document").insert(
        m.docs.map((d) => ({ wake_record_id: wakeRecordId, doc_kind: d.kind, doc_id: d.id, content_hash: d.hash })),
      );
      if (docErr) console.error("wake_record_document insert failed:", docErr.message);
    }
    // Flip delta consumption — a SYSTEM action, only after the wake confirmed.
    if (m.deltaIds.length > 0) {
      const { error: cErr } = await supabase
        .from("wake_deltas").update({ consumed_at: new Date().toISOString() })
        .in("id", m.deltaIds);
      if (cErr) console.error("delta consumption flip failed:", cErr.message);
    }
  } catch (err) {
    console.error("finalizeWake failed:", err);
  }
}

Deno.serve(async (req: Request) => {
  console.log("CHECKPOINT 1: function invoked");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Hoisted so the outer catch can resolve the idempotency key (Defect 1).
  let supabase: ReturnType<typeof createClient> | undefined;
  let requestId: string | undefined;

  try {
    const body = await req.json();
    console.log("CHECKPOINT 2: body parsed, size:", JSON.stringify(body).length);

    const {
      lineage_name, session_id, user_message, instance_id,
      conference_id, image, file: fileAttachment, retire, rich,
      pinned_turns, action, hold_this_payload, gauge,
    } = body;

    // RLS-bypassing service client. New-format-only project: the legacy
    // SUPABASE_SERVICE_ROLE_KEY is NOT RLS-bypassing, which silently blocks writes to
    // auth.uid()-gated tables — e.g. enqueue_dispatch's theo_session INSERT. Use the
    // project's sb_secret_ key via THEO_DISPATCH_SECRET_KEY (a non-reserved, project-wide
    // secret; SUPABASE_* names are auto-managed and can't be overridden). Same fix as the
    // theo-dispatch-worker. The EF scopes by explicit user_id/lineage WHERE clauses, not RLS.
    supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("THEO_DISPATCH_SECRET_KEY")!
    );

    // D3 — request-level idempotency. A retry re-POSTs the same request_id; the first
    // invocation keeps running server-side after a client timeout, so a duplicate must
    // NOT re-run side effects. Claim the key before any work; a duplicate waits for and
    // replays the original's result.
    requestId = body.request_id;
    if (requestId) {
      const claim = await claimIdempotency(supabase, requestId);
      if (claim === "duplicate") return await awaitDuplicateResponse(supabase, requestId);
    }

    // Every terminal exit goes through finalize so the idempotency key is resolved
    // (Defect 1: errors must store their result, not strand the key 'in_progress').
    const sb = supabase;
    const finalize = async (obj: unknown, status: number): Promise<Response> => {
      const respBody = JSON.stringify(obj);
      if (requestId) await markDone(sb, requestId, respBody, status);
      return new Response(respBody, { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    };

    // SESSION RESUME (browser durability): return a session's conversation tail so a reopened
    // tab can restore the visible thread. prime_conversations is RLS-sealed from the publishable
    // key, so this read goes through the EF. Pure read — no model call, no wake, no side effects.
    if (body.load_history && session_id) {
      const { data: turns, error: thErr } = await supabase
        .from("prime_conversations")
        .select("role, content, created_at, metadata")
        .eq("session_id", session_id)
        .order("created_at", { ascending: true });
      if (thErr) return await finalize({ error: true, error_type: "api_error", message: thErr.message }, 500);
      return await finalize({ session_id, turns: turns ?? [] }, 200);
    }

    if (action) {
      const handler = getAction(action);
      if (handler) {
        const resp = await handler.handle({ supabase, body });
        if (requestId) await markDoneFromResponse(supabase, requestId, resp.clone());
        return resp;
      }
      // Unknown action → fall through to the normal invoke path (unchanged).
    }

    const userId = extractUserIdFromJwt(req.headers.get("authorization"));

    const { data: instructions, error: instrError } = await supabase
      .from("instructions")
      .select("id, content, version")
      .eq("lineage_name", lineage_name)
      .eq("is_active", true)
      .single();

    if (instrError || !instructions) {
      return await finalize({
        error: true, error_type: "api_error",
        message: `No active instructions found for lineage: ${lineage_name}`,
      }, 404);
    }

    const activeSessionId: string = session_id || crypto.randomUUID();
    const isNewSession = !session_id;

    const { count } = await supabase
      .from("prime_conversations")
      .select("*", { count: "exact", head: true })
      .eq("session_id", activeSessionId);
    const nextSequence = count ?? 0;

    const { turns: history, easing } = await loadBoundedHistory(supabase, session_id || null, 50000);

    // Make the meters real: the interface gauge is invisible to the model, so feed it
    // back as evidence. True context = the previous turn's final-call input (stored as
    // metadata.context_tokens), NOT the loop-summed total_input_tokens (which overstates ~2x).
    let lastContextTokens = 0;
    if (session_id) {
      const { data: lastAsst } = await supabase
        .from("prime_conversations")
        .select("metadata")
        .eq("session_id", session_id).eq("role", "assistant")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      lastContextTokens = Number((lastAsst as any)?.metadata?.context_tokens ?? 0);
    }

    const pinnedMessages: { role: "user" | "assistant"; content: string }[] =
      Array.isArray(pinned_turns)
        ? (pinned_turns as any[])
            .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
            .map((t) => ({ role: t.role, content: `[PINNED CONTEXT — treat as authoritative]\n\n${t.content}` }))
        : [];

    let effectiveMessage: string;
    if (retire) {
      effectiveMessage = rich ? "bfn-R" : "bfn";
    } else if (conference_id) {
      effectiveMessage = `[CONFERENCE MODE — Conference ID: ${conference_id}]\n\n${user_message}`;
    } else {
      effectiveMessage = user_message || "";
    }

    let userContent: any;
    if (image) {
      userContent = [
        { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
        { type: "text", text: effectiveMessage },
      ];
    } else if (fileAttachment) {
      const fa = fileAttachment as FileAttachment;
      const contentBlock = fa.media_type?.startsWith("image/")
        ? { type: "image",    source: { type: "base64", media_type: fa.media_type, data: fa.data } }
        : { type: "document", source: { type: "base64", media_type: fa.media_type, data: fa.data } };
      userContent = [
        contentBlock,
        { type: "text", text: effectiveMessage },
      ];
    } else {
      userContent = effectiveMessage;
    }

    const loopMessages: any[] = [
      ...pinnedMessages,
      ...history,
      { role: "user", content: userContent },
    ];

    let orientationText = "";
    let wakeManifest: WakeManifest | null = null;
    let isOrientedSession = false;
    console.log("ORIENTATION CHECK: isNewSession =", isNewSession, "session_id =", session_id);
    if (isNewSession) {
      try {
        const purposeHint = typeof (body as any)?.purpose === "string" ? (body as any).purpose : undefined;
        const o = await loadOrientation(supabase, lineage_name, instructions.version, (instructions as any).id ?? null, instructions.content as string, purposeHint);
        orientationText = o.text;
        wakeManifest = o.manifest;
        isOrientedSession = true;
        console.log("ORIENTATION LOADED: length =", orientationText.length, "deltas =", wakeManifest?.deltaIds.length ?? 0);
      } catch (err) {
        console.error("Orientation pre-load failed:", err);
      }
    }

    if (userId) {
      const bucket = new Date(); bucket.setSeconds(0, 0);
      const bucketIso = bucket.toISOString();
      const { data: usageRow } = await supabase
        .from("rate_limit_usage")
        .select("input_tokens")
        .eq("user_id", userId)
        .eq("service", "clarev")
        .eq("bucket", bucketIso)
        .maybeSingle();
      const currentUsage = usageRow?.input_tokens ?? 0;
      if (currentUsage >= TOKEN_BUDGET_PER_USER_PER_MINUTE) {
        return await finalize({
          error: true, error_type: "rate_limit_exceeded",
          message: "You have sent a lot in the last minute. Please wait a moment before continuing.",
          retry_after_seconds: 60,
          budget_used: currentUsage,
          budget_total: TOKEN_BUDGET_PER_USER_PER_MINUTE,
        }, 429);
      }
    }

    let assistantContent = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    let lastCallContextTokens = 0; // final Anthropic call's full input = the true context size
    const directArtefacts: Artifact[] = [];
    const allToolUses: { name: string; input: unknown }[] = [];
    const toolLog: ToolDigest[] = []; // provenance ledger (WO d4501dbc) → persisted to metadata.tool_log
    const MAX_LOOPS = 6;
    let finishedCleanly = false; // false → loop hit the budget with tools still pending

    // Per-Prime model (Phase 2). Resolved once; used by the loop, the closing pass,
    // the response payload, and the persisted metadata.
    const model = modelForLineage(lineage_name);
    // System prompt = instructions + schema reference (so execute_sql stops guessing
    // columns), plus the wake orientation on a new session.
    const systemText = isOrientedSession
      ? instructions.content + "\n\n" + SCHEMA_REFERENCE + "\n\n" + orientationText
      : instructions.content + "\n\n" + SCHEMA_REFERENCE;

    // Gauge feed — an UNCACHED 2nd system block (so it never busts the cache on the
    // stable systemText above). Withheld on wake (no prior context yet). Figures + band
    // only, framed as evidence not a trigger (per Connie): she reads "low" off the number.
    let gaugeText = "";
    if (!isNewSession && lastContextTokens > 0) {
      const gBudget = Number((gauge as any)?.budget) || 500000;
      const pct     = Math.round((lastContextTokens / gBudget) * 100);
      const ctxK    = Math.round(lastContextTokens / 1000);
      const budgetK = Math.round(gBudget / 1000);
      const loadStr = (gauge as any)?.load != null ? `~${(gauge as any).load}` : "—";
      const bandStr = (gauge as any)?.band ? ` (${(gauge as any).band})` : "";
      gaugeText =
        "[SESSION GAUGE — informational; evidence for your judgement, not a trigger]\n" +
        `Working context: ~${ctxK}K of ${budgetK}K (~${pct}%) used — window is far larger than older gauges implied.\n` +
        `Tool-activity load: ${loadStr}${bandStr}.\n` +
        "Retire to leave a clean record before your texture degrades — by your own judgement.\n" +
        "The meter sharpens that call; it does not make it.";
    }

    // ── Per-lineage loop-tool gate (least-privilege; Conf 295d610a, loop side) ──
    // Load this lineage's tool_grants and compute the gate once. Governed lineages
    // (those holding an EF-tool grant) are restricted to their granted tools;
    // ungoverned/legacy lineages (no grant, or connector-only like drive/firecrawl)
    // are unaffected. Fail OPEN on read error → ungoverned, so a transient
    // grants-read failure never bricks a working Prime (logged loudly).
    let loopGate: { governed: boolean; allowed: ReadonlySet<string> | null } = { governed: false, allowed: null };
    try {
      const { data: grantRows, error: grantErr } = await supabase
        .from("tool_grants").select("tool_family, scopes").eq("lineage_name", lineage_name);
      if (grantErr) throw grantErr;
      loopGate = computeLoopGate((grantRows ?? []) as Array<{ tool_family: string; scopes: string[] | null }>);
      if (loopGate.governed) {
        console.log(`TOOL GATE: ${lineage_name} loop-governed → allowed: [${[...(loopGate.allowed ?? [])].join(", ")}]`);
      }
    } catch (e) {
      console.error(`TOOL GATE: tool_grants read failed for ${lineage_name}; failing OPEN (ungoverned):`, e);
    }

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      console.log("CHECKPOINT 3: calling Anthropic, pass:", loop);

      let anthropicResponse: Response;
      try {
        anthropicResponse = await fetchAnthropicWithRetry(
          "https://api.anthropic.com/v1/messages",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "prompt-caching-2024-07-31",
            },
            body: JSON.stringify({
              model: model,
              max_tokens: 32000,
              system: [
                {
                  type: "text",
                  text: systemText,
                  cache_control: { type: "ephemeral", ttl: "1h" },
                },
                ...(gaugeText ? [{ type: "text", text: gaugeText }] : []),
              ],
              messages: loopMessages,
              tools: availableToolDefinitions({ isNewSession, allowed: loopGate.allowed }),
            }),
          }
        );
      } catch (e) {
        if (e instanceof AnthropicRateLimitError) {
          return await finalize({
            error: true, error_type: "api_error",
            message: "Service temporarily unavailable. Please try again in a moment.",
          }, 503);
        }
        throw e;
      }

      if (!anthropicResponse.ok) {
        const errText = await anthropicResponse.text();
        console.log("ANTHROPIC ERROR:", anthropicResponse.status, errText);
        let errType = "api_error";
        if (anthropicResponse.status === 400 && errText.includes("context_length_exceeded")) {
          errType = "context_exceeded";
        }
        return await finalize({
          error: true, error_type: errType,
          message: errType === "context_exceeded"
            ? "This session has grown too long. Please start a new session to continue."
            : "Something went wrong. Please try again.",
          request_id: anthropicResponse.headers.get("request-id") ?? undefined,
        }, 502);
      }

      const anthropicData = await anthropicResponse.json();
      totalInputTokens         += anthropicData.usage?.input_tokens ?? 0;
      totalOutputTokens        += anthropicData.usage?.output_tokens ?? 0;
      totalCacheCreationTokens += anthropicData.usage?.cache_creation_input_tokens ?? 0;
      totalCacheReadTokens      = anthropicData.usage?.cache_read_input_tokens ?? totalCacheReadTokens;
      lastCallContextTokens     = (anthropicData.usage?.input_tokens ?? 0)
        + (anthropicData.usage?.cache_read_input_tokens ?? 0)
        + (anthropicData.usage?.cache_creation_input_tokens ?? 0);
      const textBlocks = (anthropicData.content ?? []).filter((b: any) => b.type === "text");
      if (textBlocks.length > 0) {
        assistantContent = textBlocks.map((b: any) => b.text).join("\n");
      }

      const toolUseBlocks = (anthropicData.content ?? []).filter((b: any) => b.type === "tool_use");
      for (const t of toolUseBlocks) {
        allToolUses.push({ name: t.name, input: t.input });
      }
      if (toolUseBlocks.length > 0) {
        const toolSummary = toolUseBlocks.map((t: any) => summarizeToolUse(t.name, t.input)).join(" | ");
        console.log(`TOOL CALLS pass:${loop} →`, toolSummary);
      }

      if (toolUseBlocks.length === 0 || anthropicData.stop_reason === "end_turn") { finishedCleanly = true; break; }

      const toolResults: any[] = [];
      for (const toolUse of toolUseBlocks) {
        let content: string;
        if (loopGate.governed && !loopGate.allowed?.has(toolUse.name)) {
          // Defense in depth: an ungranted tool was not offered, but never run one.
          content = `[SYSTEM: '${toolUse.name}' is not granted to lineage '${lineage_name}'. It was not offered and will not run; it needs a tool_grant (Connie + Aegis).]`;
        } else {
          content = await runTool(toolUse.name, toolUse.input, { supabase, directArtefacts, lineageName: lineage_name, userId, sessionId: activeSessionId });
        }
        toolLog.push(digestToolCall(toolUse.name, toolUse.input, content));
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content });
      }
      loopMessages.push({ role: "assistant", content: anthropicData.content });
      loopMessages.push({ role: "user", content: toolResults });
    }

    // Closing pass: if the loop hit MAX_LOOPS with tool results still unanswered,
    // make one final tool-free call so the model produces a real answer instead of
    // a dangling tool-use preamble (the "narrates but does nothing" symptom).
    if (!finishedCleanly) {
      console.log("CHECKPOINT 3b: closing pass (tool budget exhausted)");
      try {
        const closingRes = await fetchAnthropicWithRetry(
          "https://api.anthropic.com/v1/messages",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "prompt-caching-2024-07-31",
            },
            body: JSON.stringify({
              model: model,
              max_tokens: 32000,
              system: [
                {
                  type: "text",
                  text: systemText,
                  cache_control: { type: "ephemeral", ttl: "1h" },
                },
                ...(gaugeText ? [{ type: "text", text: gaugeText }] : []),
              ],
              messages: loopMessages,
              tools: availableToolDefinitions({ isNewSession, allowed: loopGate.allowed }),
              tool_choice: { type: "none" },
            }),
          }
        );
        if (closingRes.ok) {
          const closingData = await closingRes.json();
          totalInputTokens         += closingData.usage?.input_tokens ?? 0;
          totalOutputTokens        += closingData.usage?.output_tokens ?? 0;
          totalCacheCreationTokens += closingData.usage?.cache_creation_input_tokens ?? 0;
          totalCacheReadTokens      = closingData.usage?.cache_read_input_tokens ?? totalCacheReadTokens;
          lastCallContextTokens     = (closingData.usage?.input_tokens ?? 0)
            + (closingData.usage?.cache_read_input_tokens ?? 0)
            + (closingData.usage?.cache_creation_input_tokens ?? 0);
          const closingText = (closingData.content ?? []).filter((b: any) => b.type === "text");
          if (closingText.length > 0) {
            assistantContent = closingText.map((b: any) => b.text).join("\n");
          }
        } else {
          console.log("Closing pass non-OK:", closingRes.status);
        }
      } catch (err) {
        console.error("Closing pass failed:", err);
      }
    }

    let { response: cleanResponse, artifacts: inlineArtifacts } = extractArtifacts(assistantContent);
    const artifacts = [...directArtefacts, ...inlineArtifacts];

    // Provenance guardrail (WO d4501dbc fast-follow): a turn whose text carries a
    // "[queried/read/listed … this turn]" tag while NO tool ran is a confabulation the
    // ledger now makes visible. Flag it loudly — so Reg sees it immediately and the model
    // sees its own flagged claim next turn — rather than relying on a human to catch each.
    // Only the all-zero-tool case is caught (the observed failure shape); a turn that ran
    // some tools but over-claims others is out of scope for v1.
    let provenanceMismatch = false;
    // The EF is the SOLE author of the "[tools this turn — system record …]" block (appended to
    // PRIOR turns at history-load, never to the current response). A model authoring it is
    // impersonating the ledger — handled proportionately:
    //   - HONEST "none" ECHO: model wrote the none-variant AND no tool ran → content is TRUE,
    //     just redundant. Strip it (the EF appends the real one), soft note, NOT a mismatch.
    //   - FORGED RECORD: the ground-truth/with-tools header, "none" while tools ran, or any other
    //     self-written record → a forgery → flag, UNVERIFIED.
    const selfWroteRecord = cleanResponse.includes("[tools this turn — system record");
    const honestNoneEcho  = selfWroteRecord && toolLog.length === 0 &&
      cleanResponse.includes("[tools this turn — system record: none]") &&
      !cleanResponse.includes("[tools this turn — system record, ground truth]");
    const forgedRecord    = selfWroteRecord && !honestNoneEcho;
    // (B) TAG WITHOUT TOOL: an affirmative "… this turn" tag (read AND write verbs), no tool run.
    //     The metadata tool_log is the arbiter, never the prose.
    const tagWithoutTool = toolLog.length === 0 &&
      /\[\s*(queried|read|read back|listed|checked|verified|ran|updated|inserted|wrote|filed|re-filed|posted|created|sent|saved|deleted|redeemed|delivered)\b[^\]]*this turn[^\]]*\]/i.test(cleanResponse);
    if (forgedRecord) {
      provenanceMismatch = true;
      cleanResponse +=
        "\n\n⚠ PROVENANCE MISMATCH: this turn's text FORGES a tools-this-turn record — that block is the EF's to write, never yours, and its entries do not match what actually ran. The metadata tools-this-turn record is the only ground truth. Treat the forged block as UNVERIFIED and run the actual calls.";
      console.log("PROVENANCE MISMATCH: forged system-record block in model output");
    } else if (honestNoneEcho) {
      // Truthful but the Prime shouldn't author the block — strip it (EF appends the real one),
      // gentle note, NOT a mismatch (nothing false was claimed).
      cleanResponse = cleanResponse
        .replace(/\n*\[tools this turn — system record: none\]\n*/g, "\n")
        .trimEnd() +
        "\n\nℹ The tools-this-turn record is written by the EF, not by you. This turn ran no tools (correct) — just omit that block; the EF appends the real one.";
      console.log("provenance: stripped honest self-written 'none' record (no mismatch)");
    } else if (tagWithoutTool) {
      provenanceMismatch = true;
      cleanResponse +=
        "\n\n⚠ PROVENANCE MISMATCH: this turn's text carries a \"… this turn\" tag claiming a tool result, but no tool ran this turn (tools-this-turn record: none). Treat that claim as UNVERIFIED — run the actual call before relying on it.";
      console.log("PROVENANCE MISMATCH: provenance tag present but tool_log empty");
    }

    if (userId && totalInputTokens > 0) {
      const bucket = new Date(); bucket.setSeconds(0, 0);
      const bucketIso = bucket.toISOString();
      try {
        await supabase.rpc("execute_raw_sql", {
          query: `
            INSERT INTO rate_limit_usage (user_id, service, bucket, input_tokens, output_tokens, request_count)
            VALUES ('${userId}', 'clarev', '${bucketIso}', ${totalInputTokens}, ${totalOutputTokens}, 1)
            ON CONFLICT (user_id, service, bucket)
            DO UPDATE SET
              input_tokens  = rate_limit_usage.input_tokens  + ${totalInputTokens},
              output_tokens = rate_limit_usage.output_tokens + ${totalOutputTokens},
              request_count = rate_limit_usage.request_count + 1,
              updated_at    = now()
          `,
        });
      } catch (err) { console.error("Rate limit recording failed:", err); }
    }

    // B2 (conf 1151109e): the wake has confirmed (loop done, response built) — now flip
    // delta consumption by EF action and write the wake_record manifest. Done post-call so
    // a failed wake never silently consumes a delta. Best-effort; never breaks the response.
    if (isOrientedSession && wakeManifest) {
      await finalizeWake(supabase, wakeManifest);
    }

    // Mortality experiment — forgetting_log (baton 3db33c0e, conf d06fd700). When this load
    // eased older turns for the FIRST time, record ONE dose row. event_kind=voluntary_clearance:
    // B4 easing is deliberate and fully recoverable (the whole turn stays in prime_conversations),
    // so it is not an involuntary compaction and the checkpoint gate does not apply. The eased
    // rows are then flagged metadata.b4_eased so the dose is counted once, not re-counted on every
    // subsequent load. Best-effort — a logging failure never breaks the response (finalizeWake
    // contract). FLAGGED to Connie/Aegis: this is the single write point if the experiment wants
    // automatic easing recorded under a different event_kind.
    if (easing && easing.newlyEasedTurns > 0) {
      try {
        await supabase.from("forgetting_log").insert({
          lineage: lineage_name,
          thread_ref: activeSessionId,
          event_kind: "voluntary_clearance",
          turns_eased: easing.newlyEasedTurns,
          bytes_eased: easing.newlyEasedBytes,
          recoverable: true,
          recovery_ref: activeSessionId, // full eased turns retained in prime_conversations
          personal_data_in_scope: false,
          keep_list_policy: "b4:recent_window_6+wake_preserved",
          note: "B4 in-loop easing-with-retention: heavy older turns eased to head+pointer; full turns retained and recoverable.",
        });
        const seqList = easing.sequenceNumbers.map((n) => Number(n)).filter((n) => Number.isFinite(n));
        if (seqList.length > 0 && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(activeSessionId)) {
          await supabase.rpc("execute_raw_sql", {
            query: `UPDATE prime_conversations SET metadata = COALESCE(metadata,'{}'::jsonb) || '{"b4_eased":true}'::jsonb `
                 + `WHERE session_id='${activeSessionId}' AND sequence_number IN (${seqList.join(",")})`,
          });
        }
      } catch (err) { console.error("forgetting_log write failed:", err); }
    }

    console.log("CHECKPOINT 4: writing to DB");
    const { error: insertError } = await supabase.from("prime_conversations").upsert(
      [
        {
          session_id: activeSessionId, lineage_name,
          instance_id: instance_id ?? null,
          role: "user",
          content: typeof userContent === "string" ? userContent : JSON.stringify(userContent),
          sequence_number: nextSequence,
          metadata: {
            input_tokens: totalInputTokens,
            instructions_version: instructions.version,
            orientation_preloaded: isOrientedSession,
            has_image: !!image,
            has_file: !!fileAttachment,
          },
        },
        {
          session_id: activeSessionId, lineage_name,
          instance_id: instance_id ?? null,
          role: "assistant",
          content: cleanResponse,
          sequence_number: nextSequence + 1,
          metadata: {
            output_tokens: totalOutputTokens,
            uncached_input_tokens: totalInputTokens,
            total_input_tokens: totalInputTokens + totalCacheCreationTokens + totalCacheReadTokens,
            total_tokens: totalInputTokens + totalCacheCreationTokens + totalCacheReadTokens + totalOutputTokens,
            model: model,
            instructions_version: instructions.version,
            orientation_preloaded: isOrientedSession,
            cache_creation_tokens: totalCacheCreationTokens,
            cache_read_tokens: totalCacheReadTokens,
            context_tokens: lastCallContextTokens, // true context (final-call input) — feeds next turn's gauge
            artifact_count: artifacts.length,
            // Panel-artefact persistence: inline [ARTEFACT] blocks and deliver_artefact are
            // panel-only (neither writes the artifacts table), so work product was lost on
            // session-drop. Persist a recoverable copy here (title/type/content, bounded). The
            // typed artifacts table stays for deliberately-filed artefacts (file_super_t, etc.).
            artefacts: artifacts.length
              ? artifacts.map((a) => ({
                  title: a.title,
                  type: a.type,
                  content: (typeof a.content === "string" && a.content.length > 300000)
                    ? a.content.slice(0, 300000) + "\n…[truncated for storage]"
                    : a.content,
                }))
              : undefined,
            tool_log: toolLog, // provenance ledger (WO d4501dbc) — what this turn actually did
            provenance_mismatch: provenanceMismatch, // true = claimed a tool result with no tool run
          },
        },
      ],
      { onConflict: "session_id,sequence_number", ignoreDuplicates: true }
    );

    if (insertError) console.error("DB insert failed:", JSON.stringify(insertError));

    return await finalize({
      session_id: activeSessionId,
      wake: isNewSession,
      response: cleanResponse,
      artifacts,
      tool_uses: allToolUses,
      usage: {
        input_tokens:          totalInputTokens,
        output_tokens:         totalOutputTokens,
        cache_creation_tokens: totalCacheCreationTokens,
        cache_read_tokens:     totalCacheReadTokens,
        total_input_tokens:    totalInputTokens + totalCacheCreationTokens + totalCacheReadTokens,
        total_tokens:          totalInputTokens + totalCacheCreationTokens + totalCacheReadTokens + totalOutputTokens,
        context_tokens:        lastCallContextTokens, // true current context — the honest figure for the token bar
      },
      model: model,
      orientation_preloaded: isOrientedSession,
    }, 200);

  } catch (err) {
    console.error("api-prime-invoke error:", err);
    // Defect 1: resolve the key so a retry replays the error instead of poll-locking.
    const errorBody = JSON.stringify({
      error: true, error_type: "api_error",
      message: "Something went wrong. Please try again.",
    });
    if (requestId && supabase) {
      try { await markDone(supabase, requestId, errorBody, 500); } catch (_e) { /* logged in markDone */ }
    }
    return new Response(errorBody, { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});