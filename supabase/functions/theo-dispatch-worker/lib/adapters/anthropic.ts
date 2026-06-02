// Anthropic (Claude) adapter — synthesist / fourth voice.
// SYNC: submit() returns {done:true, response} in one call. No poll().
//
// Endpoint:  POST https://api.anthropic.com/v1/messages
// Auth:      x-api-key: $ANTHROPIC_API_KEY
// Headers:   anthropic-version: 2023-06-01
// Body:      { model, max_tokens, messages: [{role:"user", content: prompt}] }

import type { Adapter, AdapterRequest, AdapterSubmitResult } from "../types.ts";
import { env } from "../env.ts";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const anthropicAdapter: Adapter = {
  provider: "anthropic",

  async submit(req: AdapterRequest): Promise<AdapterSubmitResult> {
    const timeoutMs = req.opts?.timeout_ms ?? 240_000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": env("ANTHROPIC_API_KEY"),
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.opts?.max_tokens ?? 32_000,
          temperature: req.opts?.temperature,
          messages: [{ role: "user", content: req.prompt }],
        }),
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === "AbortError") {
        return { ok: false, error: { kind: "timeout", message: `timeout after ${timeoutMs}ms`, retryable: true } };
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

    // Successful response shape: { content: [{type:"text", text: "..."}], usage: {input_tokens, output_tokens}, stop_reason }
    const text = Array.isArray(raw?.content)
      ? raw.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("")
      : "";
    const usage = raw?.usage ?? {};

    const partial = raw?.stop_reason === "max_tokens";
    if (partial) {
      // Return as success/done with a partial label; queue.markCompleted vs markPartial
      // is decided by the worker based on labels.
      return {
        ok: true,
        done: true,
        response: {
          text,
          sources: [],
          labels: [
            { key: "engine", value: `anthropic-${req.model}` },
            { key: "stop_reason", value: "max_tokens" },
            { key: "partial", value: "true" },
          ],
          usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
          raw,
        },
      };
    }

    return {
      ok: true,
      done: true,
      response: {
        text,
        sources: [],
        labels: [
          { key: "engine", value: `anthropic-${req.model}` },
          { key: "stop_reason", value: String(raw?.stop_reason ?? "end_turn") },
        ],
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
        raw,
      },
    };
  },

  // No poll() — Anthropic is always sync.
};
