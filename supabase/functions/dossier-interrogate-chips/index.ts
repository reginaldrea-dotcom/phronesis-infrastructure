// dossier-interrogate-chips — the suggested-question chips for the ASK panel (Eames ruling 11b073fb, filed
// into SP a1938393; Napoleon baton 39ea928f item 3 compose-piece).
//
// ELIGIBILITY COMES FROM THE TRACE, NOT FROM research_question.status (Eames's correction). A question earns
// a chip iff its cached trace returned >= 1 KEPT claim. Offering a suggested question is a CLAIM ABOUT THE
// SUBSTRATE — "I have grounded material for this" — and that must be true BY CONSTRUCTION: status is set once
// and does not track edge state (the anchor sweep downgraded edges without moving any status), so a stale
// 'answered' would offer a chip that comes back all-withheld. The interrogation_cache already holds the
// kept-count from the SAME trace that serves the answer, and graph_version keeps it self-correcting: a
// re-ground that drops a question below 1 kept removes its chip for free.
//
// THE EXCLUDED QUESTIONS ARE A FINDING, NOT A DELETION (Eames): we also return gap_count — known questions
// with no grounded answer — so the surface can show a quiet gap line. Suggestions ADD TO gap-reporting, they
// never replace it (anti-narrowing): if readers only see what a Dossier CAN answer, the gaps go quiet and
// nobody commissions the missing work.
//
// UUID-addressed (theo_session_id); reads with the service credential; verify_jwt=false.

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

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  const gv = await graphVersion(supabase, theoSessionId);
  // Without a fingerprint we cannot certify any chip is grounded at the CURRENT state — so offer none
  // (never assert grounding we cannot verify). The gap line still reports every known question.
  const rq = await supabase
    .from("research_question")
    .select("question_index, question_text")
    .eq("theo_session_id", theoSessionId)
    .order("question_index", { ascending: true });
  if (rq.error) return json({ error: `research_question: ${rq.error.message}` }, 500);
  const known = ((rq.data ?? []) as Array<{ question_index: number; question_text: string }>)
    .filter((r) => typeof r.question_text === "string" && r.question_text.trim().length > 0);

  let eligibleNorms = new Map<string, { kept: number }>();
  if (gv) {
    const cache = await supabase
      .from("interrogation_cache")
      .select("question_norm, kept")
      .eq("theo_session_id", theoSessionId)
      .eq("graph_version", gv);
    if (!cache.error) {
      for (const c of (cache.data ?? []) as Array<{ question_norm: string; kept: number | null }>) {
        if ((c.kept ?? 0) >= 1) eligibleNorms.set(c.question_norm, { kept: c.kept ?? 0 });
      }
    }
  }

  // Chips in the Dossier's natural question order; label is the VERBATIM question_text (Eames: never a
  // rewritten label — display exactly what is sent, which also makes the cache key match).
  const chips = known
    .filter((k) => eligibleNorms.has(questionNorm(k.question_text)))
    .map((k) => ({ question_text: k.question_text, kept: eligibleNorms.get(questionNorm(k.question_text))!.kept }));

  // Gap = known questions with no grounded answer (traced-empty OR not yet grounded). A FINDING, surfaced quietly.
  const gapCount = known.length - chips.length;

  return json({ ok: true, chips, gap_count: gapCount, total_known: known.length }, 200);
});
