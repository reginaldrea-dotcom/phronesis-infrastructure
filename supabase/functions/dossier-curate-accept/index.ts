// dossier-curate-accept — the OPERATOR CURATION accept-write (Napoleon baton 53897bcc; ruling 4098ca71 +
// Aegis 450a3ab4). An operator ACCEPTS a withheld ungrounded_claim on their own knowledge; this logs it as a
// general (or personal) operator_curation_log 'add', which the interrogate resolver then surfaces as a
// CURATED_OPERATOR line attributed to the curator. Curation is CURATION, not override — the grounded record
// is untouched; a separate, attributed layer is added beside it.
//
// AUTHENTICATION — the editor role on the share TOKEN, resolved and enforced SERVER-SIDE (Aegis: "a hidden
// button is not an authorisation model"). NEVER Cloudflare-edge-trust, NEVER a constant curator:
//   - GENERAL scope (operator_curation_log.identity_key NULL): the token MUST resolve to is_editor=true. A
//     non-editor token is REFUSED here, below the model, not merely denied a button.
//   - PERSONAL scope (identity_key = the caller's identity): any valid token that resolves to a real identity
//     may curate ITS OWN layer — a lower bar, appropriate to a private layer that never enters the general view.
//   - curator = THE RESOLVED identity_key from the token, never a constant — this is what makes the audit real.
//   - promotion personal -> general is Reg's deliberate act elsewhere; there is NO path to it here.
// ONLY an ungrounded_claim is acceptable (Eames/Napoleon): the target must be a real synthesis_claim IN THIS
// Dossier that rests on NO source (no claim_on_fact edge). This is enforced server-side, so the "only
// ungrounded, never model_voice" rule holds even if a caller bypasses the UI.
//
// KNOWN v1 LIMITATION (Aegis, in the risk register): the bearer token is unhashed. Accepted for the small,
// trusted, Reg-managed v1 cohort. Token HASHING gates COHORT EXPANSION (opening general-scope curation beyond
// the current trusted set), NOT this build. verify_jwt=false; the token is the capability, resolved here.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BASIS_LEN = 1000;

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
  const claimId = typeof body?.claim_id === "string" ? body.claim_id.trim() : "";
  const statedBasis = typeof body?.stated_basis === "string" ? body.stated_basis.trim() : "";
  const scope = body?.scope === "personal" ? "personal" : "general";
  if (!token) return json({ error: "token is required" }, 400);
  if (!UUID_RE.test(claimId)) return json({ error: "claim_id must be a full UUID" }, 400);
  if (!statedBasis) return json({ error: "stated_basis is required (a curation carries the operator's stated basis)" }, 400);
  if (statedBasis.length > MAX_BASIS_LEN) return json({ error: `stated_basis too long (${statedBasis.length} > ${MAX_BASIS_LEN})` }, 400);

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  // 1. Resolve the token SERVER-SIDE (parameterized via PostgREST — token is user input, never interpolated).
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
  if (!s.dossier_instance_id) return json({ error: "this share is not a Dossier instance and cannot be curated" }, 400);

  // The curator is the RESOLVED identity — never a constant. Aegis: a curation's authority rests partly on
  // the curator's credibility, so an anonymous token cannot curate.
  const identity = (s.identity_key ?? "").trim();
  if (!identity) return json({ error: "this token resolves to no identity; curation requires an attributable identity" }, 403);

  // 2. AUTHORISE by scope, SERVER-SIDE. General-scope curation enters the shared Dossier every reader sees, so
  // it requires the editor role on the token. Refuse a non-editor here — not a hidden button.
  if (scope === "general" && s.is_editor !== true) {
    return json({ error: "general-scope curation requires an editor token; this token is not an editor" }, 403);
  }

  // 3. The target must be a real ungrounded_claim IN THIS Dossier (server-side "only ungrounded, never
  // model_voice"). claimId is UUID-validated. edge_count=0 => rests on no source.
  const chk = await supabase.rpc("execute_raw_sql", {
    query: "SELECT sc.claim_text, sy.theo_session_id AS tid, "
      + "(SELECT count(*) FROM element_dependency ed WHERE ed.dependent_synthesis_claim_id = sc.id AND ed.edge_kind='claim_on_fact') AS edge_count "
      + "FROM synthesis_claim sc JOIN synthesis sy ON sy.id = sc.synthesis_id WHERE sc.id = '" + claimId + "'",
  });
  if (chk.error) return json({ error: `claim lookup failed: ${chk.error.message}` }, 500);
  const claim = (Array.isArray(chk.data) ? chk.data[0] : null) as { claim_text: string; tid: string; edge_count: number } | null;
  if (!claim) return json({ error: "no such claim" }, 404);
  if (claim.tid !== s.theo_session_id) return json({ error: "this claim does not belong to the Dossier this token grants" }, 403);
  if (Number(claim.edge_count) > 0) return json({ error: "this claim is source-grounded; only an ungrounded (withheld) claim can be curated" }, 409);

  const logIdentityKey = scope === "personal" ? identity : null; // NULL = general (every reader); non-null = personal
  const canonicalClaimText = claim.claim_text;

  // 4. Idempotent: if an active (not-withdrawn) 'add' for this (Dossier, scope, claim) already exists, return
  // it rather than logging a duplicate.
  const existing = await supabase
    .from("operator_curation_log")
    .select("id, curator, created_at")
    .eq("dossier_instance_id", s.dossier_instance_id)
    .eq("act", "add")
    .eq("claim_text", canonicalClaimText)
    .is("withdrawn_at", null)
    .is("identity_key", logIdentityKey as unknown as null)  // matches NULL for general, the identity for personal
    .maybeSingle();
  if (!existing.error && existing.data) {
    return json({ ok: true, already_curated: true, curation: existing.data, scope }, 200);
  }

  // 5. Log the curation. curator = the resolved identity (never a constant).
  const ins = await supabase
    .from("operator_curation_log")
    .insert({
      dossier_instance_id: s.dossier_instance_id,
      identity_key: logIdentityKey,
      curator: identity,
      act: "add",
      claim_text: canonicalClaimText,
      stated_basis: statedBasis,
    })
    .select("id, curator, act, created_at")
    .single();
  if (ins.error) return json({ error: `curation write failed: ${ins.error.message}` }, 500);

  return json({ ok: true, curated: true, scope, curation: ins.data }, 200);
});
