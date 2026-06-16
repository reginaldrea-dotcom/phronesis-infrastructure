// OpenAI adapter — Responses API only, ROUTED BY ROLE (B1-oai 9c0b18ed).
//
//   deep_research -> POST /v1/responses  background:true + tools:[web_search_preview]  (ASYNC submit/poll)
//   current_web   -> POST /v1/responses              + tools:[web_search_preview]       (SYNC)
//   poll:            GET  /v1/responses/{id}
//
// Models come from config (gpt-5.5-pro for deep_research, gpt-5.4-mini for current_web); the adapter
// never branches on the model name. No stream:true (gpt-5.5-pro rejects streaming; background mode is
// non-streaming). The old chat/completions path (gpt-4o-search-preview etc.) is retired — those SKUs
// shut down 2026-07-23.
//
// Auth: Authorization: Bearer $OPENAI_API_KEY

import type { Adapter, AdapterPollResult, AdapterRequest, AdapterResponse, AdapterSubmitResult, Source } from "../types.ts";
import { env } from "../env.ts";

const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

function authHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "authorization": `Bearer ${env("OPENAI_API_KEY")}`,
  };
}

// ── Responses API parsing (both roles) ─────────────────────────────────────
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

    // ROUTE BY ROLE, not model name (B1-oai 9c0b18ed). The retired deep-research SKUs were the
    // only models whose NAME implied the endpoint+tool (isDeepResearch = name.includes("deep-research")).
    // Their replacements carry no such hint — gpt-5.5-pro (deep_research) and gpt-5.4-mini (current_web) —
    // so a name-based router would misroute them to /chat UNGROUNDED, which A1a would then flag as
    // zero-source. Both web roles now go via the Responses API + the web_search tool. deep_research is
    // ASYNC (background -> submit/poll, safe against the ~150s EF 504); current_web is SYNC. NB: no
    // stream:true anywhere — gpt-5.5-pro rejects streaming, and background mode is non-streaming.
    const isDeep = req.role === "deep_research";
    const body: Record<string, unknown> = {
      model: req.model,
      input: req.prompt,
      tools: [{ type: "web_search_preview" }],
      ...(isDeep ? { background: true } : {}),
      ...(req.opts?.max_tokens !== undefined ? { max_output_tokens: req.opts.max_tokens } : {}),
    };

    let res: Response;
    try {
      res = await fetch(RESPONSES_ENDPOINT, { method: "POST", signal: ctl.signal, headers: authHeaders(), body: JSON.stringify(body) });
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

    const status = String((raw as { status?: string })?.status ?? "");
    const id = (raw as { id?: string })?.id;

    // deep_research: async submit -> poll, unless it returned completed inline (short jobs).
    if (isDeep) {
      if (status === "completed") {
        return { ok: true, done: true, response: parseResponsesCompleted(raw as Record<string, unknown>, req.model) };
      }
      if (!id) return { ok: false, error: { kind: "api_error", message: "responses submit returned no id", retryable: false, raw } };
      return { ok: true, done: false, job_ref: id };
    }

    // current_web: sync /responses — the completed response comes back inline.
    if (status === "completed" || status === "") {
      return { ok: true, done: true, response: parseResponsesCompleted(raw as Record<string, unknown>, req.model) };
    }
    // Defensive: if a sync call somehow came back still running, fall through to the poll path.
    if ((status === "queued" || status === "in_progress") && id) {
      return { ok: true, done: false, job_ref: id };
    }
    return { ok: true, done: true, response: parseResponsesCompleted(raw as Record<string, unknown>, req.model) };
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
