// api-prime-invoke | v99 | 28 May 2026
// Change: response now includes tool_uses[] — a slim list of { name, input } per
//         tool call across all loop passes. Consumed by the Argos load-gauge
//         classifier (argos-gauge.js) for weighted session-load scoring.
// Previous: v96 (27 May 2026) — totalCacheReadTokens assigned (not accumulated)
//           across tool-loop passes to fix gauge-rise bug from cache-read double-count.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── GitHub config ─────────────────────────────────────────────────────────────

const GITHUB_OWNER = "reginaldrea-dotcom";
const GITHUB_REPO  = "phronesis-infrastructure";

// ── Tools ─────────────────────────────────────────────────────────────────────

const EXECUTE_SQL_TOOL = {
  name: "execute_sql",
  description: "Execute a SQL query against the Phronesis Supabase database. Use this for all database reads and writes. Returns results as a JSON array.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The SQL query to execute. Use single quotes for string literals." },
    },
    required: ["query"],
  },
};

const DELIVER_ARTEFACT_TOOL = {
  name: "deliver_artefact",
  description: "Deliver content directly to the user's artefact panel. Use this for ALL large content delivery — database documents, code files, HTML. For DB content: provide a SQL query and the edge function fetches it directly. For content already in context (e.g. from GitHub): provide the content field directly. Never reproduce large content in your response text — use this tool instead.",
  input_schema: {
    type: "object",
    properties: {
      title:         { type: "string", description: "Filename or title for the artefact (e.g. 'super-t.md', 'argos.html')" },
      query:         { type: "string", description: "SQL query to fetch content from DB. First row's content_field is used." },
      content:       { type: "string", description: "Direct content to deliver (for content already in context, e.g. from GitHub MCP)" },
      content_field: { type: "string", description: "Field to extract from SQL result. Default: content" },
      type:          { type: "string", description: "Content type hint: html, markdown, typescript, document. Default: document" },
    },
    required: ["title"],
  },
};

const READ_GITHUB_FILE_TOOL = {
  name: "read_github_file",
  description: "Read a file from the Phronesis GitHub repository. Returns the file content as a string. Path is relative to repository root.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path within the repository (e.g. 'navigator/primes/argos-config.js')" },
    },
    required: ["path"],
  },
};

const WRITE_GITHUB_FILE_TOOL = {
  name: "write_github_file",
  description: "Write or update a file in the Phronesis GitHub repository. REQUIRES explicit Reg authorisation per PI before each use. Scoped to prompts/ directory only unless explicitly authorised otherwise.",
  input_schema: {
    type: "object",
    properties: {
      path:    { type: "string", description: "File path within the repository" },
      content: { type: "string", description: "Full file content to write" },
      message: { type: "string", description: "Commit message" },
    },
    required: ["path", "content", "message"],
  },
};

const LIST_GITHUB_DIRECTORY_TOOL = {
  name: "list_github_directory",
  description: "List files and directories at a path in the Phronesis GitHub repository.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path within the repository. Use empty string for root." },
    },
    required: ["path"],
  },
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Artifact {
  title: string;
  content: string;
  type: string;
  version: number;
}

interface HoldThisPayload {
  mode: "create" | "amend";
  instance_id?: string;
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  id?: string;
}

interface FileAttachment {
  data: string;
  media_type: string;
  name?: string;
}

// ── Artifact extraction ───────────────────────────────────────────────────────

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

// ── Rate limiting ─────────────────────────────────────────────────────────────

const TOKEN_BUDGET_PER_USER_PER_MINUTE = 20_000;

function extractUserIdFromJwt(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const payload = JSON.parse(atob(authHeader.slice(7).split(".")[1]));
    const sub = payload.sub;
    return typeof sub === "string" && /^[0-9a-f-]{36}$/.test(sub) ? sub : null;
  } catch { return null; }
}

// ── Fetch with retry on 429 ───────────────────────────────────────────────────

