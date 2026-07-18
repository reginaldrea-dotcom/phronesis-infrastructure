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

// Resilience against intermittent Supabase Edge->PostgREST hangs (observed 7 Jul 2026: a bad Edge isolate
// intermittently stalled DB calls ~20s then failed with a Cloudflare gateway page, while the DB itself,
// the REST gateway, and direct queries were all healthy in <1ms). Every DB call is fail-fast + retried:
// a call that stalls past DB_TIMEOUT_MS is abandoned and retried, so a bad isolate self-recovers in a
// couple of seconds instead of erroring. DETERMINISTIC DB errors (e.g. a missing column) carry an `error`
// field and are surfaced immediately — only stalls / network throws are retried.
const DB_TIMEOUT_MS = 6000;
const DB_TRIES = 3;

function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: stalled >${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// `make` must return a FRESH builder each call (supabase-js builders are single-use thenables).
async function run<T extends { error: unknown }>(label: string, make: () => PromiseLike<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= DB_TRIES; attempt++) {
    try {
      const res = await withTimeout(make(), DB_TIMEOUT_MS, label);
      if ((res as { error: unknown }).error) return res;  // deterministic DB error — surface, do not retry
      return res;
    } catch (e) {
      lastErr = e;  // stall (our timeout) or network throw — retry
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label}: failed after ${DB_TRIES} attempts`);
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
  // Supporting links (Connie's supporting_link table). SAFE BY DEFAULT: only 'kept' links are returned, so
  // an external share never receives unreviewed/removed rows in the payload. The internal editor page opts
  // into seeing 'unreviewed' (to review them) by sending include_unreviewed:true. 'removed' is never sent.
  const includeUnreviewed = body?.include_unreviewed === true;

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  // Prefix-tolerant resolve (sessionId is ID_RE-validated hex, safe to interpolate). Access
  // control is at the Cloudflare edge (see header) — no per-user scoping; the id/prefix is
  // the capability.
  const resolved = await run("resolve", () => supabase.rpc("execute_raw_sql", {
    query: `SELECT id FROM theo_session WHERE id::text LIKE '${sessionId}%' LIMIT 2`,
  }));
  if (resolved.error) return json({ error: `resolve: ${resolved.error.message}` }, 500);
  const matches = (resolved.data ?? []) as Array<{ id: string }>;
  if (matches.length === 0) return json({ error: `no session with id/prefix '${sessionId}'` }, 404);
  if (matches.length > 1) return json({ error: `ambiguous prefix '${sessionId}' — supply more characters` }, 400);
  sessionId = matches[0].id;

  // Session row (full id now). Access control is the Cloudflare edge.
  const sess = await run("session", () => supabase
    .from("theo_session")
    // original_brief is deliberately NOT selected: it is the raw research instruction and carries PII
    // (e.g. a named individual's situation). It must never reach the render payload — the universal Dossier
    // page is PII-free (architecture §4/§8), and this page is shared externally. Title comes from display_title.
    .select("id, state, display_title, refined_prompt, engine_selection_rationale, anonymisation_mode, created_at, delivered_at, user_id")
    .eq("id", sessionId)
    .maybeSingle());
  if (sess.error) return json({ error: `session lookup: ${sess.error.message}` }, 500);
  if (!sess.data?.id) return json({ error: "session not found for this caller" }, 404);
  const session = sess.data;

  // Engine grid, questions (navigation spine), latest synthesis.
  const [engines, questions, synthRow] = await Promise.all([
    run("engines", () => supabase.from("render_source_v1").select("*").eq("session_id", sessionId)),
    run("questions", () => supabase.from("research_question").select("id, question_index, question_text, status").eq("theo_session_id", sessionId).order("question_index", { ascending: true })),
    run("synthesis", () => supabase.from("synthesis").select("id, layer_1_synthesis_md, created_at, divergence_points_json, convergence_points_json, confidence_ratings_json").eq("theo_session_id", sessionId).order("created_at", { ascending: false }).limit(1).maybeSingle()),
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
    const [secs, clm, conf, gfacts, sfacts] = await Promise.all([
      run("sections", () => supabase.from("synthesis_section").select("id, section_index, title, content_md, callout_md, section_type, needs_review, join_note").eq("synthesis_id", synthesis.id).order("section_index", { ascending: true })),
      run("claims", () => supabase.from("render_claim_v1").select("*").eq("session_id", sessionId)),
      // Per-section confidence (dossier L1): confidence_state from the tier-composition of the facts a
      // section's claims rest on (synthesis_claim.section_id -> element_dependency). 'ungrounded' until edges land.
      run("section_confidence", () => supabase.from("render_section_confidence_v1").select("section_id, confidence_state, claim_count, grounded_claim_count").eq("synthesis_id", synthesis.id)),
      // Ground Facts panel: the distinct anchored sources this dossier stands on (claim_on_fact edges),
      // strongest tier first. Empty until Angelia grounds.
      run("ground_facts", () => supabase.from("render_dossier_fact_v1")
        .select("ground_fact_id, title, authority_tier, contestability, freshness_status, source_url, content_hash, source_document_id, definition_scope, period_label, in_conflict, supporting_claim_count, fact_kind, verification_state, review_state, screenshot_url, archive_url")
        .eq("synthesis_id", synthesis.id)
        .order("authority_tier", { ascending: true }).order("supporting_claim_count", { ascending: false })),
      // Per-SECTION grounded sources for the section-foot "Grounded sources" zone (Eames c639a489):
      // the anchored facts each section's own claims rest on.
      run("section_facts", () => supabase.from("render_section_fact_v1")
        .select("section_id, ground_fact_id, title, authority_tier, contestability, verification_state, review_state, screenshot_url, archive_url, source_url, content_hash, in_conflict")
        .eq("synthesis_id", synthesis.id)
        .order("authority_tier", { ascending: true })),
    ]);
    if (secs.error) return json({ error: `sections: ${secs.error.message}` }, 500);
    if (clm.error) return json({ error: `claims: ${clm.error.message}` }, 500);
    if (conf.error) return json({ error: `section_confidence: ${conf.error.message}` }, 500);
    if (gfacts.error) return json({ error: `ground_facts: ${gfacts.error.message}` }, 500);
    if (sfacts.error) return json({ error: `section_facts: ${sfacts.error.message}` }, 500);
    groundFacts = gfacts.data ?? [];
    const confBy = new Map((conf.data ?? []).map((r: Record<string, unknown>) => [r.section_id as string, r]));
    const factsBySection = new Map<string, Array<Record<string, unknown>>>();
    for (const f of (sfacts.data ?? []) as Array<Record<string, unknown>>) {
      const k = f.section_id as string;
      if (!factsBySection.has(k)) factsBySection.set(k, []);
      factsBySection.get(k)!.push(f);
    }

    // Per-section SUPPORTING LINKS from Connie's supporting_link table (the JSON->rows model). Kept always;
    // unreviewed only for the internal editor (include_unreviewed). Removed never returned.
    const linksBySection = new Map<string, Array<Record<string, unknown>>>();
    const sectionIds = (secs.data ?? []).map((s: Record<string, unknown>) => s.id as string);
    if (sectionIds.length > 0) {
      const states = includeUnreviewed ? ["kept", "unreviewed"] : ["kept"];
      const sl = await run("supporting_links", () => supabase.from("supporting_link")
        .select("id, section_id, title, url, note, returned_by_engine, valid_as_of, review_state")
        .in("section_id", sectionIds)
        .in("review_state", states)
        .order("valid_as_of", { ascending: false }));
      if (sl.error) return json({ error: `supporting_links: ${sl.error.message}` }, 500);
      for (const l of (sl.data ?? []) as Array<Record<string, unknown>>) {
        const k = l.section_id as string;
        if (!linksBySection.has(k)) linksBySection.set(k, []);
        linksBySection.get(k)!.push(l);
      }
    }

    sections = (secs.data ?? []).map((s: Record<string, unknown>) => {
      const c = confBy.get(s.id as string);
      const links = linksBySection.get(s.id as string) ?? [];
      // Section-level "(valid: DATE)" = the freshest valid_as_of among the section's links.
      const validDates = links.map((l) => l.valid_as_of as string).filter(Boolean).sort();
      return { ...s,
        confidence_state: (c?.confidence_state as string) ?? "ungrounded",
        claim_count: c?.claim_count ?? 0,
        grounded_claim_count: c?.grounded_claim_count ?? 0,
        grounded_sources: factsBySection.get(s.id as string) ?? [],
        support_links: links,
        support_links_valid_as_of: validDates.length ? validDates[validDates.length - 1] : null };
    });
    claims = (clm.data ?? []) as Array<Record<string, unknown>>;
    const claimIds = claims.map((c) => c.claim_id).filter(Boolean) as string[];
    if (claimIds.length > 0) {
      const [cit, cs] = await Promise.all([
        // source_document_id surfaces the Grade-0 anchored snapshot in the citation drawer (Eames
        // §7 addendum / Leg 3). Scalar column on claim_citation — the frozen-capture viewer endpoint
        // is the remaining Leg-3 piece; this makes the anchor detectable now.
        run("citations", () => supabase.from("claim_citation").select("id, claim_id, url, title, source_date, resolution, note, dispatch_id, source_document_id").in("claim_id", claimIds)),
        run("claim_sources", () => supabase.from("claim_source").select("claim_id, dispatch_id, stance").in("claim_id", claimIds)),
      ]);
      if (cit.error) return json({ error: `citations: ${cit.error.message}` }, 500);
      if (cs.error) return json({ error: `claim_sources: ${cs.error.message}` }, 500);
      citations = cit.data ?? [];
      claimSources = cs.data ?? [];
    }

    // Per-claim ANCHOR EDGES (interrogate surface v2 — anchor-quote-first-class, Eames SP 4985c519 /
    // Napoleon baton 629e4723). The claim_on_fact edge carries the verbatim `anchor_quote` (the span from
    // the source's own bytes that co-locates figure + subject), its verification_state, and the tier +
    // document of the fact/figure it rests on. THE QUOTE BELONGS TO THE EDGE, not the fact (per-edge ruling
    // 83163028): a claim shows the span that anchors IT. Grouped per claim so the front-end can render the
    // load-bearing surface — claim -> verbatim quote -> mark + tier + document — with the quote as the centre
    // of gravity. Short co-locating spans only; the substrate already holds them (never bulk reproduction).
    const groundingByClaim = new Map<string, Array<Record<string, unknown>>>();
    if (ID_RE.test(String(synthesis.id))) {   // synthesis.id is our own UUID; guard the interpolation anyway
      const q = "SELECT ed.dependent_synthesis_claim_id AS claim_id, ed.anchor_quote, ed.verification_state, ed.review_state, "
        + "gf.id AS fact_id, gf.title AS fact_title, gf.authority_tier AS fact_tier, gf.source_url AS fact_source_url, gf.source_document_id AS fact_doc_id, "
        + "cf.id AS figure_id, cf.provenance_tier AS figure_tier, cf.value AS figure_value, cf.unit AS figure_unit "
        + "FROM element_dependency ed "
        + "JOIN synthesis_claim sc ON sc.id = ed.dependent_synthesis_claim_id "
        + "LEFT JOIN ground_fact gf ON gf.id = ed.depends_on_ground_fact_id "
        + "LEFT JOIN claim_figure cf ON cf.id = ed.depends_on_claim_figure_id "
        + `WHERE sc.synthesis_id = '${synthesis.id}' AND ed.edge_kind = 'claim_on_fact'`;
      const anch = await run("anchor_edges", () => supabase.rpc("execute_raw_sql", { query: q }));
      if (anch.error) return json({ error: `anchor_edges: ${anch.error.message}` }, 500);
      for (const row of (Array.isArray(anch.data) ? anch.data : []) as Array<Record<string, unknown>>) {
        const cid = String(row.claim_id);
        if (!groundingByClaim.has(cid)) groundingByClaim.set(cid, []);
        const onFigure = row.figure_id != null;
        groundingByClaim.get(cid)!.push({
          anchor_quote: (row.anchor_quote as string) ?? null,
          verification_state: (row.verification_state as string) ?? null,
          review_state: (row.review_state as string) ?? null,
          source_kind: onFigure ? "claim_figure" : "ground_fact",
          tier: ((onFigure ? row.figure_tier : row.fact_tier) as string) ?? null,
          document_title: (row.fact_title as string) ?? null,
          source_url: (row.fact_source_url as string) ?? null,
          source_document_id: (row.fact_doc_id as string) ?? null,
          figure_value: onFigure ? (row.figure_value ?? null) : null,
          figure_unit: onFigure ? ((row.figure_unit as string) ?? null) : null,
        });
      }
    }
    // Attach the grounding edges to each claim (empty array when a claim rests on nothing).
    claims = claims.map((c) => ({ ...c, grounding: groundingByClaim.get(String(c.claim_id)) ?? [] }));
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
