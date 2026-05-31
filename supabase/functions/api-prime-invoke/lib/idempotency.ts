// D3 — request-level idempotency. The interface re-POSTs the SAME request_id on a
// retry (and the first invocation keeps running server-side after a client timeout),
// so a duplicate must return the original's result WITHOUT re-running side effects.
// Backed by the idempotency_keys table; service-role client bypasses its RLS.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "./http.ts";

type SupabaseClient = ReturnType<typeof createClient>;

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_MS = 90_000; // > observed invocation ceiling (~66s), < client FETCH_TIMEOUT (150s)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jsonResponse = (body: string, status: number) =>
  new Response(body, { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** Atomically claim the key. 'first' → we own it and must markDone on the way out.
 *  'duplicate' → another invocation already holds it (in-progress or done). */
export async function claimIdempotency(
  supabase: SupabaseClient,
  requestId: string,
): Promise<"first" | "duplicate"> {
  const { error } = await supabase.from("idempotency_keys").insert({ request_id: requestId });
  if (!error) return "first";
  if ((error as { code?: string }).code === "23505") return "duplicate"; // PK conflict
  // Unexpected error: fail OPEN (run) rather than wrongly block — lose dedup, keep availability.
  console.error("idempotency claim error:", error);
  return "first";
}

/** Persist the response body for replay and mark the key done. */
export async function markDone(
  supabase: SupabaseClient,
  requestId: string,
  responseText: string,
  statusCode: number,
): Promise<void> {
  try {
    await supabase.from("idempotency_keys")
      .update({ status: "done", status_code: statusCode, response: responseText, updated_at: new Date().toISOString() })
      .eq("request_id", requestId);
  } catch (err) { console.error("idempotency markDone error:", err); }
}

/** Capture a Response's body+status for replay. Caller passes resp.clone(). */
export async function markDoneFromResponse(
  supabase: SupabaseClient,
  requestId: string,
  resp: Response,
): Promise<void> {
  try {
    const text = await resp.text();
    await markDone(supabase, requestId, text, resp.status);
  } catch (err) { console.error("idempotency markDoneFromResponse error:", err); }
}

/** Duplicate path: wait for the original to store its result, then replay it verbatim.
 *  If it never completes within the cap (or errored without storing), return an
 *  in-progress signal — NEVER re-execute. */
export async function awaitDuplicateResponse(
  supabase: SupabaseClient,
  requestId: string,
): Promise<Response> {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    const { data } = await supabase.from("idempotency_keys")
      .select("status, status_code, response")
      .eq("request_id", requestId)
      .maybeSingle();
    const row = data as { status?: string; status_code?: number; response?: string } | null;
    if (row && row.status === "done" && row.response != null) {
      return jsonResponse(row.response, row.status_code ?? 200);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return jsonResponse(
    JSON.stringify({
      error: true, error_type: "api_error",
      message: "Your previous request is still completing — do not resend. Check the result, then continue.",
    }),
    200,
  );
}
