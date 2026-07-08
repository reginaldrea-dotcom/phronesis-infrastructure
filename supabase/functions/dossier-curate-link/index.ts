// dossier-curate-link — keep/remove a Supporting Link on a dossier section (Theo spec b63ec6d5, over
// Connie's supporting_link table / JSON->rows model).
//
// The Supporting Links footer is a promotion "waiting room" of curated-but-unverified engine links. A
// reviewer KEEPS the good ones and REMOVES the wrong/dead/irrelevant ones. State lives on the row:
//   review_state ∈ {unreviewed, kept, removed}
// External share readers only ever see 'kept' (enforced in theo-render-data) — so no unreviewed or dead
// link leaks onto a shared dossier. 'removed' is preserved as a record, not deleted.
//
// Connie's schema enforces the review discipline, and we satisfy it here:
//   - removing REQUIRES a rejection_class ∈ {dead, wrong, irrelevant} (biconditional with review_state='removed');
//   - any non-unreviewed state REQUIRES reviewed_by + reviewed_at.
//
// WHY an EF: supporting_link is written service-role; the dossier page holds only the publishable key.
//
// ACCESS CONTROL — INTERIM MODEL "B" (Reg, 7 Jul 2026): trusts the Cloudflare Access edge like
// theo-render-data (verify_jwt=false, no per-user check). The front-end renders keep/remove controls only
// on the internal Access-gated page (window.DOSSIER_EDIT), never on the external token share. reviewed_by
// is stamped 'reg' (the reviewer behind the gate). HARDENING (Aegis): a same-origin Access-verified proxy
// so the write — and reviewed_by — are provably the real identity, not edge-trusted.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f-]{36}$/i;
const STATES = new Set(["kept", "removed"]);
const REJECTION_CLASSES = new Set(["dead", "wrong", "irrelevant"]);
const REVIEWER = "reg";  // model B: the reviewer behind the Access gate. Model A derives this from identity.

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

// Resilience against intermittent Supabase Edge->PostgREST stalls (see theo-render-data, 7 Jul 2026): a
// call that hangs past DB_TIMEOUT_MS is abandoned and retried, so a bad Edge isolate self-recovers instead
// of failing the click. Safe here because the write is idempotent (re-applying the same review_state is a
// no-op). Deterministic DB errors carry an `error` field and are surfaced immediately — only stalls retry.
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

  const linkId = typeof body?.link_id === "string" ? body.link_id.trim() : "";
  const action = typeof body?.action === "string" ? body.action.trim() : "";
  const rejectionClass = typeof body?.rejection_class === "string" ? body.rejection_class.trim() : null;
  if (!UUID_RE.test(linkId)) return json({ error: "link_id must be a UUID" }, 400);
  if (!STATES.has(action)) return json({ error: "action must be 'kept' or 'removed'" }, 400);
  if (action === "removed" && (!rejectionClass || !REJECTION_CLASSES.has(rejectionClass))) {
    return json({ error: "removing requires rejection_class ∈ {dead, wrong, irrelevant}" }, 400);
  }

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  // Set review_state + the reviewer stamps the schema requires. rejection_class is set only on removal
  // (null on keep) to honour the biconditional CHECK. confirmed_live_on is deliberately left untouched —
  // "kept" records the human review; it does not assert a fresh liveness check.
  const patch: Record<string, unknown> = {
    review_state: action,
    reviewed_by: REVIEWER,
    reviewed_at: new Date().toISOString(),
    rejection_class: action === "removed" ? rejectionClass : null,
  };

  const upd = await run("curate", () => supabase
    .from("supporting_link")
    .update(patch)
    .eq("id", linkId)
    .select("id, review_state, rejection_class")
    .maybeSingle());
  if (upd.error) return json({ error: `update: ${upd.error.message}` }, 500);
  if (!upd.data) return json({ error: "supporting link not found" }, 404);

  return json({ ok: true, link_id: linkId, review_state: action, rejection_class: patch.rejection_class });
});
