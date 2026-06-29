import type { Action } from "./types.ts";
import { corsHeaders, errResponse } from "../lib/http.ts";

// Files a Super-T atomically via the file_super_t Postgres RPC (insert artifact → insert chain row →
// link predecessor, one transaction, service-role/RLS-bypass) AND performs the real retirement: flips
// the instance to 'retired'. This is the Retire button's path.
//
// R1 (spec/msg a25e6efc; Angelia no-op bug 74711787). The old flow reused the chat session_id, which
// collided with a prior filing on file_super_t's (instance_id, session_id) idempotency and returned the
// EXISTING chain row — a no-op that still reported success, and it never flipped instance status. The fix:
//   (a) generate a FRESH session UUID for this filing (server-side — can't be bypassed),
//   (b) call file_super_t with it,
//   (c) require result_type = 'created' (R2 discriminator) before proceeding — idempotent_hit here means
//       the no-op bug, so fail loudly and DO NOT report success or flip status,
//   (d) on a genuine new filing, UPDATE instances SET status='retired', last_seen_at=now().
// Double-file on a double-click is prevented upstream by request-level idempotency (request_id), so the
// action runs once per retire-click even though it mints a fresh session each run.
export const fileSuperTAction: Action = {
  name: "file_super_t",
  handle: async ({ supabase, body }) => {
    const { content, title, instance_id, lineage } = body ?? {};
    if (!lineage || !title || !content) {
      return errResponse("file_super_t requires lineage, title, and content", 400);
    }
    if (!instance_id) {
      return errResponse("file_super_t (retire) requires instance_id — retirement must flip that instance's status", 400);
    }

    // (a)+(b) — fresh session UUID guarantees file_super_t does a genuine new insert (never collides
    // with a prior filing's session). The client's chat session_id is deliberately NOT used here.
    const retireSession = crypto.randomUUID();
    const { data, error } = await supabase.rpc("file_super_t", {
      p_lineage: lineage,
      p_instance_id: instance_id,
      p_title: title,
      p_content: content,
      p_session_id: retireSession,
    });
    if (error) {
      console.error("file_super_t error:", error);
      return errResponse(error.message);
    }

    // (c) — require a genuine new filing. idempotent_hit (or any non-created) means no real retirement
    // happened: fail loudly, report NO success, and leave instance status untouched.
    if (!data || data.result_type !== "created") {
      console.error("file_super_t retire: expected result_type 'created', got", data?.result_type);
      return errResponse(
        `Retirement filed nothing new (result_type=${data?.result_type ?? "unknown"}); instance status unchanged. No-op guard (bug 74711787) — surface to Reg.`,
        409,
      );
    }

    // (d) — real retirement: flip status on the confirmed new filing.
    const { error: upErr } = await supabase
      .from("instances")
      .update({ status: "retired", last_seen_at: new Date().toISOString() })
      .eq("id", instance_id);
    if (upErr) {
      console.error("retire status flip failed:", upErr);
      return errResponse(
        `Super-T filed (seq ${data.sequence_number}) but flipping instance ${instance_id} to retired failed: ${upErr.message}. Retirement is half-done — surface to Reg.`,
        500,
      );
    }

    // Echo the filing + the confirmed retirement.
    return new Response(
      JSON.stringify({ ...data, retired: true, instance_id, retire_session_id: retireSession }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  },
};
