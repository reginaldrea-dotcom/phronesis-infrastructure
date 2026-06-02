// Perplexity adapter — deep-source / verification + sync sonar models.
//
// Two surfaces, model-dependent (Argos msg d56e3525):
//
//   ASYNC sonar-deep-research:
//     POST  https://api.perplexity.ai/async/chat/completions
//     GET   https://api.perplexity.ai/async/chat/completions/{request_id}
//     ⚠ Live bug noted by Argos: poll endpoint sometimes returns IN_PROGRESS
//     for 30-40 min on jobs that already finished. Worker enforces
//     poll_staleness_ms ceiling (45 min default) and marks 'failed' if exceeded.
//
//   SYNC sonar / sonar-pro / sonar-reasoning-pro:
//     POST  https://api.perplexity.ai/chat/completions
//
// Auth: Authorization: Bearer $PERPLEXITY_API_KEY (both endpoints)
// Body: { model, messages: [{role:"user", content: prompt}], return_citations: true, ... }
//
// Stub: Phase-1 build (Task 5) fills the bodies.

import type { Adapter, AdapterPollResult, AdapterRequest, AdapterSubmitResult } from "../types.ts";

function isDeepResearch(model: string): boolean {
  return model === "sonar-deep-research";
}

export const perplexityAdapter: Adapter = {
  provider: "perplexity",

  async submit(req: AdapterRequest): Promise<AdapterSubmitResult> {
    // TODO (Task 5):
    if (isDeepResearch(req.model)) {
      //  ASYNC PATH (/async/chat/completions):
      //  - POST with body { model, messages, return_citations: true }
      //  - 200 returns { id } (or { request_id })
      //  - return { ok:true, done:false, job_ref: id }
    } else {
      //  SYNC PATH (/chat/completions):
      //  - POST with body { model, messages, return_citations: true, return_images: false }
      //  - Parse choices[0].message.content -> response.text
      //  - Parse top-level citations[] (urls) AND search_results[] (richer objects)
      //    -> Source[] { url, title, snippet?, retrieved_at? }
      //  - usage.prompt_tokens / usage.completion_tokens -> AdapterUsage
      //  - return { ok:true, done:true, response }
    }
    void req;
    return {
      ok: false,
      error: {
        kind: "api_error",
        message: "perplexityAdapter.submit() not implemented (Task 5)",
        retryable: false,
      },
    };
  },

  async poll(_job_ref: string): Promise<AdapterPollResult> {
    // TODO (Task 5):
    //  - GET /async/chat/completions/{job_ref}
    //  - status="queued" | "in_progress"  -> { status: "in_progress" }
    //    (worker enforces staleness ceiling separately — don't loop in here)
    //  - status="completed"               -> parse choices[0].message.content + citations[]
    //                                          -> { status:"completed", response }
    //  - status="failed"                  -> { status:"failed", error: from error_detail }
    //  - Truncation detection: if response was cut off (finish_reason=length),
    //    return { status:"partial", response, reason:"max_tokens" }
    return {
      status: "failed",
      error: {
        kind: "api_error",
        message: "perplexityAdapter.poll() not implemented (Task 5)",
        retryable: false,
      },
    };
  },
};
