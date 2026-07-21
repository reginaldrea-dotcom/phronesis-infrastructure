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

// Normalized question key (baton 39ea928f item 3): lower + trim + collapse internal whitespace, so a
// suggested question and a re-typed variant of it hit the same cache row.
function questionNorm(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

// GRAPH_VERSION fingerprint — md5 over the Dossier's claim/edge/tier state (exactly the inputs the trace
// walks). A cached answer is served ONLY while this still matches; any claim edit / re-ground / tier change
// flips it and forces a recompute (staleness = correctness, per Napoleon). theoSessionId is UUID_RE-validated
// before this is called, so the interpolation is safe. Returns null on error -> caller skips the cache (the
// safe direction: never serve a possibly-stale answer when we cannot verify freshness).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal helper; the rpc path is untyped repo-wide
async function graphVersion(
  supabase: any,
  theoSessionId: string,
): Promise<string | null> {
  const q = "SELECT md5(coalesce(string_agg(sig, '|' ORDER BY sig), '')) AS gv FROM ("
    + "SELECT ed.id::text||':'||coalesce(ed.anchor_quote,'')||':'||coalesce(ed.verification_state,'')||':'||coalesce(ed.review_state,'')||':'||coalesce(ed.depends_on_ground_fact_id::text,'')||':'||coalesce(ed.depends_on_claim_figure_id::text,'') AS sig "
    + "FROM element_dependency ed JOIN synthesis_claim sc ON sc.id = ed.dependent_synthesis_claim_id JOIN synthesis sy ON sy.id = sc.synthesis_id "
    + "WHERE sy.theo_session_id = '" + theoSessionId + "' AND ed.edge_kind='claim_on_fact' "
    + "UNION ALL "
    + "SELECT sc.id::text||':'||md5(coalesce(sc.claim_text,'')) AS sig FROM synthesis_claim sc JOIN synthesis sy ON sy.id = sc.synthesis_id WHERE sy.theo_session_id = '" + theoSessionId + "' "
    + "UNION ALL "
    + "SELECT gf.id::text||':'||coalesce(gf.authority_tier,'') AS sig FROM ground_fact gf WHERE gf.id IN (SELECT ed2.depends_on_ground_fact_id FROM element_dependency ed2 JOIN synthesis_claim sc2 ON sc2.id=ed2.dependent_synthesis_claim_id JOIN synthesis sy2 ON sy2.id=sc2.synthesis_id WHERE sy2.theo_session_id='" + theoSessionId + "') "
    + "UNION ALL "
    + "SELECT cf.id::text||':'||coalesce(cf.provenance_tier,'') AS sig FROM claim_figure cf WHERE cf.id IN (SELECT ed3.depends_on_claim_figure_id FROM element_dependency ed3 JOIN synthesis_claim sc3 ON sc3.id=ed3.dependent_synthesis_claim_id JOIN synthesis sy3 ON sy3.id=sc3.synthesis_id WHERE sy3.theo_session_id='" + theoSessionId + "')"
    + ") t";
  const r = await supabase.rpc("execute_raw_sql", { query: q });
  if (r.error) return null;
  const row = (Array.isArray(r.data) ? r.data[0] : null) as { gv?: string } | null;
  return row?.gv ?? null;
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

  // CACHE CHECK (baton 39ea928f item 3): if this exact question was already traced against the CURRENT graph
  // state, serve it instantly — the trace ran (audit intact), just earlier. Served only when graph_version
  // still matches, so a stale answer is never returned. A cache miss (or any lookup error) falls straight
  // through to the live path; the cache is an accelerator, never a gate. `force_fresh` bypasses it (used by
  // precompute to always recompute).
  const forceFresh = body?.force_fresh === true;
  const gv = await graphVersion(supabase, theoSessionId);
  if (!forceFresh && gv) {
    const cached = await supabase
      .from("interrogation_cache")
      .select("vetted_answer, kept, withheld, assertion_count")
      .eq("theo_session_id", theoSessionId)
      .eq("question_norm", questionNorm(question))
      .eq("graph_version", gv)
      .maybeSingle();
    if (!cached.error && cached.data) {
      const c = cached.data as { vetted_answer: unknown; kept: number; withheld: number; assertion_count: number | null };
      return json({
        ok: true, available: true, traced: true, cached: true,
        question,
        kept: c.kept, withheld: c.withheld,
        vetted_answer: c.vetted_answer,
        timings: { total_ms: Date.now() - tTotal, cache_hit: true },
      }, 200);
    }
  }

  // 2. Fresh ephemeral seal on a unique session (race-free read-back; no cross-reader thread bleed).
  // The client may supply a progress_id (a uuid it generated) so it can POLL dossier-interrogate-status for
  // REAL stage state while this request runs (baton 39ea928f item 1). We use it AS the interrogation session
  // id, so the execution_ledger + interrogation_run rows this run writes are keyed to it. It is only a
  // correlation handle: authorization is the template seal existing for this Dossier; the seal is minted
  // fresh on this id and revoked after, and the status endpoint exposes only derived progress. Validated as a
  // uuid; absent/malformed -> a server-minted random id (the pre-existing behaviour, no progress polling).
  const providedProgressId = typeof body?.progress_id === "string" && UUID_RE.test(body.progress_id.trim())
    ? body.progress_id.trim() : null;
  const askSession = providedProgressId ?? crypto.randomUUID();
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
      .select("id, question, kept, withheld, assertion_count, vetted_answer, ledger, stage_timings, created_at")
      .eq("session_id", askSession)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    timing.readback_ms = Date.now() - tReadback;
    if (rb.error) return json({ error: `read-back: ${rb.error.message}` }, 500);
    const row = rb.data as
      | { id: string; question: string; kept: number; withheld: number; assertion_count: number | null; vetted_answer: unknown; ledger: unknown; stage_timings: Record<string, unknown> | null }
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

    // CACHE WRITE (baton 39ea928f item 3): store the traced answer keyed to the CURRENT graph_version, so the
    // next identical ask (a suggested question, or a precompute pass) serves instantly. Every traced answer
    // warms the cache — precompute is just this path driven ahead of the reader. Upsert on (dossier, question)
    // so a re-ground overwrites the prior entry. Best-effort; a cache-write failure never affects the answer.
    if (gv) {
      try {
        await supabase.from("interrogation_cache").upsert({
          theo_session_id: theoSessionId,
          question,
          question_norm: questionNorm(question),
          vetted_answer: row.vetted_answer,
          kept: row.kept,
          withheld: row.withheld,
          assertion_count: row.assertion_count,
          graph_version: gv,
          source: forceFresh ? "precompute" : "live",
          computed_at: new Date().toISOString(),
        }, { onConflict: "theo_session_id,question_norm" });
      } catch (_e) { /* cache write is best-effort */ }
    }

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
