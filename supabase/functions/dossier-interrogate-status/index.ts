// dossier-interrogate-status — REAL progress for the ASK panel (Napoleon baton 39ea928f, item 1).
//
// WHY: an interrogation takes ~45s (the draft is the judgment step; we do not trade it for speed). Sixty
// seconds of dead UI reads as BROKEN, not slow. This endpoint gives the surface REAL stage state to show
// while the answer is computed — never a faked progress bar. The stages are derived from actual execution
// rows written by the interrogation as it runs:
//   - no read_synthesis row yet            -> "reading"  (the djinn is reading the grounded record)
//   - read_synthesis present, no run row    -> "drafting" (drafting an answer + about to check each statement)
//   - interrogation_run row present         -> "checked"  (the trace ran; kept/withheld counts are REAL)
// "The wait is the proof": the reveal — "N statements checked: X supported, Y withheld" — is the integrity
// machinery made visible, and every number here comes from a row, not a timer.
//
// The front-end generates a progress_id (a uuid) and passes it to dossier-interrogate (used there as the
// interrogation session id) AND polls this endpoint with it. The response exposes ONLY derived progress
// (stage + counts) — never ledger content — so a polled id leaks nothing sensitive. Public/token-gated at
// the surface exactly like the render + interrogate EFs; verify_jwt=false.

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const progressId = typeof body?.progress_id === "string" ? body.progress_id.trim() : "";
  if (!UUID_RE.test(progressId)) return json({ error: "progress_id must be a full UUID" }, 400);

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));

  // 1. Trace row present? Then the audit ran and the counts are real — the answer is essentially ready.
  const runRes = await supabase
    .from("interrogation_run")
    .select("kept, withheld, assertion_count")
    .eq("session_id", progressId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runRes.error) return json({ error: `status: ${runRes.error.message}` }, 500);
  if (runRes.data) {
    const r = runRes.data as { kept: number | null; withheld: number | null; assertion_count: number | null };
    return json({
      ok: true, stage: "checked", done: true,
      kept: r.kept ?? 0, withheld: r.withheld ?? 0, assertion_count: r.assertion_count ?? null,
    });
  }

  // 2. No trace yet — derive reading vs drafting from the execution ledger (real rows, this session only).
  const ledRes = await supabase
    .from("execution_ledger")
    .select("tool")
    .eq("session_id", progressId);
  if (ledRes.error) return json({ error: `status: ${ledRes.error.message}` }, 500);
  const tools = ((ledRes.data ?? []) as Array<{ tool: string }>).map((r) => r.tool);
  const stage = tools.includes("trace_interrogation") ? "checking"
    : tools.includes("read_synthesis") ? "drafting"
    : "reading";
  return json({ ok: true, stage, done: false });
});
