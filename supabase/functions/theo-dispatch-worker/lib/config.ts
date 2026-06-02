// Worker config: engine registry + role -> engine mapping.
//
// "Capability below the model; the provider is a replaceable adapter."
// (memory: llm-neutral-infrastructure)
// All provider/model specifics live HERE — adapter code is provider-shape-aware
// but content-agnostic. Re-pointing a role to a new model is a one-line edit.
//
// Async flag per engine drives worker submit-poll behaviour (Argos's research,
// msg d56e3525). Rate limits PACE SUBMITS, not polls (polls are free).
// Where the provider's quota is GLOBAL across tenants (e.g. Gemini Deep Research
// at 1 RPM), the worker's provider_rate_limit table keys on (provider, model, bucket)
// and serialises across all sessions.

import type { EngineConfig, EngineName, Role } from "./types.ts";

// Default staleness ceilings — how long the worker keeps polling before
// marking a dispatched row 'failed' with a timeout error_detail. Per-engine
// override goes on EngineConfig.poll_staleness_ms.
export const DEFAULT_POLL_STALENESS_MS = 45 * 60 * 1000;  // 45 min

// ──────────────────────────────────────────────────────────────────────────
// Engines: canonical name -> provider+model+defaults
// Naming convention: <provider>-<model-family>[-<variant>]
// engine_dispatch.engine_name stores this canonical string.
// ──────────────────────────────────────────────────────────────────────────
export const ENGINES: Record<EngineName, EngineConfig> = {
  // ── Perplexity ──────────────────────────────────────────────────────────
  // sonar-deep-research uses the ASYNC endpoint (/async/chat/completions);
  // sonar-pro and sonar-reasoning-pro are SYNC (/chat/completions).
  "perplexity-sonar-deep-research": {
    provider: "perplexity",
    model: "sonar-deep-research",
    async: true,
    poll_staleness_ms: 45 * 60 * 1000,  // 45 min; long deep-research jobs
    defaults: { timeout_ms: 60_000 },   // submit/poll request timeout; total job time bounded by staleness
  },
  "perplexity-sonar-pro": {
    provider: "perplexity",
    model: "sonar-pro",
    async: false,
    defaults: { timeout_ms: 120_000 },
  },
  "perplexity-sonar-reasoning-pro": {
    provider: "perplexity",
    model: "sonar-reasoning-pro",
    async: false,
    defaults: { timeout_ms: 180_000 },
  },

  // ── Gemini (Google) ─────────────────────────────────────────────────────
  // Deep Research goes via the Interactions API with background=true; standard
  // Gemini models use generateContent (sync). The adapter branches on engine.
  "gemini-deep-research": {
    provider: "gemini",
    // Drive spec §5: "Deep Research Pro Preview" — API equivalent of browser
    // Gemini Deep Research. 1 RPM global across tenants is the binding constraint;
    // worker serialises submits via provider_rate_limit before adapter call.
    // Model id is TBD pending live API confirmation at Task 5 (Google's current
    // SKU naming for this surface).
    model: "deep-research-pro-preview",
    async: true,
    poll_staleness_ms: 35 * 60 * 1000,  // 35 min ceiling
    rate_limit: { rpm: 1, tpm: 500_000, rpd: 1440 },
    defaults: { timeout_ms: 60_000 },
  },
  "gemini-3-1-pro": {
    provider: "gemini",
    model: "gemini-3.1-pro",
    async: false,
    rate_limit: { rpm: 25, tpm: 2_000_000, rpd: 250 },
    defaults: { timeout_ms: 240_000 },
  },
  "gemini-2-5-pro": {
    provider: "gemini",
    model: "gemini-2.5-pro",
    async: false,
    rate_limit: { rpm: 150, rpd: 1000 },
    defaults: { timeout_ms: 240_000 },
  },

  // ── OpenAI ──────────────────────────────────────────────────────────────
  // Deep-research SKUs (o3-deep-research, o4-mini-deep-research) go via the
  // Responses API with background=true (ASYNC submit-poll, per Argos d56e3525).
  // Search-grounded chat models (gpt-5-search-api, gpt-4o-search-preview) are
  // SYNC via chat/completions and serve the current_web role.
  "openai-o3-deep-research": {
    provider: "openai",
    model: "o3-deep-research",
    async: true,
    poll_staleness_ms: 40 * 60 * 1000,  // 40 min ceiling
    rate_limit: { rpm: 500 },           // Tier-1 baseline; confirm post-deploy
    defaults: { timeout_ms: 60_000 },
  },
  "openai-o4-mini-deep-research": {
    provider: "openai",
    model: "o4-mini-deep-research",
    async: true,
    poll_staleness_ms: 30 * 60 * 1000,  // 30 min ceiling — smaller model, faster
    rate_limit: { rpm: 500 },
    defaults: { timeout_ms: 60_000 },
  },
  "openai-gpt-5-search": {
    provider: "openai",
    model: "gpt-5-search-api",
    async: false,
    rate_limit: { rpm: 500 },
    defaults: { timeout_ms: 240_000 },
  },
  "openai-gpt-4o-search": {
    provider: "openai",
    model: "gpt-4o-search-preview",
    async: false,
    rate_limit: { rpm: 500 },
    defaults: { timeout_ms: 240_000 },
  },

  // ── Anthropic (Claude) ──────────────────────────────────────────────────
  // Always sync. Same models api-prime-invoke uses; lib/models.ts is precedent.
  // Claude here is the synthesist / fourth voice (web-search via tool use later).
  "anthropic-claude-opus-4-8": {
    provider: "anthropic",
    model: "claude-opus-4-8",
    async: false,
    defaults: { max_tokens: 32_000, timeout_ms: 240_000 },
  },
  "anthropic-claude-sonnet-4-6": {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    async: false,
    defaults: { max_tokens: 32_000, timeout_ms: 240_000 },
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Role -> primary engine. Theo's enqueue may override per-question (see §5
// of MR 5944ef52: divergence between engines is where the most useful
// material is; the role mapping is the default, not a constraint).
// ──────────────────────────────────────────────────────────────────────────
export const ROLE_TO_ENGINE: Record<Role, EngineName> = {
  deep_source:   "perplexity-sonar-deep-research",
  deep_research: "gemini-deep-research",
  current_web:   "openai-gpt-5-search",
  synthesist:    "anthropic-claude-opus-4-8",
};

// ──────────────────────────────────────────────────────────────────────────
// Resolvers (resolve at enqueue time so engine_dispatch.engine_name is durable
// and survives later config changes).
// ──────────────────────────────────────────────────────────────────────────
export function engineForRole(role: Role): EngineName {
  return ROLE_TO_ENGINE[role];
}

export function engineConfig(engine: EngineName): EngineConfig {
  const cfg = ENGINES[engine];
  if (!cfg) throw new Error(`Unknown engine: ${engine}`);
  return cfg;
}

export function pollStalenessMs(engine: EngineName): number {
  return engineConfig(engine).poll_staleness_ms ?? DEFAULT_POLL_STALENESS_MS;
}

// ──────────────────────────────────────────────────────────────────────────
// Required env vars. Worker fails fast at startup if any are missing.
// Provider API keys are NEVER in code — Vault/config only (clone-readiness gate).
// ──────────────────────────────────────────────────────────────────────────
export const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "PERPLEXITY_API_KEY",
] as const;

export const WORKER_INSTANCE_NAME = "theo-dispatch-worker";
// The worker's instance_id is resolved from the instances table by name at
// startup. If absent, the worker auto-registers (instance_type='external')
// — same pattern as the cc instance, but worker-owned.
