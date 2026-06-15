// Gemini (Google) adapter.
//
// SYNC standard models: gemini-3.1-pro, gemini-2.5-pro
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//
// ASYNC Deep Research: deep-research-pro-preview
//   ⚠ ENDPOINT SHAPE NOT YET LIVE-VERIFIED.
//   Argos's research (msg d56e3525) names this surface as the "Interactions API"
//   with background=true and interactions.get for polling. The best-guess paths
//   below are based on Google's standard Long-Running-Operations / Interactions
//   convention; if the first live call returns 404 or a schema mismatch, the raw
//   response is preserved in error.raw and the path needs amending.
//
// Auth: ?key=$GEMINI_API_KEY (or x-goog-api-key header)

import type { Adapter, AdapterPollResult, AdapterRequest, AdapterResponse, AdapterSubmitResult, Source } from "../types.ts";
import { env } from "../env.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function keyParam(): string {
  return `key=${encodeURIComponent(env("GEMINI_API_KEY"))}`;
}

function isDeepResearch(model: string): boolean {
  return model.includes("deep-research");
}

// ── Parse generateContent / candidates shape into AdapterResponse ──────────
function parseCandidates(raw: Record<string, unknown>, model: string): AdapterResponse {
  const candidates = Array.isArray(raw?.candidates) ? raw.candidates as Array<{content?: {parts?: Array<{text?: string}>}; finishReason?: string; groundingMetadata?: {groundingChunks?: Array<{web?: {uri?: string; title?: string}}>}}> : [];
  const cand0 = candidates[0];
  const text = (cand0?.content?.parts ?? []).map(p => p.text ?? "").join("");
  const finish = cand0?.finishReason ?? "STOP";

  const sources: Source[] = [];
  for (const chunk of (cand0?.groundingMetadata?.groundingChunks ?? [])) {
    if (chunk?.web?.uri) sources.push({ url: chunk.web.uri, title: chunk.web.title });
  }
  // Some Deep Research responses surface citations under `attributions[]` or `sources[]`.
  for (const a of (raw?.attributions ?? []) as Array<{url?: string; title?: string; snippet?: string}>) {
    if (a?.url) sources.push({ url: a.url, title: a.title, snippet: a.snippet });
  }

  const usage = (raw?.usageMetadata ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number };

  return {
    text,
    sources,
    labels: [
      { key: "engine", value: `gemini-${model}` },
      { key: "search_grounded", value: sources.length > 0 ? "true" : "false" },
      { key: "finish_reason", value: String(finish) },
    ],
    usage: { input_tokens: usage.promptTokenCount, output_tokens: usage.candidatesTokenCount },
    raw,
  };
}

export const geminiAdapter: Adapter = {
  provider: "gemini",

  async submit(req: AdapterRequest): Promise<AdapterSubmitResult> {
    const timeoutMs = req.opts?.timeout_ms ?? 60_000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);

    const url = isDeepResearch(req.model)
      // BEST-GUESS Deep Research submit path — see file header note.
      ? `${BASE}/models/${encodeURIComponent(req.model)}:generateContent?${keyParam()}`
      : `${BASE}/models/${encodeURIComponent(req.model)}:generateContent?${keyParam()}`;

    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: req.prompt }] }],
      generationConfig: {
        ...(req.opts?.max_tokens !== undefined ? { maxOutputTokens: req.opts.max_tokens } : {}),
        ...(req.opts?.temperature !== undefined ? { temperature: req.opts.temperature } : {}),
      },
      // google_search grounding for both sync grounded answers and the Deep
      // Research surface (the model decides whether to use it; harmless if ignored).
      // The legacy googleSearchRetrieval tool config is rejected by current models
      // ("google_search_retrieval is not supported. Please use google_search tool
      // instead.") — use googleSearch.
      tools: [{ googleSearch: {} }],
    };
    // Do NOT send a `background` field — Gemini rejects it outright ("Invalid JSON
    // payload received. Unknown name 'background': Cannot find field."). The deep-
    // research models run synchronously via generateContent; parseCandidates()
    // handles the inline response and submit returns {done:true} below.

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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
      // If the response carries a job/interaction name, treat as async.
      const r = raw as { name?: string; operation?: { name?: string }; candidates?: unknown[] } | null;
      const jobName = r?.name ?? r?.operation?.name;
      if (jobName && !Array.isArray(r?.candidates)) {
        return { ok: true, done: false, job_ref: jobName };
      }
      // Otherwise parse as a synchronous response.
      return { ok: true, done: true, response: parseCandidates(raw as Record<string, unknown>, req.model) };
    }

    return { ok: true, done: true, response: parseCandidates(raw as Record<string, unknown>, req.model) };
  },

  async poll(jobRef: string): Promise<AdapterPollResult> {
    // jobRef is the full operation/interaction name (e.g. "interactions/abc123" or "operations/xyz").
    const url = `${BASE}/${jobRef}?${keyParam()}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "GET" });
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
    // Google's Long-Running-Operation convention: { name, done: bool, response?, error? }
    const done = (r?.done as boolean | undefined) === true;
    if (!done) return { status: "in_progress" };

    if (r?.error) {
      const err = r.error as { message?: string; code?: number };
      return { status: "failed", error: { kind: "api_error", message: err.message ?? "operation error", retryable: false, http_status: err.code, raw } };
    }

    const inner = (r?.response ?? r) as Record<string, unknown>;
    const response = parseCandidates(inner, "deep-research-pro-preview");
    const finish = (response.labels.find(l => l.key === "finish_reason")?.value ?? "").toUpperCase();
    if (finish === "MAX_TOKENS") {
      return { status: "partial", response, reason: "MAX_TOKENS" };
    }
    return { status: "completed", response };
  },
};
