// provider_rate_limit ops — per-(provider, model, minute-bucket) pacing.
//
// PK(provider, model, bucket). The worker:
//   1. canSubmit() — reads current minute bucket + today's bucket sum, decides
//      whether the engine's rate_limit budget is exhausted.
//   2. recordUsage() — UPSERTs the minute bucket with the request + token counts.
//
// Pacing rule: PACE SUBMITS, not polls. Polls are free.
// Provider 429 + retry-after always trumps these pre-flight checks.

import type { SupabaseClient } from "./supabase.ts";
import type { EngineConfig, EngineName } from "./types.ts";
import { engineConfig } from "./config.ts";

function minuteBucketISO(now: Date = new Date()): string {
  const b = new Date(now);
  b.setSeconds(0, 0);
  return b.toISOString();
}

function dayBucketISO(now: Date = new Date()): string {
  const b = new Date(now);
  b.setUTCHours(0, 0, 0, 0);
  return b.toISOString();
}

export interface PacingDecision {
  ok: boolean;
  reason?: "rpm_exhausted" | "rpd_exhausted" | "tpm_exhausted";
  details?: string;
}

export async function canSubmit(
  supabase: SupabaseClient,
  engine: EngineName,
): Promise<PacingDecision> {
  const cfg = engineConfig(engine);
  if (!cfg.rate_limit) return { ok: true };

  const minuteISO = minuteBucketISO();
  const dayISO = dayBucketISO();

  // RPM / TPM — current minute bucket
  if (cfg.rate_limit.rpm !== undefined || cfg.rate_limit.tpm !== undefined) {
    const { data, error } = await supabase
      .from("provider_rate_limit")
      .select("request_count, input_tokens, output_tokens")
      .eq("provider", cfg.provider)
      .eq("model", cfg.model)
      .eq("bucket", minuteISO)
      .maybeSingle();
    if (error) throw new Error(`pacing read (minute) failed: ${error.message}`);
    const rc = data?.request_count ?? 0;
    const tp = (data?.input_tokens ?? 0) + (data?.output_tokens ?? 0);
    if (cfg.rate_limit.rpm !== undefined && rc >= cfg.rate_limit.rpm) {
      return { ok: false, reason: "rpm_exhausted", details: `${rc}/${cfg.rate_limit.rpm} this minute` };
    }
    if (cfg.rate_limit.tpm !== undefined && tp >= cfg.rate_limit.tpm) {
      return { ok: false, reason: "tpm_exhausted", details: `${tp}/${cfg.rate_limit.tpm} tokens this minute` };
    }
  }

  // RPD — sum today's buckets
  if (cfg.rate_limit.rpd !== undefined) {
    const { data, error } = await supabase
      .from("provider_rate_limit")
      .select("request_count")
      .eq("provider", cfg.provider)
      .eq("model", cfg.model)
      .gte("bucket", dayISO);
    if (error) throw new Error(`pacing read (day) failed: ${error.message}`);
    const dailyTotal = (data ?? []).reduce((s, r) => s + (r.request_count as number), 0);
    if (dailyTotal >= cfg.rate_limit.rpd) {
      return { ok: false, reason: "rpd_exhausted", details: `${dailyTotal}/${cfg.rate_limit.rpd} today` };
    }
  }

  return { ok: true };
}

export async function recordUsage(
  supabase: SupabaseClient,
  cfg: EngineConfig,
  args: { input_tokens?: number; output_tokens?: number },
): Promise<void> {
  const minuteISO = minuteBucketISO();
  const it = args.input_tokens ?? 0;
  const ot = args.output_tokens ?? 0;

  // Atomic UPSERT via execute_raw_sql RPC (api-prime-invoke uses the same pattern
  // for its own rate_limit_usage upsert).
  const sql = `
    INSERT INTO provider_rate_limit (provider, model, bucket, request_count, input_tokens, output_tokens)
    VALUES ('${cfg.provider}', '${cfg.model.replace(/'/g, "''")}', '${minuteISO}', 1, ${it}, ${ot})
    ON CONFLICT (provider, model, bucket) DO UPDATE SET
      request_count = provider_rate_limit.request_count + 1,
      input_tokens  = provider_rate_limit.input_tokens  + ${it},
      output_tokens = provider_rate_limit.output_tokens + ${ot};
  `;
  const { error } = await supabase.rpc("execute_raw_sql", { query: sql });
  if (error) throw new Error(`pacing upsert failed: ${error.message}`);
}
