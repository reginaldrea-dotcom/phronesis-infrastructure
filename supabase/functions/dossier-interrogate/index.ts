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

  // 1. Template interrogation seal for this Dossier. theoSessionId is UUID_RE-validated, safe to interpolate.
  const tmplRes = await supabase.rpc("execute_raw_sql", {
    query: "SELECT lineage_name, permit, cargo FROM sibling_grant "
      + "WHERE revoked_at IS NULL AND cargo->>'theo_session_id' = '" + theoSessionId + "' "
      + "AND permit @> ARRAY['trace_interrogation']::text[] ORDER BY sealed_at DESC LIMIT 1",
  });
  if (tmplRes.error) return json({ error: `seal lookup: ${tmplRes.error.message}` }, 500);
  const tmpl = (Array.isArray(tmplRes.data) ? tmplRes.data[0] : null) as
    | { lineage_name: string; permit: string[]; cargo: Record<string, unknown> }
    | null;
  // No interrogation seal for this Dossier -> the ASK panel is simply unavailable (not an error).
  if (!tmpl) return json({ ok: true, available: false }, 200);

  // 2. Fresh ephemeral seal on a unique session (race-free read-back; no cross-reader thread bleed).
  const askSession = crypto.randomUUID();
  const seal = await supabase.rpc("seal_sibling_grant", {
    p_session_id: askSession,
    p_lineage_name: tmpl.lineage_name,
    p_permit: tmpl.permit,
    p_cargo: tmpl.cargo,
    p_spawner: "heph",
  });
  if (seal.error) return json({ error: `seal failed: ${seal.error.message}` }, 500);

  try {
    // 3. Drive the sealed interrogate djinn synchronously.
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
    if (!invokeResp.ok) {
      return json({ ok: false, available: true, error: `interrogation failed (HTTP ${invokeResp.status})` }, 502);
    }

    // 4. Read back THIS session's trace row (unambiguous — one session, one run).
    const rb = await supabase
      .from("interrogation_run")
      .select("question, kept, withheld, vetted_answer, ledger, created_at")
      .eq("session_id", askSession)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (rb.error) return json({ error: `read-back: ${rb.error.message}` }, 500);
    const row = rb.data as
      | { question: string; kept: number; withheld: number; vetted_answer: unknown; ledger: unknown }
      | null;

    // The djinn produced no traced answer (e.g. it declined as out of scope). Surface its prose as context;
    // the front-end shows a "could not be answered from the grounded record" state rather than a blank.
    if (!row) {
      return json({
        ok: true, available: true, traced: false,
        question,
        response: (invokeJson?.response as string) ?? null,
      }, 200);
    }

    return json({
      ok: true, available: true, traced: true,
      question: row.question ?? question,
      kept: row.kept,
      withheld: row.withheld,
      vetted_answer: row.vetted_answer,
      response: (invokeJson?.response as string) ?? null,
    }, 200);
  } finally {
    // 5. Revoke the ephemeral seal (best-effort; service client bypasses RLS).
    try {
      await supabase.from("sibling_grant").update({ revoked_at: new Date().toISOString() }).eq("session_id", askSession);
    } catch (_e) { /* orphaned ephemeral seal is harmless (revoked on next sweep); never fail the answer */ }
  }
});
