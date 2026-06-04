// Spend guard — stops a runaway or mis-queued batch from spending without bound.
//
// provider_rate_limit (lib/pacing.ts) caps SUBMITS per minute but is not a cost
// ceiling: a large or mistaken batch would still spend up to that per-minute cap
// every tick, indefinitely. This module adds two pre-submit gates the worker
// checks ONCE per tick:
//   1. paused flag  — operator kill switch (worker_control.paused), toggled in
//                     data so it takes effect without a redeploy or unscheduling cron.
//   2. daily budget — today's actual recorded spend vs a USD ceiling.
//
// Spend is read from engine_dispatch.cost_usd, which the worker now persists at
// finalize time for BOTH sync and async engines (computeCostUsd, called from
// tick.ts). Only SUBMITS are gated — once a job is dispatched the cost is already
// committed, so polls always run (we still want to collect paid-for results).

import type { SupabaseClient } from "./supabase.ts";
import type { AdapterUsage, EngineName } from "./types.ts";
import { dailyBudgetUsd, priceForEngine } from "./config.ts";

// Cost for one completed/partial response, USD. Null when there are no tokens to
// price (nothing landed). Estimate only — see config.ts pricing caveats.
export function computeCostUsd(engine: EngineName, usage: AdapterUsage): number | null {
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  if (inTok === 0 && outTok === 0) return null;
  const p = priceForEngine(engine);
  const cost = (inTok / 1_000_000) * p.input + (outTok / 1_000_000) * p.output;
  return Math.round(cost * 1e6) / 1e6; // 6dp; cents-fraction precision is plenty
}

export interface BudgetStatus {
  paused: boolean;
  spent_usd: number;
  limit_usd: number;
  over_budget: boolean;
  block_submits: boolean;                                   // paused || over_budget
  reason?: "paused" | "daily_budget_exhausted";
  note: string | null;                                      // operator note from worker_control
}

function dayBucketISO(now: Date = new Date()): string {
  const b = new Date(now);
  b.setUTCHours(0, 0, 0, 0);
  return b.toISOString();
}

export async function getBudgetStatus(supabase: SupabaseClient): Promise<BudgetStatus> {
  // Operator control row (singleton, id=true). Absent/unreadable => not paused,
  // env/default budget. We fail OPEN on a missing control row (so the worker
  // keeps draining) but the daily ceiling still bounds spend.
  let paused = false;
  let limitOverride: number | null = null;
  let note: string | null = null;
  const ctl = await supabase
    .from("worker_control")
    .select("paused, daily_budget_usd, note")
    .eq("id", true)
    .maybeSingle();
  if (!ctl.error && ctl.data) {
    paused = ctl.data.paused === true;
    limitOverride = typeof ctl.data.daily_budget_usd === "number" ? ctl.data.daily_budget_usd : null;
    note = (ctl.data.note as string | null) ?? null;
  }
  const limit = limitOverride ?? dailyBudgetUsd();

  // Today's actual recorded spend (UTC day). Historical rows with NULL cost_usd
  // (written before this guard) are ignored.
  let spent = 0;
  const read = await supabase.rpc("execute_raw_sql", {
    query:
      `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent ` +
      `FROM engine_dispatch ` +
      `WHERE cost_usd IS NOT NULL AND response_received_at >= '${dayBucketISO()}'`,
  });
  if (!read.error && Array.isArray(read.data) && read.data[0]) {
    spent = Number((read.data[0] as { spent: unknown }).spent) || 0;
  }

  const overBudget = spent >= limit;
  const blockSubmits = paused || overBudget;
  return {
    paused,
    spent_usd: spent,
    limit_usd: limit,
    over_budget: overBudget,
    block_submits: blockSubmits,
    reason: paused ? "paused" : overBudget ? "daily_budget_exhausted" : undefined,
    note,
  };
}
