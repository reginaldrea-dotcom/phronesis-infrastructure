// dossier-curate-link — accept/reject a Supporting Link on a dossier section (Theo spec b63ec6d5).
//
// The Supporting Links footer (synthesis_section.support_links jsonb) is a promotion "waiting room" of
// curated-but-unverified engine links. A reviewer accepts the good ones and rejects the wrong/dead ones;
// status lives on each link object ("pending" | "accepted" | "rejected", absent === pending). Rejected
// links are hidden from display but PRESERVED (kept as a record, not deleted). External share readers only
// ever see "accepted" — so no unreviewed/dead link leaks onto a shared dossier.
//
// WHY an EF: synthesis_section is RLS deny-all, and the dossier page holds only the publishable key — the
// browser cannot write to it. This EF writes with the service-role credential.
//
// ACCESS CONTROL — INTERIM MODEL "B" (Reg, 7 Jul 2026). This trusts the Cloudflare Access edge exactly like
// theo-render-data: verify_jwt=false, UUID-addressed, no per-user check. In practice that scopes curation
// to whoever is already behind the Access gate (Reg + the Primes), NOT strictly Reg-only. The front-end
// only renders the accept/reject buttons on the internal Access-gated page (window.DOSSIER_EDIT) and never
// on the external token share, so this endpoint is not reachable with edit affordances from a shared link.
// HARDENING ITEM (Aegis): move to model "A" — a same-origin Access-verified proxy that checks the
// Cf-Access identity so the write is provably Reg-only (the Access JWT is not sent cross-origin to
// *.supabase.co, hence the same-origin hop). Until then this is deliberately edge-trusted.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f-]{36}$/i;
const ACTIONS = new Set(["accepted", "rejected"]);

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

  const sectionId = typeof body?.section_id === "string" ? body.section_id.trim() : "";
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const action = typeof body?.action === "string" ? body.action.trim() : "";
  if (!UUID_RE.test(sectionId)) return json({ error: "section_id must be a UUID" }, 400);
  if (!url) return json({ error: "url is required" }, 400);
  if (!ACTIONS.has(action)) return json({ error: "action must be 'accepted' or 'rejected'" }, 400);

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  // Read-modify-write on the section's support_links array. Low volume (one reviewer, one click at a time),
  // so a full-array rewrite is fine; we mutate only the target link (matched by url — unique within a
  // section) and preserve every other link and field.
  const cur = await supabase
    .from("synthesis_section")
    .select("support_links")
    .eq("id", sectionId)
    .maybeSingle();
  if (cur.error) return json({ error: `lookup: ${cur.error.message}` }, 500);
  if (!cur.data) return json({ error: "section not found" }, 404);

  const links = Array.isArray(cur.data.support_links) ? (cur.data.support_links as Array<Record<string, unknown>>) : [];
  let found = false;
  const next = links.map((l) => {
    if (l && typeof l === "object" && String((l as Record<string, unknown>).url ?? "") === url) {
      found = true;
      return { ...l, status: action };
    }
    return l;
  });
  if (!found) return json({ error: "link not found in this section" }, 404);

  const upd = await supabase
    .from("synthesis_section")
    .update({ support_links: next })
    .eq("id", sectionId);
  if (upd.error) return json({ error: `update: ${upd.error.message}` }, 500);

  return json({ ok: true, section_id: sectionId, url, status: action });
});