class AnthropicRateLimitError extends Error {
  constructor() { super("Anthropic rate limit exceeded"); this.name = "AnthropicRateLimitError"; }
}

async function fetchAnthropicWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429) return response;
    if (attempt === maxRetries) throw new AnthropicRateLimitError();
    const retryAfter = response.headers.get("retry-after");
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : baseDelayMs * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, delay));
  }
  throw new AnthropicRateLimitError();
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `token ${Deno.env.get("GITHUB_TOKEN")}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "phronesis-argos",
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function trim(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function errResponse(message: string, status = 500): Response {
  return new Response(
    JSON.stringify({ error: true, message }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// ── Bounded history loader ────────────────────────────────────────────────────

async function loadBoundedHistory(
  supabase: ReturnType<typeof createClient>,
  sessionId: string | null,
  tokenCeiling = 50000
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  if (!sessionId) return [];

  const { data: wakeRows } = await supabase
    .from("prime_conversations")
    .select("role, content, sequence_number")
    .eq("session_id", sessionId)
    .lte("sequence_number", 1)
    .order("sequence_number", { ascending: true });

  const { data: historyRows } = await supabase
    .from("prime_conversations")
    .select("role, content, sequence_number")
    .eq("session_id", sessionId)
    .gt("sequence_number", 1)
    .order("sequence_number", { ascending: false })
    .limit(500);

  const wake = (wakeRows ?? []).filter((r: any) => r.role === "user" || r.role === "assistant");
  const history = (historyRows ?? [])
    .filter((r: any) => r.role === "user" || r.role === "assistant")
    .reverse();

  const combined = [...wake, ...history];
  let charBudget = tokenCeiling * 4;
  const trimmed: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = combined.length - 1; i >= 0; i--) {
    const row = combined[i];
    charBudget -= row.content.length;
    if (charBudget < 0 && trimmed.length > 0) break;
    trimmed.unshift({ role: row.role as "user" | "assistant", content: row.content });
  }
  return trimmed;
}

// ── Orientation pre-loader ────────────────────────────────────────────────────
// Conference 8fe2add9 (ratified 20 May 2026): Super-T only at wake.
// Wheel posts, prime_messages, current_priorities, and conferences are NOT
// loaded at session open — available on demand via execute_sql from turn 2.

async function loadOrientation(
  supabase: ReturnType<typeof createClient>,
  lineage: string
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
  lines.push("── AVAILABLE ON DEMAND (execute_sql, turn 2+) ──");
  lines.push("wheel_posts, prime_messages, current_priorities, conferences");
  lines.push("Query these when relevant to current work — they are not pre-loaded.");
  lines.push("═══════════════════════════════════════");
  return lines.join("\n");
}

// ── Main handler ──────────────────────────────────────────────────────────────

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

    // ── Hold-this: early return, no LLM call needed ───────────────────────────
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

    // 1. Load active system prompt
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

    // 2. Resolve session
    const activeSessionId: string = session_id || crypto.randomUUID();
    const isNewSession = !session_id;

    // 3. Next sequence number
    const { count } = await supabase
      .from("prime_conversations")
      .select("*", { count: "exact", head: true })
      .eq("session_id", activeSessionId);
    const nextSequence = count ?? 0;

    // 4. Load bounded conversation history
    const history = await loadBoundedHistory(supabase, session_id || null, 50000);

    // 5. Load pinned turns (outside token ceiling)
    const pinnedMessages: { role: "user" | "assistant"; content: string }[] =
      Array.isArray(pinned_turns)
        ? (pinned_turns as any[])
            .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
            .map((t) => ({ role: t.role, content: `[PINNED CONTEXT — treat as authoritative]\n\n${t.content}` }))
        : [];

    // 6. Build effective user message
    let effectiveMessage: string;
    if (retire) {
      effectiveMessage = rich ? "bfn-R" : "bfn";
    } else if (conference_id) {
      effectiveMessage = `[CONFERENCE MODE — Conference ID: ${conference_id}]\n\n${user_message}`;
    } else {
      effectiveMessage = user_message || "";
    }

    // 7. Build user content (text + optional image or document)
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

    // 8. Pre-load orientation for new sessions (Super-T only per conference 8fe2add9)
    let orientationText = "";
    let isOrientedSession = false;
    console.log("ORIENTATION CHECK: isNewSession =", isNewSession, "session_id =", session_id);
    if (isNewSession) {
      try {
        orientationText = await loadOrientation(supabase, lineage_name);
        isOrientedSession = true;
        console.log("ORIENTATION LOADED: length =", orientationText.length);
      } catch (err) {
        console.error("Orientation pre-load failed:", err);
      }
    }

    // 9. Pre-flight rate limit check (Clarev authenticated users only)
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

   // 10. Conversational turn — one primary call, one optional tool pass
    let assistantContent = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    const directArtefacts: Artifact[] = [];
    // Aggregated tool_use blocks across all loop passes — surfaced to client so
    // the Argos load-gauge classifier (argos-gauge.js) can inspect SQL in tool calls.
    // Slim shape ({ name, input }) keeps the payload small and matches one of the
    // four shapes the classifier already checks for (data.tool_uses).
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
              tools: [
                ...(isNewSession ? [] : [EXECUTE_SQL_TOOL]),
                DELIVER_ARTEFACT_TOOL,
                READ_GITHUB_FILE_TOOL,
                WRITE_GITHUB_FILE_TOOL,
                LIST_GITHUB_DIRECTORY_TOOL,
              ],
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
      // Record tool calls (slim) for client-side classification
      for (const t of toolUseBlocks) {
        allToolUses.push({ name: t.name, input: t.input });
      }
      if (toolUseBlocks.length > 0) {
        const toolSummary = toolUseBlocks.map((t: any) => {
          if (t.name === "execute_sql") return `execute_sql: ${String(t.input?.query ?? "").slice(0, 120)}`;
          if (t.name === "deliver_artefact") return `deliver_artefact: "${t.input?.title ?? ""}"`;
          if (t.name === "read_github_file") return `read_github_file: ${t.input?.path ?? ""}`;
          if (t.name === "write_github_file") return `write_github_file: ${t.input?.path ?? ""}`;
          if (t.name === "list_github_directory") return `list_github_directory: ${t.input?.path ?? ""}`;
          return t.name;
        }).join(" | ");
        console.log(`TOOL CALLS pass:${loop} →`, toolSummary);
      }

      if (toolUseBlocks.length === 0 || anthropicData.stop_reason === "end_turn") break;

      const toolResults: any[] = [];
      for (const toolUse of toolUseBlocks) {
        if (toolUse.name === "execute_sql") {
          try {
            const { data: sqlData, error: sqlError } = await supabase.rpc("execute_raw_sql", { query: toolUse.input.query });
            let resultContent: string;
            if (sqlError) {
              resultContent = `SQL Error: ${sqlError.message}\n[SYSTEM: this is the answer — surface this error to Reg immediately. Do not retry with another query.]`;
            } else if (Array.isArray(sqlData) && sqlData.length === 0) {
              resultContent = `[]\n[SYSTEM: empty result — this is the answer. Do not retry with a different query. Report to Reg what you queried and what it returned.]`;
            } else {
              resultContent = JSON.stringify(sqlData ?? []);
            }
            toolResults.push({
              type: "tool_result", tool_use_id: toolUse.id,
              content: resultContent,
            });
          } catch (err) {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Execution error: ${String(err)}\n[SYSTEM: surface this error to Reg immediately. Do not retry.]` });
          }
        } else if (toolUse.name === "deliver_artefact") {
          try {
            const { title, query, content, type = "document" } = toolUse.input;
            const contentField: string = toolUse.input.content_field ?? "content";
            let artefactContent: string | null = null;

            if (query) {
              const { data: sqlData, error: sqlError } = await supabase.rpc("execute_raw_sql", { query });
              if (sqlError) throw new Error(sqlError.message);
              const rows: any[] = Array.isArray(sqlData) ? sqlData : [];
              artefactContent = rows.length > 0 ? (rows[0][contentField] ?? null) : null;
            } else if (content) {
              artefactContent = content;
            }

            if (artefactContent) {
              directArtefacts.push({ title, content: artefactContent, type, version: 1 });
              toolResults.push({
                type: "tool_result", tool_use_id: toolUse.id,
                content: `Artefact delivered: "${title}" (${artefactContent.length} chars). It is now in the user's artefact panel — do not reproduce this content in your response.`,
              });
            } else {
              toolResults.push({
                type: "tool_result", tool_use_id: toolUse.id,
                content: `No content found for artefact "${title}". Check query or content field.`,
              });
            }
          } catch (err) {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Artefact delivery error: ${String(err)}` });
          }
        } else if (toolUse.name === "read_github_file") {
          try {
            const filePath = String(toolUse.input.path ?? "").replace(/^\//, "");
            const ghRes = await fetch(
              `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
              { headers: githubHeaders() }
            );
            if (!ghRes.ok) {
              const errText = await ghRes.text();
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `GitHub error ${ghRes.status}: ${errText}` });
            } else {
              const fileData = await ghRes.json();
              const content = atob((fileData.content as string).replace(/\n/g, ""));
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content });
            }
          } catch (err) {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `read_github_file error: ${String(err)}` });
          }
        } else if (toolUse.name === "write_github_file") {
          try {
            const filePath = String(toolUse.input.path ?? "").replace(/^\//, "");
            const shaRes = await fetch(
              `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
              { headers: githubHeaders() }
            );
            const sha: string | undefined = shaRes.ok ? ((await shaRes.json()).sha as string) : undefined;
            const writeRes = await fetch(
              `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
              {
                method: "PUT",
                headers: { ...githubHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify({
                  message: toolUse.input.message,
                  content: btoa(unescape(encodeURIComponent(toolUse.input.content))),
                  ...(sha ? { sha } : {}),
                }),
              }
            );
            if (!writeRes.ok) {
              const errText = await writeRes.text();
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `GitHub write error ${writeRes.status}: ${errText}` });
            } else {
              const writeData = await writeRes.json();
              toolResults.push({
                type: "tool_result", tool_use_id: toolUse.id,
                content: `File written: ${filePath} — commit ${(writeData.commit?.sha as string)?.slice(0, 7) ?? "unknown"}`,
              });
            }
          } catch (err) {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `write_github_file error: ${String(err)}` });
          }
        } else if (toolUse.name === "list_github_directory") {
          try {
            const dirPath = String(toolUse.input.path ?? "").replace(/^\//, "");
            const ghRes = await fetch(
              `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${dirPath}`,
              { headers: githubHeaders() }
            );
            if (!ghRes.ok) {
              const errText = await ghRes.text();
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `GitHub error ${ghRes.status}: ${errText}` });
            } else {
              const dirData = await ghRes.json();
              const items: any[] = Array.isArray(dirData) ? dirData : [dirData];
              const listing = items
                .map((item: any) => `${item.type === "dir" ? "dir " : "file"} ${item.name}  ${item.path}`)
                .join("\n");
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: listing || "(empty directory)" });
            }
          } catch (err) {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `list_github_directory error: ${String(err)}` });
          }
        }
      }
      loopMessages.push({ role: "assistant", content: anthropicData.content });
      loopMessages.push({ role: "user", content: toolResults });
    }

    // 11. Extract artifacts from assistant response
    const { response: cleanResponse, artifacts: inlineArtifacts } = extractArtifacts(assistantContent);
    const artifacts = [...directArtefacts, ...inlineArtifacts];

    // 12. Record rate limit usage (Clarev users)
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

    // 13. Persist turns
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