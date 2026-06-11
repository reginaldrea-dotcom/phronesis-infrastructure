// Perplexity adapter.
//
// SYNC sonar / sonar-pro / sonar-reasoning-pro:
//   POST https://api.perplexity.ai/chat/completions
//
// ASYNC sonar-deep-research:
//   POST https://api.perplexity.ai/async/chat/completions
//   GET  https://api.perplexity.ai/async/chat/completions/{id}
//   ⚠ Live bug noted by Argos: poll endpoint sometimes reports IN_PROGRESS for
//   30-40 min on already-finished jobs. Worker enforces poll_staleness_ms ceiling.
//
// Auth: Authorization: Bearer $PERPLEXITY_API_KEY

import type { Adapter, AdapterPollResult, AdapterRequest, AdapterResponse, AdapterSubmitResult, Source } from "../types.ts";
import { env } from "../env.ts";

const SYNC_ENDPOINT  = "https://api.perplexity.ai/chat/completions";
const ASYNC_ENDPOINT = "https://api.perplexity.ai/async/chat/completions";

function isDeepResearch(model: string): boolean {
  return model === "sonar-deep-research";
}

function authHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "authorization": `Bearer ${env("PERPLEXITY_API_KEY")}`,
  };
}

// Normalise Perplexity's citations[] (string URLs) + search_results[] (richer)
// into our Source[] shape.
function extractSources(raw: { citations?: unknown; search_results?: unknown }): Source[] {
  const out: Source[] = [];
  const sr = Array.isArray(raw?.search_results) ? raw.search_results as Array<{url?: string; title?: string; snippet?: string; date?: string}> : [];
  for (const s of sr) {
    out.push({ url: s.url, title: s.title, snippet: s.snippet, retrieved_at: s.date });
  }
  // Fall back to citations[] URLs not already covered by search_results
  const cites = Array.isArray(raw?.citations) ? raw.citations as string[] : [];
  const seen = new Set(out.map(s => s.url).filter(Boolean));
  for (const url of cites) if (!seen.has(url)) out.push({ url });
  return out;
}

function parseCompleted(raw: Record<string, unknown>, model: string): AdapterResponse {
  const choices = Array.isArray(raw?.choices) ? raw.choices as Array<{message?: {content?: string}; finish_reason?: string}> : [];
  const text = choices[0]?.message?.content ?? "";
  const finish = choices[0]?.finish_reason;
  const usage = (raw?.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };

  return {
    text,
    sources: extractSources(raw as { citations?: unknown; search_results?: unknown }),
    labels: [
      { key: "engine", value: `perplexity-${model}` },
      { key: "search_grounded", value: "true" },
      { key: "finish_reason", value: String(finish ?? "stop") },
    ],
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
    raw,
  };
}

export const perplexityAdapter: Adapter = {
  provider: "perplexity",

  async submit(req: AdapterRequest): Promise<AdapterSubmitResult> {
    const timeoutMs = req.opts?.timeout_ms ?? 60_000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const url = isDeepResearch(req.model) ? ASYNC_ENDPOINT : SYNC_ENDPOINT;

    // Chat-completion params. The SYNC surface takes these at the body root; the
    // ASYNC surface (/async/chat/completions) requires them WRAPPED under a
    // top-level `request` key. Posting the flat body to the async endpoint returns
    // HTTP 400 — the deep-research dispatch failure Theo flagged (baton 143072ab #1).
    const chatParams = {
      model: req.model,
      messages: [{ role: "user", content: req.prompt }],
      return_citations: true,
      return_images: false,
      ...(req.opts?.max_tokens !== undefined ? { max_tokens: req.opts.max_tokens } : {}),
      ...(req.opts?.temperature !== undefined ? { temperature: req.opts.temperature } : {}),
    };
    const payload = isDeepResearch(req.model) ? { request: chatParams } : chatParams;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: ctl.signal,
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
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
      // Async surface: response shape is { id: "...", status: "QUEUED" | "IN_PROGRESS" | ... }
      // (Perplexity uses upper-case statuses on the async surface; observed shape.)
      const id = (raw as { id?: string; request_id?: string })?.id ?? (raw as { request_id?: string })?.request_id;
      if (!id) {
        return { ok: false, error: { kind: "api_error", message: "async submit returned no id", retryable: false, raw } };
      }
      return { ok: true, done: false, job_ref: id };
    }

    // Sync surface: full chat completion returned inline.
    return { ok: true, done: true, response: parseCompleted(raw as Record<string, unknown>, req.model) };
  },

  async poll(jobRef: string): Promise<AdapterPollResult> {
    const url = `${ASYNC_ENDPOINT}/${encodeURIComponent(jobRef)}`;
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

    // Async response includes status field plus (when COMPLETED) the chat completion payload.
    const statusStr = String((raw as { status?: string } | null)?.status ?? "").toUpperCase();

    // Async lifecycle (observed + documented): CREATED -> STARTED/PROCESSING/IN_PROGRESS -> COMPLETED|FAILED.
    if (["CREATED", "QUEUED", "IN_PROGRESS", "PROCESSING", "STARTED"].includes(statusStr)) {
      return { status: "in_progress" };
    }
    if (statusStr === "FAILED" || statusStr === "CANCELLED" || statusStr === "EXPIRED") {
      const detail = (raw as { error?: { message?: string }; failure_reason?: string } | null);
      const msg = detail?.error?.message ?? detail?.failure_reason ?? statusStr;
      return { status: "failed", error: { kind: "api_error", message: String(msg), retryable: false, raw } };
    }
    if (statusStr === "COMPLETED" || statusStr === "FINISHED") {
      // The completed payload may embed the chat result at the root or under a `response`/`result` key.
      // Try the most likely shapes.
      const r = raw as Record<string, unknown>;
      const inner = (r.response ?? r.result ?? r) as Record<string, unknown>;
      const response = parseCompleted(inner, "sonar-deep-research");
      const finish = (response.labels.find(l => l.key === "finish_reason")?.value ?? "").toLowerCase();
      if (finish === "length") {
        return { status: "partial", response, reason: "max_tokens" };
      }
      return { status: "completed", response };
    }
    // Unknown status — defensive: keep polling.
    return { status: "in_progress" };
  },
};
