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
// Access control: at the CLOUDFLARE EDGE. The render surface (theo.html) is Cloudflare-gated
// exactly like argos.html / connie.html — only authorised people reach it; the page then
// talks to Supabase with the publishable key (no per-user Supabase session). So this EF is
// UUID-addressed (session_id is the capability), verify_jwt=false, and does NOT scope per
// user. Per-tenant scoping is a future hardening (Aegis) for external-tenant exposure.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ID_RE = /^[0-9a-f-]{4,36}$/i;  // full UUID or a leading hex prefix

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

  // Prefix-tolerant resolve (sessionId is ID_RE-validated hex, safe to interpolate). Access
  // control is at the Cloudflare edge (see header) — no per-user scoping; the id/prefix is
  // the capability.
  const resolved = await supabase.rpc("execute_raw_sql", {
    query: `SELECT id FROM theo_session WHERE id::text LIKE '${sessionId}%' LIMIT 2`,
  });
  if (resolved.error) return json({ error: `resolve: ${resolved.error.message}` }, 500);
  const matches = (resolved.data ?? []) as Array<{ id: string }>;
  if (matches.length === 0) return json({ error: `no session with id/prefix '${sessionId}'` }, 404);
  if (matches.length > 1) return json({ error: `ambiguous prefix '${sessionId}' — supply more characters` }, 400);
  sessionId = matches[0].id;

  // Session row (full id now). Access control is the Cloudflare edge.
  const sess = await supabase
    .from("theo_session")
    // original_brief is deliberately NOT selected: it is the raw research instruction and carries PII
    // (e.g. a named individual's situation). It must never reach the render payload — the universal Dossier
    // page is PII-free (architecture §4/§8), and this page is shared externally. Title comes from display_title.
    .select("id, state, display_title, refined_prompt, engine_selection_rationale, anonymisation_mode, created_at, delivered_at, user_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (sess.error) return json({ error: `session lookup: ${sess.error.message}` }, 500);
  if (!sess.data?.id) return json({ error: "session not found for this caller" }, 404);
  const session = sess.data;

  // Engine grid, questions (navigation spine), latest synthesis.
  const [engines, questions, synthRow] = await Promise.all([
    supabase.from("render_source_v1").select("*").eq("session_id", sessionId),
    supabase.from("research_question").select("id, question_index, question_text, status").eq("theo_session_id", sessionId).order("question_index", { ascending: true }),
    supabase.from("synthesis").select("id, layer_1_synthesis_md, created_at, divergence_points_json, convergence_points_json, confidence_ratings_json").eq("theo_session_id", sessionId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (engines.error) return json({ error: `engines: ${engines.error.message}` }, 500);
  if (questions.error) return json({ error: `questions: ${questions.error.message}` }, 500);

  const synthesis = synthRow.data ?? null;
  let sections: unknown[] = [];
  let claims: Array<Record<string, unknown>> = [];
  let citations: unknown[] = [];
  let claimSources: unknown[] = [];
  let groundFacts: unknown[] = [];

  if (synthesis?.id) {
    const [secs, clm, conf, gfacts] = await Promise.all([
      supabase.from("synthesis_section").select("id, section_index, title, content_md, callout_md, section_type, needs_review, join_note").eq("synthesis_id", synthesis.id).order("section_index", { ascending: true }),
      supabase.from("render_claim_v1").select("*").eq("session_id", sessionId),
      // Per-section confidence (dossier L1): confidence_state from the tier-composition of the facts a
      // section's claims rest on (synthesis_claim.section_id -> element_dependency). 'ungrounded' until edges land.
      supabase.from("render_section_confidence_v1").select("section_id, confidence_state, claim_count, grounded_claim_count").eq("synthesis_id", synthesis.id),
      // Ground Facts panel: the distinct anchored sources this dossier stands on (claim_on_fact edges),
      // strongest tier first. Empty until Angelia grounds.
      supabase.from("render_dossier_fact_v1")
        .select("ground_fact_id, title, authority_tier, contestability, freshness_status, source_url, content_hash, source_document_id, definition_scope, period_label, in_conflict, supporting_claim_count, fact_kind, verification_state, review_state, screenshot_url, archive_url")
        .eq("synthesis_id", synthesis.id)
        .order("authority_tier", { ascending: true }).order("supporting_claim_count", { ascending: false }),
    ]);
    if (secs.error) return json({ error: `sections: ${secs.error.message}` }, 500);
    if (clm.error) return json({ error: `claims: ${clm.error.message}` }, 500);
    if (conf.error) return json({ error: `section_confidence: ${conf.error.message}` }, 500);
    if (gfacts.error) return json({ error: `ground_facts: ${gfacts.error.message}` }, 500);
    groundFacts = gfacts.data ?? [];
    const confBy = new Map((conf.data ?? []).map((r: Record<string, unknown>) => [r.section_id as string, r]));
    sections = (secs.data ?? []).map((s: Record<string, unknown>) => {
      const c = confBy.get(s.id as string);
      return { ...s,
        confidence_state: (c?.confidence_state as string) ?? "ungrounded",
        claim_count: c?.claim_count ?? 0,
        grounded_claim_count: c?.grounded_claim_count ?? 0 };
    });
    claims = (clm.data ?? []) as Array<Record<string, unknown>>;
    const claimIds = claims.map((c) => c.claim_id).filter(Boolean) as string[];
    if (claimIds.length > 0) {
      const [cit, cs] = await Promise.all([
        // source_document_id surfaces the Grade-0 anchored snapshot in the citation drawer (Eames
        // §7 addendum / Leg 3). Scalar column on claim_citation — the frozen-capture viewer endpoint
        // is the remaining Leg-3 piece; this makes the anchor detectable now.
        supabase.from("claim_citation").select("id, claim_id, url, title, source_date, resolution, note, dispatch_id, source_document_id").in("claim_id", claimIds),
        supabase.from("claim_source").select("claim_id, dispatch_id, stance").in("claim_id", claimIds),
      ]);
      if (cit.error) return json({ error: `citations: ${cit.error.message}` }, 500);
      if (cs.error) return json({ error: `claim_sources: ${cs.error.message}` }, 500);
      citations = cit.data ?? [];
      claimSources = cs.data ?? [];
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
    claim_sources: claimSources,
    ground_facts: groundFacts,
    generated_at: new Date().toISOString(),
  });
});
