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
// Env vars. Provider API keys are NEVER in code — Vault/config only.
// REQUIRED: worker fails fast at startup if any are missing.
// EXPECTED: warned at startup if missing; lazily checked at adapter call time
// (so the worker can still drain Anthropic-only sessions even if other provider
// keys aren't configured yet).
// ──────────────────────────────────────────────────────────────────────────
export const REQUIRED_ENV = [
  "SUPABASE_URL",
  // RLS-bypassing service credential. New-format-only project → the project's sb_secret_
  // key, set under a non-reserved name (SUPABASE_* are auto-managed, not overridable).
  // The legacy SUPABASE_SERVICE_ROLE_KEY does NOT bypass RLS here.
  "THEO_DISPATCH_SECRET_KEY",
  // Shared secret the pg_cron drainer must present in the `apikey` header. The
  // worker runs verify_jwt=false (the platform does not guard it), so this is
  // the worker's own door lock — see lib/auth.ts. REQUIRED so the worker fails
  // to boot rather than running unguarded if it is ever unset.
  "WORKER_INVOKE_KEY",
] as const;

export const EXPECTED_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "PERPLEXITY_API_KEY",
] as const;

export const WORKER_INSTANCE_NAME = "theo-dispatch-worker";
// The worker's instance_id is resolved from the instances table by name at
// startup. If absent, the worker auto-registers (instance_type='external')
// — same pattern as the cc instance, but worker-owned.

// ──────────────────────────────────────────────────────────────────────────
// SPEND GUARD — pricing + daily budget. (See lib/budget.ts for the gate.)
//
// provider_rate_limit PACES submits per minute but is NOT a cost ceiling. The
// guard computes engine_dispatch.cost_usd from token counts at finalize, sums
// today's spend, and blocks new SUBMITS (never polls) past a daily USD ceiling.
//
// Prices are USD per 1M tokens and are ESTIMATES FOR THE GUARD, not billing.
// They deliberately exclude per-search / reasoning surcharges (deep-research and
// search SKUs cost more than tokens alone), so treat the ceiling as a floor on
// real spend. CONFIRM every value against the current provider price sheet
// before relying on it. Unpriced engines fall back to DEFAULT_PRICE_PER_MTOK,
// set high so an unknown engine fails safe (over-counts → stops sooner).
// ──────────────────────────────────────────────────────────────────────────
export const DEFAULT_PRICE_PER_MTOK = { input: 15, output: 75 } as const; // opus-tier fallback

export const PRICE_PER_MTOK: Record<EngineName, { input: number; output: number }> = {
  "anthropic-claude-opus-4-8":       { input: 15,   output: 75 },  // CONFIRM
  "anthropic-claude-sonnet-4-6":     { input: 3,    output: 15 },  // CONFIRM
  "perplexity-sonar-pro":            { input: 3,    output: 15 },  // CONFIRM (+ per-search fees not modelled)
  "perplexity-sonar-reasoning-pro":  { input: 2,    output: 8 },   // CONFIRM
  "perplexity-sonar-deep-research":  { input: 2,    output: 8 },   // CONFIRM (+ reasoning/search fees not modelled)
  "gemini-3-1-pro":                  { input: 2,    output: 12 },  // CONFIRM
  "gemini-2-5-pro":                  { input: 1.25, output: 10 },  // CONFIRM
  "gemini-deep-research":            { input: 2,    output: 12 },  // CONFIRM (+ research surcharge not modelled)
  "openai-gpt-5-search":             { input: 2,    output: 8 },   // CONFIRM (+ search tool fees not modelled)
  "openai-gpt-4o-search":            { input: 2.5,  output: 10 },  // CONFIRM
  "openai-o3-deep-research":         { input: 10,   output: 40 },  // CONFIRM
  "openai-o4-mini-deep-research":    { input: 1.1,  output: 4.4 }, // CONFIRM
};

export function priceForEngine(engine: EngineName): { input: number; output: number } {
  return PRICE_PER_MTOK[engine] ?? DEFAULT_PRICE_PER_MTOK;
}

// Daily spend ceiling in USD. worker_control.daily_budget_usd overrides this at
// runtime (no redeploy); env WORKER_DAILY_BUDGET_USD overrides the default; else 25.
export function dailyBudgetUsd(): number {
  const v = Number(Deno.env.get("WORKER_DAILY_BUDGET_USD"));
  return Number.isFinite(v) && v > 0 ? v : 25;
}
