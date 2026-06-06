// theo-render-data — read endpoint for the display/verify render (Eames spec, artifact
// 2835520b; MR 1ad5b49e). Given a session_id + the caller's JWT, returns the render JSON:
// "the face is a pure function of substrate rows" — this EF supplies the rows, the
// front-end (theo.html) renders them. No render-time LLM; this is the read half of
// deliver-by-query.
//
// WHY an EF and not a direct browser read: render_source_v1 / render_claim_v1 sit over
// RLS-sealed deny-all tables, so the browser (publishable key) cannot read them. This EF
// reads with the service-role credential and SCOPES by ownership (theo_session.user_id =
// the caller's app_user.id) — the tables stay sealed, the caller sees only their own work.
//
// Auth: sub extracted from the bearer JWT, matching api-prime-invoke (verify_jwt=false;
// deploy with --no-verify-jwt). The sub is NOT signature-verified here — consistent with
// the house interface flow, and acceptable while the render is Reg/Prime-facing; hardening
// (verified JWT) before tenant-facing exposure is Aegis's lane. Flagged, not hidden.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function env(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

// auth_user_id (JWT sub) from the Authorization bearer. No signature verify (see header).
function subFromAuth(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload?.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
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
  const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
  if (!UUID_RE.test(sessionId)) return json({ error: "session_id must be a full UUID" }, 400);

  const authUserId = subFromAuth(req.headers.get("authorization"));
  if (!authUserId) return json({ error: "unauthenticated — no bearer sub" }, 401);

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  // app_user.id — theo_session.user_id FKs app_user.id, not auth_user_id.
  const appUser = await supabase.from("app_user").select("id").eq("auth_user_id", authUserId).maybeSingle();
  if (appUser.error) return json({ error: `app_user lookup: ${appUser.error.message}` }, 500);
  if (!appUser.data?.id) return json({ error: "no app_user profile for caller" }, 403);
  const appUserId = appUser.data.id as string;

  // Session — the ownership filter IS the access control.
  const sess = await supabase
    .from("theo_session")
    .select("id, state, original_brief, refined_prompt, engine_selection_rationale, anonymisation_mode, created_at, delivered_at, user_id")
    .eq("id", sessionId)
    .eq("user_id", appUserId)
    .maybeSingle();
  if (sess.error) return json({ error: `session lookup: ${sess.error.message}` }, 500);
  if (!sess.data?.id) return json({ error: "session not found for this caller" }, 404);
  const session = sess.data;

  // Engine grid, questions (navigation spine), latest synthesis.
  const [engines, questions, synthRow] = await Promise.all([
    supabase.from("render_source_v1").select("*").eq("session_id", sessionId),
    supabase.from("research_question").select("id, question_index, question_text, status").eq("theo_session_id", sessionId).order("question_index", { ascending: true }),
    supabase.from("synthesis").select("id, layer_1_synthesis_md, created_at").eq("theo_session_id", sessionId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (engines.error) return json({ error: `engines: ${engines.error.message}` }, 500);
  if (questions.error) return json({ error: `questions: ${questions.error.message}` }, 500);

  const synthesis = synthRow.data ?? null;
  let sections: unknown[] = [];
  let claims: Array<Record<string, unknown>> = [];
  let citations: unknown[] = [];

  if (synthesis?.id) {
    const [secs, clm] = await Promise.all([
      supabase.from("synthesis_section").select("id, section_index, title, content_md, section_type, needs_review, join_note").eq("synthesis_id", synthesis.id).order("section_index", { ascending: true }),
      supabase.from("render_claim_v1").select("*").eq("session_id", sessionId),
    ]);
    if (secs.error) return json({ error: `sections: ${secs.error.message}` }, 500);
    if (clm.error) return json({ error: `claims: ${clm.error.message}` }, 500);
    sections = secs.data ?? [];
    claims = (clm.data ?? []) as Array<Record<string, unknown>>;
    const claimIds = claims.map((c) => c.claim_id).filter(Boolean) as string[];
    if (claimIds.length > 0) {
      const cit = await supabase.from("claim_citation").select("id, claim_id, url, title, source_date, resolution, note, dispatch_id").in("claim_id", claimIds);
      if (cit.error) return json({ error: `citations: ${cit.error.message}` }, 500);
      citations = cit.data ?? [];
    }
  }

  // Posture is derivable client-side: reading when synthesis.layer_1_synthesis_md is present
  // (committed), production otherwise. The `interactive` flag is a render-time concern, not
  // data — the front-end passes it; this endpoint only supplies rows.
  return json({
    session,
    engines: engines.data ?? [],
    questions: questions.data ?? [],
    synthesis,
    sections,
    claims,
    citations,
    generated_at: new Date().toISOString(),
  });
});
