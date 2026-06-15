// OpenAI adapter.
//
// SYNC chat models (search-grounded): gpt-5-search-api, gpt-4o-search-preview
//   POST https://api.openai.com/v1/chat/completions
//
// ASYNC deep-research: o3-deep-research, o4-mini-deep-research
//   POST https://api.openai.com/v1/responses  (with background:true)
//   GET  https://api.openai.com/v1/responses/{id}
//
// Auth: Authorization: Bearer $OPENAI_API_KEY

import type { Adapter, AdapterPollResult, AdapterRequest, AdapterResponse, AdapterSubmitResult, Source } from "../types.ts";
import { env } from "../env.ts";

const CHAT_ENDPOINT      = "https://api.openai.com/v1/chat/completions";
const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

function isDeepResearch(model: string): boolean {
  return model.includes("deep-research");
}

function authHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "authorization": `Bearer ${env("OPENAI_API_KEY")}`,
  };
}

// ── Sync (chat/completions) parsing ────────────────────────────────────────
function parseChatCompletion(raw: Record<string, unknown>, model: string): AdapterResponse {
  const choices = Array.isArray(raw?.choices) ? raw.choices as Array<{message?: {content?: string; annotations?: unknown[]}; finish_reason?: string}> : [];
  const msg = choices[0]?.message;
  const text = msg?.content ?? "";
  const finish = choices[0]?.finish_reason ?? "stop";

  const sources: Source[] = [];
  for (const ann of (msg?.annotations ?? []) as Array<{type?: string; url_citation?: {url?: string; title?: string}}>) {
    if (ann?.type === "url_citation" && ann.url_citation?.url) {
      sources.push({ url: ann.url_citation.url, title: ann.url_citation.title });
    }
  }
  const usage = (raw?.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };

  return {
    text,
    sources,
    labels: [
      { key: "engine", value: `openai-${model}` },
      { key: "search_grounded", value: model.includes("search") ? "true" : "false" },
      { key: "finish_reason", value: String(finish) },
    ],
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
    raw,
  };
}

// ── Async (Responses API) parsing ──────────────────────────────────────────
// Response object shape: { id, status, output: [...], usage: {input_tokens, output_tokens}, ... }
// Text is concatenated from output[].content[].text where output[].type === "message".
// Citations may appear as output[].content[].annotations[] with type="url_citation".
function parseResponsesCompleted(raw: Record<string, unknown>, model: string): AdapterResponse {
  const output = Array.isArray(raw?.output) ? raw.output as Array<{type?: string; content?: Array<{type?: string; text?: string; annotations?: unknown[]}>}> : [];
  let text = "";
  const sources: Source[] = [];
  for (const item of output) {
    if (item?.type !== "message") continue;
    for (const c of (item.content ?? [])) {
      if (typeof c?.text === "string") text += c.text;
      for (const ann of (c?.annotations ?? []) as Array<{type?: string; url?: string; title?: string; url_citation?: {url?: string; title?: string}}>) {
        if (ann?.type === "url_citation") {
          const uc = ann.url_citation ?? ann;
          if (uc?.url) sources.push({ url: uc.url, title: uc.title });
        }
      }
    }
  }
  const usage = (raw?.usage ?? {}) as { input_tokens?: number; output_tokens?: number };

  return {
    text,
    sources,
    labels: [
      { key: "engine", value: `openai-${model}` },
      { key: "search_grounded", value: "true" },     // deep-research models always do retrieval
      { key: "responses_status", value: String((raw as { status?: string })?.status ?? "completed") },
    ],
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    raw,
  };
}

