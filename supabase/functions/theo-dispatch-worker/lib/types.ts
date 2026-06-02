// Adapter contract for theo-dispatch-worker.
//
// Three of the four providers (gemini / openai-deep-research / perplexity)
// are async submit-poll: the worker submits on one tick and polls on later
// ticks (Deep Research jobs run 3-30 minutes; one cron tick is ~30s).
// Only Anthropic is sync. The contract is uniform — submit() returns either
// {done:true, response} (sync fast-path) or {done:false, job_ref} (async),
// and poll(job_ref) advances dispatched jobs to completed/partial/failed.
//
// Argos's research (msg d56e3525, 2 Jun 2026) drove this split; engine_dispatch
// landed two carry columns (provider_job_ref, dispatched_at) for the worker
// to persist state across ticks.

export type ProviderName = "anthropic" | "openai" | "gemini" | "perplexity";

// MST research roles (artifact 444eabc0). Roles are stable; the engine fulfilling
// each role is config-driven (config.ts) so a provider/model swap is data, not code.
export type Role =
  | "deep_source"      // primary-source verification, citation chase   (Perplexity deep-research)
  | "deep_research"    // multi-source comprehensive integration        (Gemini deep-research)
  | "current_web"      // current practitioner / market / news          (OpenAI search-grounded)
  | "synthesist";      // cross-check / fourth voice                    (Claude)

// EngineName is a canonical string written to engine_dispatch.engine_name.
// It identifies a (provider, model, async-flag, params) tuple via ENGINES.
// Example: "perplexity-sonar-deep-research", "gemini-deep-research".
export type EngineName = string;

export interface AdapterRequest {
  prompt: string;          // rendered prompt, persisted as engine_dispatch.prompt_sent
  role: Role;              // semantic role (informational; adapter may use as a hint)
  model: string;           // resolved provider model id (from config)
  opts?: AdapterOpts;
}

export interface AdapterOpts {
  max_tokens?: number;
  temperature?: number;
  timeout_ms?: number;
  // Provider-specific overrides ride here untyped; adapter decides what to use.
  provider_specific?: Record<string, unknown>;
}

export interface AdapterResponse {
  text: string;            // primary content (engine_dispatch consumer reads this)
  sources: Source[];       // normalised citations (provider-specific shape flattened)
  labels: Label[];         // engine-level annotations (confidence, vendor-data, etc.)
  usage: AdapterUsage;
  raw: unknown;            // raw provider response, persisted as engine_dispatch.response_raw
}

export interface Source {
  url?: string;
  title?: string;
  snippet?: string;
  retrieved_at?: string;   // ISO timestamp if the provider supplies one
}

export interface Label {
  key: string;             // e.g. "confidence", "vendor_data", "search_grounded"
  value: string;
}

export interface AdapterUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;       // adapter computes from token counts + provider pricing
}

// Failure shape — providers never throw on protocol failures (rate limit,
// timeout, partial). Programmer errors still throw; the worker catches and
// records as kind="api_error".
export interface AdapterError {
  kind: "rate_limit" | "timeout" | "api_error" | "auth" | "invalid_input" | "partial" | "other";
  message: string;                   // populates engine_dispatch.error_detail
  retryable: boolean;
  retry_after_ms?: number;           // honoured by the worker's pacing logic
  http_status?: number;
  raw?: unknown;
}

// ──────────────────────────────────────────────────────────────────────────
// submit() result
//
// Sync provider (Anthropic):
//   on success  -> { ok:true, done:true, response }
//   on failure  -> { ok:false, error }
//
// Async provider (Gemini DR / OpenAI deep-research / Perplexity sonar-deep-research):
//   on submitted        -> { ok:true, done:false, job_ref }   (worker writes provider_job_ref + dispatched_at)
//   if returned inline  -> { ok:true, done:true, response }   (rare — short jobs may return immediately)
//   on submission fail  -> { ok:false, error }
//
// The worker maps submit() results to engine_dispatch transitions:
//   done:true + ok          -> status='completed' (or 'partial' if response carries truncation label)
//   done:false              -> status='dispatched' + provider_job_ref + dispatched_at
//   ok:false                -> status='failed' (unless retryable; then leave 'pending' for next tick)
// ──────────────────────────────────────────────────────────────────────────
export type AdapterSubmitResult =
  | { ok: true; done: true;  response: AdapterResponse }
  | { ok: true; done: false; job_ref: string }
  | { ok: false; error: AdapterError };

// ──────────────────────────────────────────────────────────────────────────
// poll() result — called only on async providers, only for rows in 'dispatched'.
//
//   in_progress              -> leave row in 'dispatched', try again next tick
//                                 (worker enforces staleness ceiling via dispatched_at)
//   completed                -> status='completed' + response_raw + usage
//   partial                  -> status='partial' + response_raw (truncation noted)
//   failed                   -> status='failed' + error_detail
// ──────────────────────────────────────────────────────────────────────────
export type AdapterPollResult =
  | { status: "in_progress" }
  | { status: "completed"; response: AdapterResponse }
  | { status: "partial";   response: AdapterResponse; reason: string }
  | { status: "failed";    error: AdapterError };

export interface Adapter {
  provider: ProviderName;
  // submit() must be implemented by every adapter.
  submit(req: AdapterRequest): Promise<AdapterSubmitResult>;
  // poll() is only meaningful for async providers. Sync adapters (Anthropic)
  // should never have poll() called — they always return done:true from submit().
  // Optional in the type so sync adapters don't need a stub.
  poll?(job_ref: string): Promise<AdapterPollResult>;
}

// Engine config: a canonical engine name -> (provider, model, async-flag, defaults, pacing).
// Lives in config.ts. Role -> EngineName lookup also in config.ts.
export interface EngineConfig {
  provider: ProviderName;
  model: string;
  // True if the worker must submit-then-poll across ticks; false for sync providers.
  // Drives whether the worker writes provider_job_ref + dispatched_at and schedules a poll.
  async: boolean;
  // Provider-specific staleness ceiling (ms since dispatched_at). After this,
  // the worker marks the row 'failed' with error_detail noting the timeout —
  // protects against hung-poll bugs (e.g. Perplexity's IN_PROGRESS-forever case).
  // Defaults applied at runtime if unset.
  poll_staleness_ms?: number;
  // Pacing hints; worker writes to provider_rate_limit and respects these.
  // Provider-imposed limits ALWAYS win (via 429 + retry-after); these are the
  // worker's pre-flight caps when the provider doesn't tell us first.
  rate_limit?: {
    rpm?: number;        // requests per minute (PACES SUBMITS, not polls; polls are free)
    rpd?: number;        // requests per day
    tpm?: number;        // tokens per minute (input + output combined)
  };
  defaults?: AdapterOpts;
  // Fallback engines tried in order if primary returns retryable failure.
  // Not used in Phase 1 (notify-tier); Theo can manually re-enqueue. Scaffolded for Phase 2+.
  fallback?: EngineName[];
}
