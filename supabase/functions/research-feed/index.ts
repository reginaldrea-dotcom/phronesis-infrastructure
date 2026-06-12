// research-feed — the knocker-upper seed (SP bbf89d91, baton df1bea8d). The mechanism
// behind the multi-research awareness surface: it turns the per-session lifecycle
// (theo_session.state + engine_dispatch.status) into a feed the surface POLLS, so
// "results are ready" reaches Reg without him watching N session pages and without a
// Prime flagging it through the relay. Scope: results-ready awareness now; the general
// push knocker-upper (event rows + realtime) is a later build (SP: "awareness now").
//
// WHY POLL, not realtime: theo_session/engine_dispatch are RLS deny-all, so a publishable-
// key surface cannot subscribe directly. Like theo-render-data, this EF reads with the
// service-role credential behind the Cloudflare edge and the surface polls it. No RLS
// change, no table exposure.
//
// Reads via the supabase-js query builder + in-code aggregation — NOT execute_raw_sql,
// whose json_agg wrap mis-handles FILTER aggregates (falls through to its write path and
// returns {rows_affected}, not rows). The builder is the theo-render-data pattern.
//
// Access control is at the CLOUDFLARE EDGE (like theo-render-data / live-report): the
// surface is gated, talks to Supabase with the publishable key, this EF is verify_jwt=false
// and not per-user scoped. Per-tenant scoping is future hardening (Aegis).

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

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

interface SessionRow {
  id: string;
  display_title: string | null;
  state: string;
  created_at: string;
  user_id: string | null;
}
interface Counts { total: number; completed: number; partial: number; failed: number; in_flight: number }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "GET or POST only" }, 405);

  let supabase;
  try {
    supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));
  } catch (e) {
    return json({ error: `config: ${(e as Error).message}` }, 500);
  }

  // In-flight = every session not yet terminal (SP derivation: state NOT IN delivered/failed;
  // + cancelled). Newest first. Service-role read (RLS deny-all to anon).
  const sess = await supabase
    .from("theo_session")
    .select("id, display_title, state, created_at, user_id")
    .not("state", "in", "(delivered,failed,cancelled)")
    .order("created_at", { ascending: false });
  if (sess.error) return json({ error: `session read: ${sess.error.message}` }, 500);
  const sessions = (sess.data ?? []) as SessionRow[];

  // Engine status for those sessions, aggregated per session in code.
  const bySession = new Map<string, Counts>();
  const ids = sessions.map((s) => s.id);
  if (ids.length > 0) {
    const ed = await supabase.from("engine_dispatch").select("theo_session_id, status").in("theo_session_id", ids);
    if (ed.error) return json({ error: `dispatch read: ${ed.error.message}` }, 500);
    for (const d of (ed.data ?? []) as Array<{ theo_session_id: string; status: string }>) {
      const c = bySession.get(d.theo_session_id) ?? { total: 0, completed: 0, partial: 0, failed: 0, in_flight: 0 };
      c.total++;
      if (d.status === "completed") c.completed++;
      else if (d.status === "partial") c.partial++;
      else if (d.status === "failed") c.failed++;
      else if (d.status === "pending" || d.status === "dispatched") c.in_flight++;
      bySession.set(d.theo_session_id, c);
    }
  }

  const in_flight = sessions.map((s) => {
    const c = bySession.get(s.id) ?? { total: 0, completed: 0, partial: 0, failed: 0, in_flight: 0 };
    const dispatched = c.total > 0;
    // ready = dispatched and every engine terminal -> results are IN (settle to steady/green);
    // cooking = dispatched and >=1 engine still pending/dispatched (flash). Pre-dispatch is neither.
    const ready = dispatched && c.in_flight === 0;
    return {
      session_id: s.id,
      display_title: s.display_title,
      state: s.state,
      created_at: s.created_at,
      engines: { total: c.total, completed: c.completed, partial: c.partial, failed: c.failed, in_flight: c.in_flight },
      ready,
      cooking: dispatched && c.in_flight > 0,
      result_path: `/primes/theo?session=${s.id}`,
    };
  });

  return json({
    in_flight,
    counts: {
      total: in_flight.length,
      ready: in_flight.filter((s) => s.ready).length,
      cooking: in_flight.filter((s) => s.cooking).length,
    },
    generated_at: new Date().toISOString(),
  });
});
