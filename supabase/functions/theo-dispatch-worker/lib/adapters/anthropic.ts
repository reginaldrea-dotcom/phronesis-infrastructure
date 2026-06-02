// Anthropic (Claude) adapter — synthesist / fourth voice.
// SYNC: submit() returns {done:true, response} in one call. No poll().
//
// Endpoint:  POST https://api.anthropic.com/v1/messages
// Auth:      x-api-key: $ANTHROPIC_API_KEY   (same env var as api-prime-invoke)
// Headers:   anthropic-version: 2023-06-01
//            (no prompt-caching beta — worker has no cross-call cache reuse;
//            Theo's interactive turns own caching)
//
// Stub: Phase-1 build (Task 5) fills the body. Contract surface only here.

import type { Adapter, AdapterRequest, AdapterSubmitResult } from "../types.ts";

export const anthropicAdapter: Adapter = {
  provider: "anthropic",

  async submit(_req: AdapterRequest): Promise<AdapterSubmitResult> {
    // TODO (Task 5):
    //  - fetch() the messages endpoint with body { model, max_tokens, system?, messages: [{role:"user", content: prompt}] }
    //  - on 429: return { ok:false, error:{kind:"rate_limit", retryable:true, retry_after_ms: <from header>} }
    //  - on timeout (AbortController): return kind="timeout"
    //  - on 200: parse content[0].text into AdapterResponse.text; usage -> AdapterUsage;
    //            sources empty (web-search tool not enabled in worker path);
    //            labels include {key:"engine", value:"anthropic-claude-<model>"}
    //  - return { ok:true, done:true, response }
    //  - cost_usd: compute from input/output tokens via per-model price table (lib/pricing.ts, future)
    return {
      ok: false,
      error: {
        kind: "api_error",
        message: "anthropicAdapter.submit() not implemented (Task 5)",
        retryable: false,
      },
    };
  },

  // No poll() — Anthropic is always sync. Dispatcher checks engine config and
  // never invokes poll on this adapter.
};
