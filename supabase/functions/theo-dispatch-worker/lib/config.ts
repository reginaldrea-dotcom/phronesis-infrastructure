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
// Lock lease (baton 143072ab #4). A session's claim is leased for this long;
// claim_theo_session reclaims a lock older than the lease (dead holder). MUST
// exceed the EF ~150s hard tick ceiling so an overlapping cron fire never steals
// a live lock; 5 min gives ~2x margin while bounding any hard-kill strand.
// Passed to claim_theo_session(p_lease_seconds) so the lease lives in one place.
export const LOCK_LEASE_SECONDS = 300;

// ──────────────────────────────────────────────────────────────────────────
// Bounded submit retry (baton 143072ab #2). A retryable submit failure (e.g. a
// 429 from a throttled engine) leaves the row 'pending' for a later tick — but
// only up to MAX_SUBMIT_ATTEMPTS, after which the row is failed TERMINALLY so a
// persistently-throttled engine can no longer hang the session. Between retries
// the worker backs off exponentially (base * 2^(n-1), capped) so it neither
// hammers the provider nor burns rate budget on a row it can't yet submit.
export const MAX_SUBMIT_ATTEMPTS = 6;
const SUBMIT_BACKOFF_BASE_MS = 30 * 1000;   // first retry waits ~30s
const SUBMIT_BACKOFF_CAP_MS = 8 * 60 * 1000; // never wait more than 8 min between retries

// Backoff before the next submit of a row that has already failed `attempts`
// times. attempts=0 => no wait (first ever submit). With base 30s/cap 8m the
// six spaced retries span ~tens of minutes before the terminal ceiling, leaving
// ample room for a transient throttle to clear without an unbounded hang.
export function submitBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(SUBMIT_BACKOFF_BASE_MS * 2 ** (attempts - 1), SUBMIT_BACKOFF_CAP_MS);
}

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
  // Standard Gemini models use generateContent (sync) + googleSearch grounding.
  // The adapter attaches google_search to every request.
  "gemini-deep-research": {
    provider: "gemini",
    // DEC e2955403 / board 6cbd8107 (Gemini refinement dafaf1c4, Theophrastus):
    // the Gemini deep_research role re-plumbs to a STABLE generateContent model +
    // google_search — NOT a preview deep-research SKU. The prior undated
    // "deep-research-pro-preview" 404'd ("not found … or not supported for
    // generateContent"): the deep-research-*-preview family is listed in models.list
    // but is NOT callable via generateContent (a separate async/agent surface), so
    // it is eval-gated on a Heph smoke before any adoption — not a config swap.
    // Production = gemini-2.5-pro, version-pinned (NOT the floating gemini-pro-latest
    // alias — a moving alias breaks research reproducibility). gemini-2.5-pro is
    // already fixed (googleSearch) and smoke-verified grounded (B1: 11 sources).
    // This makes the gemini deep_research role SYNC; the A1a zero-source honesty
    // guard (tick.ts finalizeResponse) still applies to role==='deep_research'.
    model: "gemini-2.5-pro",
    async: false,
    // Conservative tier, mirrors the gemini-2-5-pro engine (same model/key); raise
    // once the key's real rate tier is confirmed. The bounded-submit-retry ceiling
    // is the structural backstop regardless.
    rate_limit: { rpm: 10, rpd: 1000 },
    defaults: { timeout_ms: 240_000 },
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
    // rpm CONSERVATIVE BY DESIGN (baton 143072ab #2). A freshly-funded key sits on
    // a low rate tier; the prior 150 rpm over-submitted and drew a 429 storm (~78
    // on the dashboard) during Angelia arc 1. Set low so pacing fails toward
    // under-use, never a throttle storm. CONFIRM against the key's real tier and
    // raise once known — the bounded-retry ceiling (MAX_SUBMIT_ATTEMPTS) is the
    // structural backstop regardless of this number.
    rate_limit: { rpm: 10, rpd: 1000 },
    defaults: { timeout_ms: 240_000 },
  },

  // ── OpenAI ──────────────────────────────────────────────────────────────
  // ROUTED BY ROLE in the adapter (B1-oai 9c0b18ed), all via the Responses API + web_search:
  // deep_research engines ASYNC (background submit/poll, safe against the ~150s EF 504);
  // current_web engines SYNC. Models repointed OFF the SKUs that shut down 2026-07-23
  // (o3/o4-mini-deep-research, gpt-4o-search-preview; gpt-5-search-api never existed), per Theo's
  // roster. NOTE: engine KEYS kept as-is for now (renaming touches ROLE_TO_ENGINE + enqueue refs;
  // deferred to Theo) — so the keys no longer name their model; the model field below is authoritative.
  "openai-o3-deep-research": {
    provider: "openai",
    model: "gpt-5.5-pro",               // repointed from o3-deep-research (deprecated 2026-07-23); deep_research
    async: true,
    poll_staleness_ms: 40 * 60 * 1000,  // 40 min ceiling
    rate_limit: { rpm: 500 },           // Tier-1 baseline; confirm post-deploy
    defaults: { timeout_ms: 60_000 },
  },
  "openai-o4-mini-deep-research": {
    provider: "openai",
    model: "gpt-5.4",                   // repointed from o4-mini-deep-research (deprecated); Theo's deep cost-cap option
    async: true,
    poll_staleness_ms: 30 * 60 * 1000,  // 30 min ceiling
    rate_limit: { rpm: 500 },
    defaults: { timeout_ms: 60_000 },
  },
  "openai-gpt-5-search": {
    provider: "openai",
    model: "gpt-5.4-mini",              // repointed from gpt-5-search-api (never existed); current_web primary
    async: false,
    rate_limit: { rpm: 500 },
    defaults: { timeout_ms: 240_000 },
  },
  "openai-gpt-4o-search": {
    provider: "openai",
    model: "gpt-5.4-mini",              // repointed from gpt-4o-search-preview (deprecated 2026-07-23); current_web alt
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
  "gemini-deep-research":            { input: 1.25, output: 10 },  // now gemini-2.5-pro (DEC e2955403) — mirrors gemini-2-5-pro; CONFIRM
  "openai-gpt-5-search":             { input: 2,    output: 8 },   // now gpt-5.4-mini (current_web) — placeholder, price CONFIRM
  "openai-gpt-4o-search":            { input: 2.5,  output: 10 },  // now gpt-5.4-mini (current_web alt) — placeholder, price CONFIRM
  "openai-o3-deep-research":         { input: 10,   output: 40 },  // now gpt-5.5-pro (deep_research) — placeholder, price CONFIRM
  "openai-o4-mini-deep-research":    { input: 1.1,  output: 4.4 }, // now gpt-5.4 (deep cost-cap) — placeholder, price CONFIRM
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
