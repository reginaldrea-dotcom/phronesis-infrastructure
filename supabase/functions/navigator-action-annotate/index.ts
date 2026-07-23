// navigator-action-annotate — the Notices action surface's ONLY write path (Napoleon 290853ae;
// Connie's substrate 2b8e49ed / a0631afa). Writes Reg's human layer over the DERIVED action lines:
// title_override / note_md, snooze, and soft supersession — always to action_line_annotation
// (keyed on the stable anchor, prime_messages.id), NEVER to the derived view or prime_messages.
//
// The load-bearing rule (Napoleon): no affordance here may clear a line without the underlying
// work being done. So there is deliberately NO action that touches prime_messages.status or any
// completion signal — the view self-clears when the work completes. Snooze hides until a date;
// supersession is SOFT (superseded_at + by + reason, recoverable via unsupersede, no DELETE).
//
// Access model: like navigator-dismiss — the Navigator is Cloudflare-gated, this EF is called
// from it with the publishable key (verify_jwt=false, pinned in config.toml); writes run with
// the service-role credential because client writes on action_line_annotation are revoked.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f-]{4,36}$/i;

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

  const action = typeof body.action === "string" ? body.action : "";
  const messageId = typeof body.message_id === "string" ? body.message_id.trim() : "";
  if (!UUID_RE.test(messageId)) return json({ error: "message_id must be a full UUID" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // The patch always rides an upsert keyed on message_id — one annotation row per action line.
  const patch: Record<string, unknown> = {
    message_id: messageId,
    annotated_by: "reg",
    updated_at: new Date().toISOString(),
  };

  if (action === "annotate") {
    // Only explicitly-present fields are written, so a title edit can't clobber a note and vice versa.
    if ("title_override" in body) {
      const t = body.title_override;
      if (t !== null && typeof t !== "string") return json({ error: "title_override must be string or null" }, 400);
      patch.title_override = t === "" ? null : t;
    }
    if ("note_md" in body) {
      const n = body.note_md;
      if (n !== null && typeof n !== "string") return json({ error: "note_md must be string or null" }, 400);
      patch.note_md = n === "" ? null : n;
    }
    if (!("title_override" in patch) && !("note_md" in patch)) {
      return json({ error: "annotate needs title_override and/or note_md" }, 400);
    }
  } else if (action === "snooze") {
    // snoozed_until: ISO timestamp to hide until, or null to wake now.
    const s = body.snoozed_until;
    if (s === null) patch.snoozed_until = null;
    else if (typeof s === "string" && !isNaN(Date.parse(s))) patch.snoozed_until = new Date(s).toISOString();
    else return json({ error: "snoozed_until must be an ISO timestamp or null" }, 400);
  } else if (action === "supersede") {
    // SOFT supersession. Connie's supersession_coherent constraint requires BOTH the superseding
    // message and a reason — the UI collects both; we resolve an 8-hex prefix to the full id here.
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    let by = typeof body.superseded_by === "string" ? body.superseded_by.trim() : "";
    if (!reason) return json({ error: "supersede needs a reason" }, 400);
    if (!PREFIX_RE.test(by)) return json({ error: "superseded_by must be a message UUID or hex prefix" }, 400);
    if (!UUID_RE.test(by)) {
      // Prefix-tolerant resolve (by is PREFIX_RE-validated hex, safe to interpolate).
      const r = await supabase.rpc("execute_raw_sql", {
        query: `SELECT id FROM prime_messages WHERE id::text LIKE '${by}%' LIMIT 2`,
      });
      if (r.error) return json({ error: `resolve superseded_by: ${r.error.message}` }, 500);
      const m = (r.data ?? []) as Array<{ id: string }>;
      if (m.length === 0) return json({ error: `no message with id/prefix '${by}'` }, 404);
      if (m.length > 1) return json({ error: `ambiguous prefix '${by}' — supply more characters` }, 400);
      by = m[0].id;
    }
    patch.superseded_at = new Date().toISOString();
    patch.superseded_by_message_id = by;
    patch.superseded_reason = reason;
  } else if (action === "unsupersede") {
    // The recovery half of soft supersession — visible if you go looking, reversible when wrong.
    patch.superseded_at = null;
    patch.superseded_by_message_id = null;
    patch.superseded_reason = null;
  } else {
    return json({ error: "unknown action (annotate | snooze | supersede | unsupersede)" }, 400);
  }

  const { error } = await supabase.from("action_line_annotation").upsert(patch, { onConflict: "message_id" });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, action, message_id: messageId });
});
