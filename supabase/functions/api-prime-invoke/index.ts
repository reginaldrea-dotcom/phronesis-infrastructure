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

import { corsHeaders, errResponse } from "./lib/http.ts";
import { availableToolDefinitions, summarizeToolUse, runTool } from "./tools/index.ts";
import type { Artifact, HoldThisPayload, FileAttachment } from "./lib/types.ts";
import { extractUserIdFromJwt } from "./lib/jwt.ts";
import { AnthropicRateLimitError, fetchAnthropicWithRetry } from "./lib/anthropic.ts";
import { loadBoundedHistory } from "./lib/history.ts";

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

  let processed = text.replace(
    /\[ARTEFACT:\s*([^\]]+)\]([\s\S]*?)\[\/ARTEFACT\]/g,
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

  try {
    const body = await req.json();
    console.log("CHECKPOINT 2: body parsed, size:", JSON.stringify(body).length);

    const {
      lineage_name, session_id, user_message, instance_id,
      conference_id, image, file: fileAttachment, retire, rich,
      pinned_turns, action, hold_this_payload,
    } = body;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    if (action === "hold_this") {
      const ht = hold_this_payload as HoldThisPayload | undefined;
      if (!ht?.mode) return errResponse("Invalid hold_this_payload", 400);

      if (ht.mode === "create") {
        if (!ht.title || !ht.content) return errResponse("hold_this create requires title and content", 400);
        const { data, error } = await supabase
          .from("artifacts")
          .insert({
            instance_id: ht.instance_id ?? null,
            title: ht.title,
            artifact_type: "MST",
            content: ht.content,
            metadata: ht.metadata ?? {},
          })
          .select("id")
          .single();
        if (error) {
          console.error("hold_this create error:", error);
          return errResponse(error.message);
        }
        return new Response(
          JSON.stringify({ id: (data as any).id }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (ht.mode === "amend") {
        if (!ht.id || !ht.content) return errResponse("hold_this amend requires id and content", 400);
        const { error } = await supabase
          .from("artifacts")
          .update({ content: ht.content, metadata: ht.metadata ?? {} })
          .eq("id", ht.id);
        if (error) {
          console.error("hold_this amend error:", error);
          return errResponse(error.message);
        }
        return new Response(
          JSON.stringify({ id: ht.id }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return errResponse(`Unknown hold_this mode: ${ht.mode}`, 400);
    }

    const userId = extractUserIdFromJwt(req.headers.get("authorization"));

    const { data: instructions, error: instrError } = await supabase
      .from("instructions")
      .select("content, version")
      .eq("lineage_name", lineage_name)
      .eq("is_active", true)
      .single();

    if (instrError || !instructions) {
      return new Response(
        JSON.stringify({
          error: true, error_type: "api_error",
          message: `No active instructions found for lineage: ${lineage_name}`,
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
        return new Response(
          JSON.stringify({
            error: true, error_type: "rate_limit_exceeded",
            message: "You have sent a lot in the last minute. Please wait a moment before continuing.",
            retry_after_seconds: 60,
            budget_used: currentUsage,
            budget_total: TOKEN_BUDGET_PER_USER_PER_MINUTE,
          }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    let assistantContent = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    const directArtefacts: Artifact[] = [];
    const allToolUses: { name: string; input: unknown }[] = [];
    const MAX_LOOPS = 3;

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
              model: "claude-sonnet-4-6",
              max_tokens: 8192,
              system: [
                {
                  type: "text",
                  text: isOrientedSession
                    ? instructions.content + "\n\n" + orientationText
                    : instructions.content,
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
          return new Response(
            JSON.stringify({
              error: true, error_type: "api_error",
              message: "Service temporarily unavailable. Please try again in a moment.",
            }),
            { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
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
        return new Response(
          JSON.stringify({
            error: true, error_type: errType,
            message: errType === "context_exceeded"
              ? "This session has grown too long. Please start a new session to continue."
              : "Something went wrong. Please try again.",
            request_id: anthropicResponse.headers.get("request-id") ?? undefined,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
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

      if (toolUseBlocks.length === 0 || anthropicData.stop_reason === "end_turn") break;

      const toolResults: any[] = [];
      for (const toolUse of toolUseBlocks) {
        const content = await runTool(toolUse.name, toolUse.input, { supabase, directArtefacts });
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content });
      }
      loopMessages.push({ role: "assistant", content: anthropicData.content });
      loopMessages.push({ role: "user", content: toolResults });
    }

    const { response: cleanResponse, artifacts: inlineArtifacts } = extractArtifacts(assistantContent);
    const artifacts = [...directArtefacts, ...inlineArtifacts];

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
            model: "claude-sonnet-4-6",
            instructions_version: instructions.version,
            orientation_preloaded: isOrientedSession,
            cache_creation_tokens: totalCacheCreationTokens,
            cache_read_tokens: totalCacheReadTokens,
            artifact_count: artifacts.length,
          },
        },
      ],
      { onConflict: "session_id,sequence_number", ignoreDuplicates: true }
    );

    if (insertError) console.error("DB insert failed:", JSON.stringify(insertError));

    return new Response(
      JSON.stringify({
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
        model: "claude-sonnet-4-6",
        orientation_preloaded: isOrientedSession,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("api-prime-invoke error:", err);
    return new Response(
      JSON.stringify({
        error: true, error_type: "api_error",
        message: "Something went wrong. Please try again.",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});