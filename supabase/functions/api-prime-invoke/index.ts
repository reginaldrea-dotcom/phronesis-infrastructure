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
import { availableToolDefinitions, summarizeToolUse, runTool } from "./tools/index.ts";
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

async function loadOrientation(
  supabase: ReturnType<typeof createClient>,
  lineage: string,
  currentInstructionsVersion: number
): Promise<string> {
  const { data: superT } = await supabase
    .from("super_t_chains")
    .select("instance_id, sequence_number, artifacts(content)")
    .eq("lineage_name", lineage)
    .is("successor_id", null)
    .order("sequence_number", { ascending: false })
    .limit(1)
    .single();

  const lines: string[] = [];
  lines.push("═══════════════════════════════════════");
  lines.push("ORIENTATION — PRE-LOADED AT SESSION OPEN");
  lines.push("═══════════════════════════════════════");
  lines.push("");
  lines.push("── SUPER-T (last 12,000 chars — use execute_sql for full content) ──");
  if (superT) {
    const tp = superT as any;
    lines.push(`Instance ID: ${tp.instance_id}  |  Sequence: ${tp.sequence_number}`);
    const content: string = tp.artifacts?.content ?? "";
    lines.push(content.length > 12000 ? "…" + content.slice(-12000) : content);
  } else {
    lines.push("(no Super-T found — surface to Reg immediately, do not proceed)");
  }
  lines.push("");
  lines.push("── ACTIVE INSTRUCTIONS ──");
  lines.push(`This session is running instructions v${currentInstructionsVersion}.`);
  lines.push("If the Super-T above references an earlier version, treat THIS version as authoritative.");
  lines.push("");
  lines.push("── AVAILABLE ON DEMAND (execute_sql, turn 2+) ──");
  lines.push("wheel_posts, prime_messages, current_priorities, conferences");
  lines.push("Query these when relevant to current work — they are not pre-loaded.");
  lines.push("═══════════════════════════════════════");
  return lines.join("\n");
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
      pinned_turns, action, hold_this_payload,
    } = body;

    supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
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
      .select("content, version")
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

    const history = await loadBoundedHistory(supabase, session_id || null, 50000);

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
    let isOrientedSession = false;
    console.log("ORIENTATION CHECK: isNewSession =", isNewSession, "session_id =", session_id);
    if (isNewSession) {
      try {
        orientationText = await loadOrientation(supabase, lineage_name, instructions.version);
        isOrientedSession = true;
        console.log("ORIENTATION LOADED: length =", orientationText.length);
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
              max_tokens: 8192,
              system: [
                {
                  type: "text",
                  text: systemText,
                  cache_control: { type: "ephemeral", ttl: "1h" },
                },
              ],
              messages: loopMessages,
              tools: availableToolDefinitions({ isNewSession }),
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
        const content = await runTool(toolUse.name, toolUse.input, { supabase, directArtefacts, lineageName: lineage_name });
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
              max_tokens: 8192,
              system: [
                {
                  type: "text",
                  text: systemText,
                  cache_control: { type: "ephemeral", ttl: "1h" },
                },
              ],
              messages: loopMessages,
              tools: availableToolDefinitions({ isNewSession }),
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
            artifact_count: artifacts.length,
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