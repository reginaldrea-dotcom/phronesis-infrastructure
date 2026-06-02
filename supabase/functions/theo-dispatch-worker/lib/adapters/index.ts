// Adapter registry + dispatchers (submit / poll).
//
// The worker never imports a provider adapter directly. It calls submitAdapter
// for pending rows and pollAdapter for dispatched rows. This module resolves
// engine -> provider -> adapter.
//
// Adding a new provider:
//   1. Implement Adapter in a new file (submit + optional poll if async).
//   2. Add it to ADAPTERS below.
//   3. Add engines that use it to config.ts ENGINES registry (set async flag).
//   4. (Optional) point a role at one of those engines via ROLE_TO_ENGINE.

import type {
  Adapter,
  AdapterPollResult,
  AdapterRequest,
  AdapterSubmitResult,
  EngineName,
  ProviderName,
} from "../types.ts";
import { engineConfig } from "../config.ts";

import { anthropicAdapter } from "./anthropic.ts";
import { openaiAdapter } from "./openai.ts";
import { geminiAdapter } from "./gemini.ts";
import { perplexityAdapter } from "./perplexity.ts";

const ADAPTERS: Record<ProviderName, Adapter> = {
  anthropic:  anthropicAdapter,
  openai:     openaiAdapter,
  gemini:     geminiAdapter,
  perplexity: perplexityAdapter,
};

export function adapterFor(provider: ProviderName): Adapter {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`No adapter for provider: ${provider}`);
  return a;
}

// ──────────────────────────────────────────────────────────────────────────
// Worker entry: submit a request for one engine.
//
// Sync engines (Anthropic, search-grounded chat models, non-DR Gemini) return
// {done:true, response} — the worker writes the response and marks the row
// 'completed' in the same tick.
//
// Async engines (Gemini DR, OpenAI deep-research, Perplexity sonar-deep-research)
// return {done:false, job_ref} — the worker writes provider_job_ref + dispatched_at,
// marks the row 'dispatched', and polls on later ticks.
// ──────────────────────────────────────────────────────────────────────────
export async function submitAdapter(
  engine: EngineName,
  req: Omit<AdapterRequest, "model"> & { model?: string },
): Promise<AdapterSubmitResult> {
  const cfg = engineConfig(engine);
  const adapter = adapterFor(cfg.provider);

  const merged: AdapterRequest = {
    prompt: req.prompt,
    role: req.role,
    model: req.model ?? cfg.model,
    opts: { ...cfg.defaults, ...(req.opts ?? {}) },
  };

  return await adapter.submit(merged);
}

// ──────────────────────────────────────────────────────────────────────────
// Worker entry: poll a previously-submitted async job.
//
// Only valid for engines whose config.async === true. Sync adapters either
// omit poll() entirely or throw if called. The worker checks the engine's
// async flag before invoking poll.
// ──────────────────────────────────────────────────────────────────────────
export async function pollAdapter(
  engine: EngineName,
  job_ref: string,
): Promise<AdapterPollResult> {
  const cfg = engineConfig(engine);
  if (!cfg.async) {
    return {
      status: "failed",
      error: {
        kind: "api_error",
        message: `pollAdapter called for sync engine ${engine} — programmer error`,
        retryable: false,
      },
    };
  }
  const adapter = adapterFor(cfg.provider);
  if (!adapter.poll) {
    return {
      status: "failed",
      error: {
        kind: "api_error",
        message: `Adapter ${cfg.provider} marked async but has no poll() — implementation gap`,
        retryable: false,
      },
    };
  }
  return await adapter.poll(job_ref);
}
