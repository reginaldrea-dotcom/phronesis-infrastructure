// grounding-worker - entry point.
//
// Invoked by pg_cron (via net.http_post) on a fixed cadence, presenting a shared secret in the `apikey`
// header (the same WORKER_INVOKE_KEY the theo-dispatch-worker drainer uses). Deploys with verify_jwt=false,
// so the worker guards itself (lib/auth.ts). All DB work uses the worker's own RLS-bypassing
// THEO_DISPATCH_SECRET_KEY; the caller's secret is only the door lock.
//
// One invocation = one tick: drain a couple of pending grounding_queue rows, grounding each by invoking
// Angelia through the Prime EF. State across ticks lives entirely in the substrate.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { assertEnv } from "./lib/env.ts";
import { isAuthorizedCaller } from "./lib/auth.ts";
import { makeClient } from "./lib/supabase.ts";
import { tick } from "./lib/tick.ts";

assertEnv();
console.info("grounding-worker: started");

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405, headers: { "content-type": "application/json" },
    });
  }

  if (!(await isAuthorizedCaller(req))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }

  const startedAt = Date.now();
  console.log("grounding tick: start");

  let summary;
  try {
    summary = await tick(makeClient());
  } catch (err) {
    console.error("grounding tick: failed", err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err), elapsed_ms: Date.now() - startedAt }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const elapsed = Date.now() - startedAt;
  console.log("grounding tick: done", JSON.stringify(summary), `${elapsed}ms`);
  return new Response(
    JSON.stringify({ ok: true, summary, elapsed_ms: elapsed }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});