export const openaiAdapter: Adapter = {
  provider: "openai",

  async submit(req: AdapterRequest): Promise<AdapterSubmitResult> {
    const timeoutMs = req.opts?.timeout_ms ?? 60_000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const url = isDeepResearch(req.model) ? RESPONSES_ENDPOINT : CHAT_ENDPOINT;

    const body = isDeepResearch(req.model)
      ? {
          model: req.model,
          input: req.prompt,
          background: true,
          // Deep research models require at least one of web_search_preview / mcp /
          // file_search tools, else a 400 ("Deep research models require at least one
          // of 'web_search_preview', 'mcp', or 'file_search' tools.").
          tools: [{ type: "web_search_preview" }],
          ...(req.opts?.max_tokens !== undefined ? { max_output_tokens: req.opts.max_tokens } : {}),
        }
      : {
          model: req.model,
          messages: [{ role: "user", content: req.prompt }],
          ...(req.opts?.max_tokens !== undefined ? { max_completion_tokens: req.opts.max_tokens } : {}),
          ...(req.opts?.temperature !== undefined ? { temperature: req.opts.temperature } : {}),
        };

    let res: Response;
    try {
      res = await fetch(url, { method: "POST", signal: ctl.signal, headers: authHeaders(), body: JSON.stringify(body) });
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === "AbortError") {
        return { ok: false, error: { kind: "timeout", message: `submit timeout after ${timeoutMs}ms`, retryable: true } };
      }
      return { ok: false, error: { kind: "api_error", message: String(e), retryable: true } };
    }
    clearTimeout(timer);

    const raw = await res.json().catch(() => null);

    if (res.status === 429) {
      const ra = parseInt(res.headers.get("retry-after") ?? "60", 10);
      return { ok: false, error: { kind: "rate_limit", message: "429", retryable: true, retry_after_ms: ra * 1000, http_status: 429, raw } };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: { kind: "auth", message: `auth ${res.status}`, retryable: false, http_status: res.status, raw } };
    }
    if (!res.ok) {
      return { ok: false, error: { kind: "api_error", message: `http ${res.status}`, retryable: res.status >= 500, http_status: res.status, raw } };
    }

    if (isDeepResearch(req.model)) {
      const id = (raw as { id?: string })?.id;
      if (!id) return { ok: false, error: { kind: "api_error", message: "responses submit returned no id", retryable: false, raw } };
      // Possibility: a fast response could return status="completed" immediately. Honour it.
      const status = String((raw as { status?: string })?.status ?? "");
      if (status === "completed") {
        return { ok: true, done: true, response: parseResponsesCompleted(raw as Record<string, unknown>, req.model) };
      }
      return { ok: true, done: false, job_ref: id };
    }

    return { ok: true, done: true, response: parseChatCompletion(raw as Record<string, unknown>, req.model) };
  },

  async poll(jobRef: string): Promise<AdapterPollResult> {
    const url = `${RESPONSES_ENDPOINT}/${encodeURIComponent(jobRef)}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: authHeaders() });
    } catch (e) {
      return { status: "failed", error: { kind: "api_error", message: String(e), retryable: true } };
    }
    const raw = await res.json().catch(() => null);

    if (res.status === 401 || res.status === 403) {
      return { status: "failed", error: { kind: "auth", message: `auth ${res.status}`, retryable: false, http_status: res.status, raw } };
    }
    if (!res.ok) {
      return { status: "failed", error: { kind: "api_error", message: `poll http ${res.status}`, retryable: res.status >= 500, http_status: res.status, raw } };
    }

    const r = raw as Record<string, unknown> | null;
    const status = String((r?.status ?? "") as string);

    if (status === "queued" || status === "in_progress") return { status: "in_progress" };
    if (status === "failed") {
      const err = (r?.error ?? {}) as { message?: string };
      return { status: "failed", error: { kind: "api_error", message: err.message ?? "failed", retryable: false, raw } };
    }
    if (status === "cancelled") {
      return { status: "failed", error: { kind: "other", message: "cancelled", retryable: false, raw } };
    }
    if (status === "incomplete") {
      const reason = String(((r?.incomplete_details ?? {}) as { reason?: string }).reason ?? "incomplete");
      return { status: "partial", response: parseResponsesCompleted(r ?? {}, "o-deep-research"), reason };
    }
    if (status === "completed") {
      return { status: "completed", response: parseResponsesCompleted(r ?? {}, "o-deep-research") };
    }
    // Unknown status — defensive: keep polling.
    return { status: "in_progress" };
  },
};
