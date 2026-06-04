// theo-dispatch-worker — entry point.
//
// Invoked by pg_cron (via net.http_post) on a fixed cadence. The caller presents
// a shared secret in the `apikey` header (Supabase's new secret-key model: secret
// keys go in `apikey`, not as a Bearer JWT). The worker deploys with
// verify_jwt=false, so the platform does NOT guard it — the worker guards itself
// via isAuthorizedCaller() (see lib/auth.ts). All DB work uses the worker's OWN
// env SUPABASE_SERVICE_ROLE_KEY; the caller's secret is only the door lock.
//
// One invocation = one tick. The tick reads pending/dispatched engine_dispatch
// rows, submits or polls them, and files completion wake_deltas. State across
// ticks lives entirely in the substrate; no in-memory state.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { assertEnv } from "./lib/env.ts";
import { isAuthorizedCaller } from "./lib/auth.ts";
import { makeClient } from "./lib/supabase.ts";
import { tick } from "./lib/tick.ts";

assertEnv();
console.info("theo-dispatch-worker: started");

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  // Self-guard: verify_jwt=false means the platform lets anyone reach this
  // handler. Reject callers that don't present the shared secret in `apikey`.
  if (!(await isAuthorizedCaller(req))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const startedAt = Date.now();
  console.log("worker tick: start");

  let summary;
  try {
    const supabase = makeClient();
    summary = await tick(supabase);
  } catch (err) {
    console.error("worker tick: failed", err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err), elapsed_ms: Date.now() - startedAt }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const elapsed = Date.now() - startedAt;
  console.log("worker tick: done", JSON.stringify(summary), `${elapsed}ms`);
  return new Response(
    JSON.stringify({ ok: true, summary, elapsed_ms: elapsed }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});
