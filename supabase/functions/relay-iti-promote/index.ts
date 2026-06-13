// relay-iti-promote — Fix 5 of Eames's Navigator board spec (3c507ee8), baton 82535abb.
//
// The promote-to-top control on the board GENERATES a baton's ITI and surfaces it in NEXT
// INVOCATION (Fix 1). relay_iti is service-write only (relay_iti_service_write; anon can read
// but not insert), so the publishable-key page cannot write it directly — this EF does the
// service-role write. CF-gated, verify_jwt=false, called from the board with the publishable key.
//
// Templating is VERBATIM from Antechamber's SC_ITI_HaltTemplates (a20b297a) — the templates are
// Antechamber's; this only fills their placeholders from the baton row. Unclaimed batons use the
// UNCLAIMED / first-invite template (from invoke_with + passed_by + attention); halted batons use
// the halt_kind template. Idempotent on primary_baton_id: re-promoting refreshes (re-surfaces),
// never duplicates.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCIPLINE = "Questions and status on this task go to the board, not to Reg — file a halt if stuck, mark done when finished.";

function env(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Condense invoke_with to the first ~300 chars at a sentence boundary — "the core, condensed"
// per the template, with "The full brief is on the baton" carrying the rest.
function condense(text: string | null): string {
  if (!text) return "";
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= 300) return t;
  const cut = t.slice(0, 300);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return (lastStop > 120 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + "…");
}

interface Baton {
  id: string; track: string; holder: string; passed_by: string; invoke_with: string | null;
  attention: string | null; halted_at: string | null; halt_kind: string | null;
  halt_note: string | null; halt_needs: string | null;
}

// SC_ITI_HaltTemplates (a20b297a), placeholders filled from the baton.
function renderITI(b: Baton): string {
  let body: string;
  if (b.halted_at && b.halt_kind) {
    const needs = b.halt_needs || "the relevant Prime";
    const note = (b.halt_note || "").trim();
    const noteSeg = note ? ` ${note}.` : "";
    switch (b.halt_kind) {
      case "blocked":
        body = `Hi ${needs}, ${b.holder} is blocked on ${b.track} and waiting on this before they can continue.${noteSeg} Once done, ${b.holder} is re-armed and Reg will get the next ITI.`; break;
      case "needs_ruling":
        body = `Hi ${needs}, ${b.holder} has paused on ${b.track} and needs a ruling.${noteSeg} Your call — once decided, let ${b.holder} know and they can resume.`; break;
      case "spawned":
        body = `Hi ${needs}, can you pick up the child leg ${b.holder} spawned from ${b.track} — they are waiting on it. Be aware there may be sibling legs; check the board for other children of ${b.track}.`; break;
      case "failed":
        body = `Hi ${needs}, ${b.holder} has hit a block on ${b.track} that needs re-scoping.${noteSeg} Can you take a look and determine the path forward? A new baton or a halt clear will re-arm them once the scope is agreed.`; break;
      case "gated":
        body = `Hi ${needs}, can you clear the gate for ${b.holder} on ${b.track} please.${noteSeg} Once you've verified, they can continue.`; break;
      default:
        body = `Hi ${needs}, ${b.holder} halted ${b.track} (${b.halt_kind}).${noteSeg}`;
    }
  } else {
    // UNCLAIMED / first-invite
    const urgent = b.attention === "urgent" ? ", and it is urgent" : "";
    const core = condense(b.invoke_with);
    body = `Hi ${b.holder}, can you pick up ${b.track} please — ${b.passed_by} passed this to you${urgent}.` +
      (core ? ` ${core}` : "") + ` The full brief is on the baton.`;
  }
  return `${body}\n\n${DISCIPLINE}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const batonId = typeof body?.baton_id === "string" ? body.baton_id.trim() : "";
  if (!UUID_RE.test(batonId)) return json({ error: "baton_id must be a full UUID" }, 400);

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  const b = await supabase.from("relay_baton")
    .select("id, track, holder, passed_by, invoke_with, attention, halted_at, halt_kind, halt_note, halt_needs, done_at")
    .eq("id", batonId).maybeSingle();
  if (b.error) return json({ error: `baton lookup: ${b.error.message}` }, 500);
  if (!b.data) return json({ error: `no baton ${batonId}` }, 404);
  const baton = b.data as Baton & { done_at: string | null };
  if (baton.done_at) return json({ error: "baton is done — nothing to promote" }, 409);

  const itiBody = renderITI(baton);

  // Idempotent on primary_baton_id: refresh an existing ITI for this baton, else insert.
  const existing = await supabase.from("relay_iti").select("id").eq("primary_baton_id", batonId).maybeSingle();
  if (existing.error) return json({ error: `relay_iti lookup: ${existing.error.message}` }, 500);

  if (existing.data?.id) {
    const upd = await supabase.from("relay_iti")
      .update({ body: itiBody, generated_by: "navigator-promote", generated_at: new Date().toISOString() })
      .eq("id", existing.data.id).select("id").single();
    if (upd.error) return json({ error: `relay_iti update: ${upd.error.message}` }, 500);
    return json({ promoted: true, action: "refreshed", iti_id: upd.data.id, primary_baton_id: batonId });
  }

  const ins = await supabase.from("relay_iti")
    .insert({ body: itiBody, generated_by: "navigator-promote", generated_at: new Date().toISOString(), primary_baton_id: batonId })
    .select("id").single();
  if (ins.error) return json({ error: `relay_iti insert: ${ins.error.message}` }, 500);
  return json({ promoted: true, action: "created", iti_id: ins.data.id, primary_baton_id: batonId });
});
