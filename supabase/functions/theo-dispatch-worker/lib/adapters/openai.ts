// OpenAI adapter — current-practitioner / web + deep-research.
//
// Two surfaces, model-dependent (Argos msg d56e3525):
//
//   SYNC chat models (search-grounded): gpt-5-search-api, gpt-4o-search-preview
//     submit() returns {done:true, response} via chat/completions.
//     POST https://api.openai.com/v1/chat/completions
//     Body: { model, messages: [{role:"user", content: prompt}], ... }
//
//   ASYNC deep-research models: o3-deep-research, o4-mini-deep-research
//     submit() returns {done:false, job_ref} via Responses API with background=true.
//     POST https://api.openai.com/v1/responses
//     Body: { model, input, background: true, ... }
//     poll() GET https://api.openai.com/v1/responses/{id}
//
// Auth: Authorization: Bearer $OPENAI_API_KEY (both endpoints)
//
// Stub: Phase-1 build (Task 5) fills the bodies.

import type { Adapter, AdapterPollResult, AdapterRequest, AdapterSubmitResult } from "../types.ts";

// Substring match — adapter decides which surface to use based on model name.
// (Engine config also carries async flag; this is the adapter's secondary check.)
function isDeepResearch(model: string): boolean {
  return model.includes("deep-research");
}

export const openaiAdapter: Adapter = {
  provider: "openai",

  async submit(req: AdapterRequest): Promise<AdapterSubmitResult> {
    // TODO (Task 5):
    if (isDeepResearch(req.model)) {
      //  ASYNC PATH (Responses API):
      //  - POST /v1/responses with { model, input: prompt, background: true }
      //  - 200 returns { id, status: "queued" | "in_progress" | ... }
      //  - return { ok:true, done:false, job_ref: id }
      //  - on 429: rate_limit with retry-after
      //  - on >=500: api_error retryable:true
    } else {
      //  SYNC PATH (chat/completions):
      //  - POST /v1/chat/completions with { model, messages: [{role:"user", content: prompt}], max_completion_tokens? }
      //  - Parse choices[0].message.content -> AdapterResponse.text
      //  - choices[0].message.annotations[*] type:"url_citation" -> Source[]
      //  - return { ok:true, done:true, response }
    }
    void req;
    return {
      ok: false,
      error: {
        kind: "api_error",
        message: "openaiAdapter.submit() not implemented (Task 5)",
        retryable: false,
      },
    };
  },

  async poll(_job_ref: string): Promise<AdapterPollResult> {
    // TODO (Task 5):
    //  - GET /v1/responses/{job_ref}
    //  - status="queued" | "in_progress"  -> { status: "in_progress" }
    //  - status="completed"               -> parse output/output_text -> response; { status:"completed", response }
    //  - status="failed"                  -> { status:"failed", error: from response.error }
    //  - status="incomplete"              -> { status:"partial", response, reason: response.incomplete_details.reason }
    //  - status="cancelled"               -> { status:"failed", error:{kind:"other", message:"cancelled"} }
    return {
      status: "failed",
      error: {
        kind: "api_error",
        message: "openaiAdapter.poll() not implemented (Task 5)",
        retryable: false,
      },
    };
  },
};
