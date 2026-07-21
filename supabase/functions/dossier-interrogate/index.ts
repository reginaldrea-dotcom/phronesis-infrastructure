// dossier-interrogate — the READER-FACING ASK side of the Dossier surface (interrogate surface v2,
// Eames SP 4985c519 / Napoleon baton 629e4723). A reader asks a natural-language question of a Dossier;
// this EF returns the SERVER-VETTED answer produced by trace_interrogation below the model.
//
// WHY an EF: trace_interrogation is the ONLY sanctioned answer path (a sealed interrogate permit refuses
// anything else below the model). The browser cannot hold that permit, and api-prime-invoke returns the
// model's prose + tool_uses, NOT the tool RESULT. So this EF:
//   1. finds the TEMPLATE interrogation seal for the Dossier (an active sibling_grant carrying the
//      trace_interrogation permit whose cargo.theo_session_id is this Dossier) — its existence is what
//      makes the ASK panel available for a Dossier at all;
//   2. mints a FRESH ephemeral seal on a unique session id (same lineage/permit/cargo). Fresh-per-question
//      is deliberate: the read-back is then unambiguous (one row for one session, no cross-reader race),
//      and no reader's thread bleeds into another's;
//   3. drives api-prime-invoke synchronously on that sealed session with the reader's question. The sealed
//      djinn self-drives from its seal scope and answers via trace_interrogation, which writes one
//      interrogation_run row (Aegis-approved permanent audit);
//   4. reads that row back BY session id (race-free) and returns { kept, withheld, vetted_answer } — the
//      answer the front-end renders: kept segments stamped, withheld material shown explicitly;
//   5. revokes the ephemeral seal.
//
// The reader's question is NEVER interpolated into SQL (it goes only into the model's user_message, and the
// read-back is keyed by the minted session id). Only the Dossier's own UUID is interpolated, and it is
// strictly UUID-validated first. Access: this EF is public/token-gated at the surface (share-viewer) exactly
// like the render EF; the Dossier UUID is the capability. verify_jwt=false.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUESTION_LEN = 600;

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

  const theoSessionId = typeof body?.theo_session_id === "string" ? body.theo_session_id.trim() : "";
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!UUID_RE.test(theoSessionId)) return json({ error: "theo_session_id must be a full UUID" }, 400);
  if (!question) return json({ error: "question is required" }, 400);
  if (question.length > MAX_QUESTION_LEN) {
    return json({ error: `question too long (${question.length} > ${MAX_QUESTION_LEN})` }, 400);
  }

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));
  // The publishable/anon key is a PUBLIC client key (already shipped in theo-config.js). Used only to pass
  // the Edge gateway when this EF calls api-prime-invoke; the invoke uses its own service client for the DB.
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "sb_publishable_sx8JQVtRhBQCgsvvDYI8RQ_6PlZxs4Y";

  // Per-stage orchestration timing (Napoleon baton 4fb28d1c Part 1): the reader waits on THIS wall clock, so
  // measure each stage here and fold the model-loop breakdown (from api-prime-invoke) + the resolve breakdown
  // (from trace_interrogation's row) into one interrogation_run record. This is what tells us where the minute
  // actually goes — measured, not guessed.
  const tTotal = Date.now();
  const timing = { seal_lookup_ms: 0, seal_mint_ms: 0, invoke_ms: 0, readback_ms: 0, revoke_ms: 0 };

  // 1. Template interrogation seal for this Dossier. theoSessionId is UUID_RE-validated, safe to interpolate.
  const tSealLookup = Date.now();
  const tmplRes = await supabase.rpc("execute_raw_sql", {
    query: "SELECT lineage_name, permit, cargo FROM sibling_grant "
      + "WHERE revoked_at IS NULL AND cargo->>'theo_session_id' = '" + theoSessionId + "' "
      + "AND permit @> ARRAY['trace_interrogation']::text[] ORDER BY sealed_at DESC LIMIT 1",
  });
  timing.seal_lookup_ms = Date.now() - tSealLookup;
  if (tmplRes.error) return json({ error: `seal lookup: ${tmplRes.error.message}` }, 500);
  const tmpl = (Array.isArray(tmplRes.data) ? tmplRes.data[0] : null) as
    | { lineage_name: string; permit: string[]; cargo: Record<string, unknown> }
    | null;
  // No interrogation seal for this Dossier -> the ASK panel is simply unavailable (not an error).
  if (!tmpl) return json({ ok: true, available: false }, 200);

  // 2. Fresh ephemeral seal on a unique session (race-free read-back; no cross-reader thread bleed).
  const askSession = crypto.randomUUID();
  const tSealMint = Date.now();
  const seal = await supabase.rpc("seal_sibling_grant", {
    p_session_id: askSession,
    p_lineage_name: tmpl.lineage_name,
    p_permit: tmpl.permit,
    p_cargo: tmpl.cargo,
    p_spawner: "heph",
  });
  timing.seal_mint_ms = Date.now() - tSealMint;
  if (seal.error) return json({ error: `seal failed: ${seal.error.message}` }, 500);

  try {
    // 3. Drive the sealed interrogate djinn synchronously.
    const tInvoke = Date.now();
    const invokeResp = await fetch(env("SUPABASE_URL") + "/functions/v1/api-prime-invoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": anonKey,
        "Authorization": "Bearer " + anonKey,
      },
      body: JSON.stringify({
        lineage_name: tmpl.lineage_name,
        session_id: askSession,
        user_message: question,
      }),
    });
    let invokeJson: Record<string, unknown> = {};
    try { invokeJson = await invokeResp.json(); } catch { /* non-JSON body — leave empty */ }
    timing.invoke_ms = Date.now() - tInvoke;
    if (!invokeResp.ok) {
      return json({ ok: false, available: true, error: `interrogation failed (HTTP ${invokeResp.status})` }, 502);
    }
    // The model-loop breakdown (per-Anthropic-call + per-tool ms) from api-prime-invoke — the bulk of the wait.
    const modelLoop = (invokeJson?.timings as Record<string, unknown>) ?? null;

    // 4. Read back THIS session's trace row (unambiguous — one session, one run).
    const tReadback = Date.now();
    const rb = await supabase
      .from("interrogation_run")
      .select("id, question, kept, withheld, vetted_answer, ledger, stage_timings, created_at")
      .eq("session_id", askSession)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    timing.readback_ms = Date.now() - tReadback;
    if (rb.error) return json({ error: `read-back: ${rb.error.message}` }, 500);
    const row = rb.data as
      | { id: string; question: string; kept: number; withheld: number; vetted_answer: unknown; ledger: unknown; stage_timings: Record<string, unknown> | null }
      | null;

    // The djinn produced no traced answer (e.g. it declined as out of scope). Surface its prose as context;
    // the front-end shows a "could not be answered from the grounded record" state rather than a blank.
    if (!row) {
      return json({
        ok: true, available: true, traced: false,
        question,
        response: (invokeJson?.response as string) ?? null,
        timings: { total_ms: Date.now() - tTotal, orchestration: timing, model_loop: modelLoop },
      }, 200);
    }

    // Fold orchestration + model-loop timings into the interrogation_run row (trace_interrogation already wrote
    // stage_timings.resolve). Best-effort: a timing-write failure must never fail the answer.
    const fullTimings = { ...(row.stage_timings ?? {}), orchestration: timing, model_loop: modelLoop };
    const totalMs = Date.now() - tTotal;
    try {
      await supabase.from("interrogation_run")
        .update({ stage_timings: fullTimings, total_ms: totalMs })
        .eq("id", row.id);
    } catch (_e) { /* timing enrichment is best-effort */ }

    return json({
      ok: true, available: true, traced: true,
      question: row.question ?? question,
      kept: row.kept,
      withheld: row.withheld,
      vetted_answer: row.vetted_answer,
      response: (invokeJson?.response as string) ?? null,
      timings: { total_ms: totalMs, ...fullTimings },
    }, 200);
  } finally {
    // 5. Revoke the ephemeral seal (best-effort; service client bypasses RLS).
    const tRevoke = Date.now();
    try {
      await supabase.from("sibling_grant").update({ revoked_at: new Date().toISOString() }).eq("session_id", askSession);
    } catch (_e) { /* orphaned ephemeral seal is harmless (revoked on next sweep); never fail the answer */ }
    timing.revoke_ms = Date.now() - tRevoke;
  }
});
