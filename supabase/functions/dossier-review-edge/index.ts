// dossier-review-edge — the EVIDENCE REVIEW verdict write (Eames SP 57480e66 / build order 6d3d1c68).
// A reviewer answers "does THIS source support THIS claim?" one edge at a time. The verdict is written
// to element_dependency — THE EDGE, never the ground_fact node (per-edge ruling 83163028): a fact serving
// five claims needs five verdicts; confirming it for claim A says nothing about claim B. Writing to the
// node would spread one verdict across every claim on that fact — the contagion the per-edge rule killed.
//
//   CONFIRM -> review_state='accepted', reviewed_by=<resolved identity>, reviewed_at=now.
//              verification_state is UNCHANGED — a human eyeball does not make a qualitative claim
//              machine-verified; it confirms FIT, which is the ceiling a qualitative claim can reach.
//   REJECT  -> review_state='rejected' + review_note (the reason); the front-end drops the edge from that
//              claim's supporting set (the claim's other edges stand). The edge is NOT deleted — additive,
//              recoverable, auditable (a rejected verdict is itself a finding).
//
// AUTH: the EDITOR role on the share token, resolved and enforced SERVER-SIDE (Aegis: a hidden button is
// not an auth model), exactly like dossier-curate-accept. verify_jwt=false; the token is the capability.
// element_dependency is RLS deny-all — the browser cannot write it; this EF writes with service-role.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LEN = 1000;

function env(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const edgeId = typeof body?.edge_id === "string" ? body.edge_id.trim() : "";
  const verdict = body?.verdict === "reject" ? "reject" : body?.verdict === "confirm" ? "confirm" : "";
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!token) return json({ error: "token is required" }, 400);
  if (!UUID_RE.test(edgeId)) return json({ error: "edge_id must be a full UUID" }, 400);
  if (!verdict) return json({ error: "verdict must be 'confirm' or 'reject'" }, 400);
  if (verdict === "reject" && !reason) return json({ error: "a reject needs a reason" }, 400);
  if (reason.length > MAX_REASON_LEN) return json({ error: `reason too long (${reason.length} > ${MAX_REASON_LEN})` }, 400);

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  // 1. Resolve the token SERVER-SIDE (parameterized — token is user input, never interpolated).
  const share = await supabase
    .from("dossier_share")
    .select("identity_key, dossier_instance_id, theo_session_id, is_editor, revoked, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (share.error) return json({ error: `token resolution failed: ${share.error.message}` }, 500);
  const s = share.data as
    | { identity_key: string | null; dossier_instance_id: string | null; theo_session_id: string | null; is_editor: boolean | null; revoked: boolean | null; expires_at: string | null }
    | null;
  if (!s) return json({ error: "invalid share token" }, 403);
  if (s.revoked) return json({ error: "this share token has been revoked" }, 403);
  if (s.expires_at && new Date(s.expires_at).getTime() <= Date.now()) return json({ error: "this share token has expired" }, 403);
  if (!s.dossier_instance_id) return json({ error: "this share is not a Dossier instance" }, 400);

  // Reviewing writes the general record every reader sees — it requires the editor role, enforced here.
  if (s.is_editor !== true) return json({ error: "reviewing evidence requires an editor token; this token is not an editor" }, 403);
  const identity = (s.identity_key ?? "").trim();
  if (!identity) return json({ error: "this token resolves to no identity; a review verdict must be attributable" }, 403);

  // 2. The edge must be a real claim_on_fact edge whose claim belongs to THIS Dossier's session (edgeId is
  // UUID-validated; the join to the session is the tenant check — a token cannot review another dossier's edge).
  const chk = await supabase.rpc("execute_raw_sql", {
    query: "SELECT ed.id, sy.theo_session_id AS tid, ed.edge_kind FROM element_dependency ed "
      + "JOIN synthesis_claim sc ON sc.id = ed.dependent_synthesis_claim_id "
      + "JOIN synthesis sy ON sy.id = sc.synthesis_id WHERE ed.id = '" + edgeId + "'",
  });
  if (chk.error) return json({ error: `edge lookup failed: ${chk.error.message}` }, 500);
  const edge = (Array.isArray(chk.data) ? chk.data[0] : null) as { id: string; tid: string; edge_kind: string } | null;
  if (!edge) return json({ error: "no such edge" }, 404);
  if (edge.edge_kind !== "claim_on_fact") return json({ error: "only a claim_on_fact edge carries a source to review" }, 409);
  if (edge.tid !== s.theo_session_id) return json({ error: "this edge does not belong to the Dossier this token grants" }, 403);

  // 3. Write the verdict to the EDGE. verification_state is deliberately untouched (a human eyeball
  // confirms FIT; it does not machine-verify). review_note carries the reject reason, null on confirm.
  const patch = verdict === "confirm"
    ? { review_state: "accepted", reviewed_by: identity, reviewed_at: new Date().toISOString(), review_note: null }
    : { review_state: "rejected", reviewed_by: identity, reviewed_at: new Date().toISOString(), review_note: reason };
  const upd = await supabase.from("element_dependency").update(patch).eq("id", edgeId).select("id, review_state, reviewed_by, reviewed_at, review_note").single();
  if (upd.error) return json({ error: `review write failed: ${upd.error.message}` }, 500);

  return json({ ok: true, edge: upd.data }, 200);
});
