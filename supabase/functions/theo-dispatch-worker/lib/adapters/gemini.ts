// Gemini (Google) adapter — deep research / comprehensive synthesis + sync models.
//
// Two surfaces, model-dependent (Argos msg d56e3525):
//
//   ASYNC Deep Research: deep-research-pro-preview
//     Interactions API with background=true; poll via interactions.get.
//     Exact endpoint path TBD pending live API confirmation at Task 5 — Google's
//     SKU naming for the Deep Research surface is moving. Likely shape:
//       POST https://generativelanguage.googleapis.com/v1beta/...:generateContent
//            (with longRunning: true) OR /v1beta/interactions
//     CRITICAL: 1 RPM global across tenants — worker MUST serialise submits
//     via provider_rate_limit before invoking this adapter.
//
//   SYNC standard models: gemini-3.1-pro, gemini-2.5-pro, flash variants
//     POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//     Body: { contents: [{parts: [{text: prompt}]}], generationConfig: {...},
//             tools?: [{googleSearchRetrieval: {}}] }
//
// Auth: ?key=$GEMINI_API_KEY  (or x-goog-api-key header)
//
// Stub: Phase-1 build (Task 5) fills the bodies.

import type { Adapter, AdapterPollResult, AdapterRequest, AdapterSubmitResult } from "../types.ts";

function isDeepResearch(model: string): boolean {
  return model.includes("deep-research");
}

export const geminiAdapter: Adapter = {
  provider: "gemini",

  async submit(req: AdapterRequest): Promise<AdapterSubmitResult> {
    // TODO (Task 5):
    if (isDeepResearch(req.model)) {
      //  ASYNC PATH (Interactions API with background=true):
      //  - POST the deep-research endpoint with { contents, background: true } (or whatever
      //    Google's current shape is — confirm from live docs at build time)
      //  - 200 returns { name: "interactions/..." } or { id }
      //  - return { ok:true, done:false, job_ref: <interaction id> }
    } else {
      //  SYNC PATH (generateContent):
      //  - POST /v1beta/models/{model}:generateContent
      //  - Body: { contents: [{parts:[{text: prompt}]}], generationConfig: {...},
      //            tools: [{googleSearchRetrieval:{}}]  // for grounded answers
      //  - Parse candidates[0].content.parts[0].text -> response.text
      //  - groundingMetadata.groundingChunks[].web -> Source[]
      //  - usageMetadata.promptTokenCount / candidatesTokenCount -> AdapterUsage
      //  - return { ok:true, done:true, response }
    }
    void req;
    return {
      ok: false,
      error: {
        kind: "api_error",
        message: "geminiAdapter.submit() not implemented (Task 5)",
        retryable: false,
      },
    };
  },

  async poll(_job_ref: string): Promise<AdapterPollResult> {
    // TODO (Task 5):
    //  - GET the interaction by name/id (e.g. /v1beta/{name})
    //  - done:false   -> { status: "in_progress" }
    //  - done:true, response field present -> parse to AdapterResponse, { status:"completed", response }
    //  - error field present -> { status:"failed", error: from error.code/error.message }
    //  - Deep Research may return citations under a different field name
    //    (attribution[] / sources[]); confirm from a live response sample.
    return {
      status: "failed",
      error: {
        kind: "api_error",
        message: "geminiAdapter.poll() not implemented (Task 5)",
        retryable: false,
      },
    };
  },
};
