// live-report — the recompute endpoint (SP 2e97d74e backend lane, baton 8fd62383;
// contract MR d7b75a76 v1.1). Given a session and a per-HOUSE weight/exclusion vector,
// it returns the recomputed report: findings (FORMULA cells), the locked sources +
// houses (LOCKED cells), and the inputs (INPUT cells) — the grounding object the surface
// renders. The recompute is f(grounding, weights) over the anchored claim spine; this EF
// is the read+compute+record half.
//
// Access control is at the CLOUDFLARE EDGE, exactly like theo-render-data: the surface is
// Cloudflare-gated, talks to Supabase with the publishable key, and this EF is
// UUID-addressed (session_id is the capability), verify_jwt=false, service-role read.
//
// Request (POST JSON):
//   { session_id, weights?: {house_key->weight}, exclusions?: [house_key],
//     reset?: bool, scope?: {...}, client_context?: {actor, reason} }
//   No weights/exclusions, or reset=true -> the as-delivered v1 baseline.
// Response: { report_id, base_snapshot_id, version, findings[], inputs, houses[], sources[],
//             baseline_snapshot_id, persisted }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { loadBaseline, nextVersion, persistVersion } from "./lib/snapshot.ts";
import { recompute } from "./lib/recompute.ts";
import type { RecomputeInputs } from "./lib/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ID_RE = /^[0-9a-f-]{4,36}$/i;

function env(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  let sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
  if (!ID_RE.test(sessionId)) return json({ error: "session_id must be a UUID or hex prefix" }, 400);

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  // Prefix-tolerant resolve (sessionId is ID_RE-validated hex), mirroring theo-render-data.
  const resolved = await supabase.rpc("execute_raw_sql", {
    query: `SELECT id FROM theo_session WHERE id::text LIKE '${sessionId}%' LIMIT 2`,
  });
  if (resolved.error) return json({ error: `resolve: ${resolved.error.message}` }, 500);
  const matches = (resolved.data ?? []) as Array<{ id: string }>;
  if (matches.length === 0) return json({ error: `no session with id/prefix '${sessionId}'` }, 404);
  if (matches.length > 1) return json({ error: `ambiguous prefix '${sessionId}' — supply more characters` }, 400);
  sessionId = matches[0].id;

  // Build inputs from the request.
  const inputs: RecomputeInputs = {
    weights: (body.weights && typeof body.weights === "object" ? body.weights : {}) as Record<string, number>,
    exclusions: Array.isArray(body.exclusions) ? (body.exclusions as string[]) : [],
    reset: body.reset === true,
    scope: (body.scope && typeof body.scope === "object" ? body.scope : { whole_report: true }) as RecomputeInputs["scope"],
    client_context: (body.client_context && typeof body.client_context === "object"
      ? body.client_context
      : undefined) as RecomputeInputs["client_context"],
  };

  let baseline;
  try {
    baseline = await loadBaseline(supabase, sessionId);
  } catch (e) {
    return json({ error: `grounding: ${(e as Error).message}` }, 500);
  }
  const { grounding, baselineId, baseline: baselineResult } = baseline;

  const hasInputs = Object.keys(inputs.weights).length > 0 || inputs.exclusions.length > 0;

  // Initial render OR reset -> the as-delivered baseline (bit-for-bit; deterministic).
  if (inputs.reset || !hasInputs) {
    return json({
      ...baselineResult,
      houses: grounding.houses,
      sources: grounding.sources,
      baseline_snapshot_id: baselineId,
      persisted: baselineId !== null,
    });
  }

  // Recalibrate: derive a new version from the frozen baseline grounding, record it.
  const version = await nextVersion(supabase, sessionId);
  const result = recompute(grounding, inputs, version);
  const persisted = await persistVersion(supabase, sessionId, baselineId, grounding, inputs, result);

  return json({
    ...result,
    houses: grounding.houses,
    sources: grounding.sources,
    baseline_snapshot_id: baselineId,
    persisted,
  });
});
