// interrogate-precompute — warm the interrogate cache over a Dossier's KNOWN questions (baton 39ea928f,
// item 3). The suggested questions are research_question rows (36 of 45 betterworld claims carry a
// question_id), so they are known in advance: run the trace once per known question, cache the vetted answer,
// and every suggested question is then INSTANT for the reader — audit fully intact, the draft paid off the
// reader's clock.
//
// BOUNDED + RESUMABLE (the EF 504s at ~150s): each invocation computes at most `limit` questions that are not
// already warm at the current graph_version, and reports how many remain. Re-invoke until remaining = 0.
// Already-warm questions are skipped (idempotent), so a re-run after the graph changes recomputes only what
// went stale. It drives dossier-interrogate per question (force_fresh) so ALL the sealed-djinn + trace +
// cache-write machinery is reused exactly — precompute is that same path, run ahead of the reader.
//
// UUID-addressed (theo_session_id is the capability), like the other Dossier EFs. verify_jwt=false. Once the
// cache is warm, repeated calls are cheap (everything skipped), which bounds its cost.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 2;   // ~2 x up-to-45s < 150s EF ceiling, with headroom
const MAX_LIMIT = 4;

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
function questionNorm(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

// deno-lint-ignore no-explicit-any -- internal helper; the rpc path is untyped repo-wide
async function graphVersion(supabase: any, tid: string): Promise<string | null> {
  const q = "SELECT md5(coalesce(string_agg(sig, '|' ORDER BY sig), '')) AS gv FROM ("
    + "SELECT ed.id::text||':'||coalesce(ed.anchor_quote,'')||':'||coalesce(ed.verification_state,'')||':'||coalesce(ed.review_state,'')||':'||coalesce(ed.depends_on_ground_fact_id::text,'')||':'||coalesce(ed.depends_on_claim_figure_id::text,'') AS sig "
    + "FROM element_dependency ed JOIN synthesis_claim sc ON sc.id = ed.dependent_synthesis_claim_id JOIN synthesis sy ON sy.id = sc.synthesis_id "
    + "WHERE sy.theo_session_id = '" + tid + "' AND ed.edge_kind='claim_on_fact' "
    + "UNION ALL "
    + "SELECT sc.id::text||':'||md5(coalesce(sc.claim_text,'')) AS sig FROM synthesis_claim sc JOIN synthesis sy ON sy.id = sc.synthesis_id WHERE sy.theo_session_id = '" + tid + "' "
    + "UNION ALL "
    + "SELECT gf.id::text||':'||coalesce(gf.authority_tier,'') AS sig FROM ground_fact gf WHERE gf.id IN (SELECT ed2.depends_on_ground_fact_id FROM element_dependency ed2 JOIN synthesis_claim sc2 ON sc2.id=ed2.dependent_synthesis_claim_id JOIN synthesis sy2 ON sy2.id=sc2.synthesis_id WHERE sy2.theo_session_id='" + tid + "') "
    + "UNION ALL "
    + "SELECT cf.id::text||':'||coalesce(cf.provenance_tier,'') AS sig FROM claim_figure cf WHERE cf.id IN (SELECT ed3.depends_on_claim_figure_id FROM element_dependency ed3 JOIN synthesis_claim sc3 ON sc3.id=ed3.dependent_synthesis_claim_id JOIN synthesis sy3 ON sy3.id=sc3.synthesis_id WHERE sy3.theo_session_id='" + tid + "')"
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
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const theoSessionId = typeof body?.theo_session_id === "string" ? body.theo_session_id.trim() : "";
  if (!UUID_RE.test(theoSessionId)) return json({ error: "theo_session_id must be a full UUID" }, 400);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(body?.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "sb_publishable_sx8JQVtRhBQCgsvvDYI8RQ_6PlZxs4Y";

  const gv = await graphVersion(supabase, theoSessionId);
  if (!gv) return json({ error: "could not fingerprint the Dossier graph" }, 500);

  // Known questions = the Dossier's answered research_question rows (the suggested-question set).
  const rq = await supabase
    .from("research_question")
    .select("question_index, question_text, status")
    .eq("theo_session_id", theoSessionId)
    .order("question_index", { ascending: true });
  if (rq.error) return json({ error: `research_question: ${rq.error.message}` }, 500);
  const known = ((rq.data ?? []) as Array<{ question_index: number; question_text: string; status: string }>)
    .filter((r) => r.status === "answered" && typeof r.question_text === "string" && r.question_text.trim().length > 0);

  // Which are already warm at the CURRENT graph_version?
  const cacheRows = await supabase
    .from("interrogation_cache")
    .select("question_norm, graph_version")
    .eq("theo_session_id", theoSessionId);
  const warmNorms = new Set(
    ((cacheRows.data ?? []) as Array<{ question_norm: string; graph_version: string }>)
      .filter((r) => r.graph_version === gv)
      .map((r) => r.question_norm),
  );

  const cold = known.filter((k) => !warmNorms.has(questionNorm(k.question_text)));
  const toCompute = cold.slice(0, limit);
  const computed: Array<{ question: string; kept?: number; withheld?: number; ok: boolean }> = [];

  // Compute this batch by driving dossier-interrogate (force_fresh -> always traces + caches as 'precompute').
  for (const k of toCompute) {
    try {
      const resp = await fetch(env("SUPABASE_URL") + "/functions/v1/dossier-interrogate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": anonKey, "Authorization": "Bearer " + anonKey },
        body: JSON.stringify({ theo_session_id: theoSessionId, question: k.question_text, force_fresh: true }),
      });
      const j = await resp.json().catch(() => ({}));
      computed.push({
        question: k.question_text,
        kept: (j as Record<string, unknown>)?.kept as number | undefined,
        withheld: (j as Record<string, unknown>)?.withheld as number | undefined,
        ok: resp.ok && (j as Record<string, unknown>)?.traced === true,
      });
    } catch (e) {
      computed.push({ question: k.question_text, ok: false });
    }
  }

  const remaining = cold.length - toCompute.length;
  return json({
    ok: true,
    theo_session_id: theoSessionId,
    graph_version: gv,
    total_known: known.length,
    already_warm: warmNorms.size,
    computed_this_call: computed,
    remaining_cold: remaining,
    done: remaining === 0,
  }, 200);
});
