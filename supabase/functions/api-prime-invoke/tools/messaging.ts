// Purpose-built read tools that hide the table choice — the recurring "found the
// wrong table" tax (wake_deltas searched in prime_messages; a message-id looked up in
// artifacts; a conference-id confusion). The Prime calls the tool; the table and the
// caller-scoping are baked in, so there is no table to find and no SQL to miswrite.
// Reads only; scoped to the calling lineage (from ToolContext, not a model claim).

import type { Tool, ToolContext } from "./types.ts";

const ID_RE        = /^[0-9a-f-]{4,36}$/i;   // full UUID or a leading hex prefix
const LINEAGE_RE   = /^[a-z][a-z0-9_]*$/i;   // simple identifier; guards the SQL interpolation
const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CHECK-enforced vocab on prime_messages (mirrored here to fail fast with a clear
// message instead of a raw 23514). Keep in sync with the table constraints.
const VALID_MESSAGE_TYPES = new Set(["nf", "mr_draft", "request", "response", "status", "schema_proposal", "broadcast"]);
const VALID_ATTENTION     = new Set(["low", "moderate", "urgent"]);

function callerLineage(ctx: ToolContext): string | null {
  return LINEAGE_RE.test(ctx.lineageName ?? "") ? ctx.lineageName : null;
}

// Mirrors executeSql's result shape: JSON array, or a [SYSTEM]-tagged empty/error so
// "empty is the answer" reads the same way the model already knows.
async function runSelect(ctx: ToolContext, query: string, emptyMsg: string): Promise<string> {
  try {
    const { data, error } = await ctx.supabase.rpc("execute_raw_sql", { query });
    if (error) return `query error: ${error.message}\n[SYSTEM: this is the answer — surface to Reg, do not retry.]`;
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) return `[]\n[SYSTEM: ${emptyMsg}]`;
    return JSON.stringify(rows);
  } catch (err) {
    return `execution error: ${String(err)}\n[SYSTEM: surface to Reg, do not retry.]`;
  }
}

export const readWakeDeltasTool: Tool = {
  definition: {
    name: "read_wake_deltas",
    description: "Read YOUR unconsumed wake_deltas (wake notes addressed to you from other Primes). No SQL or table name needed — this targets the wake_deltas table for your own lineage. Returns id, from_lineage, note, created_at.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  available: ({ isNewSession }) => !isNewSession,
  summarize: () => "read_wake_deltas",
  run: async (_input, ctx) => {
    const lin = callerLineage(ctx);
    if (!lin) return "read_wake_deltas error: caller lineage unavailable.\n[SYSTEM: surface to Reg.]";
    return runSelect(ctx,
      `SELECT id, from_lineage, note, created_at FROM wake_deltas WHERE to_lineage = '${lin}' AND consumed_at IS NULL ORDER BY created_at`,
      "no unconsumed wake_deltas — you are caught up. This is the answer; do not retry.");
  },
};

export const readInboxTool: Tool = {
  definition: {
    name: "read_inbox",
    description: "Read YOUR unread inbox — prime_messages addressed to you (to_lineage = your lineage) not yet acknowledged. No SQL needed. Returns id, from_lineage, subject, body, message_type, attention_level, status, created_at.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  available: ({ isNewSession }) => !isNewSession,
  summarize: () => "read_inbox",
  run: async (_input, ctx) => {
    const lin = callerLineage(ctx);
    if (!lin) return "read_inbox error: caller lineage unavailable.\n[SYSTEM: surface to Reg.]";
    return runSelect(ctx,
      `SELECT id, from_lineage, subject, body, message_type, attention_level, status, created_at FROM prime_messages WHERE to_lineage = '${lin}' AND acknowledged_at IS NULL ORDER BY created_at DESC`,
      "inbox empty — no unread messages. This is the answer; do not retry.");
  },
};

export const getMessageTool: Tool = {
  definition: {
    name: "get_message",
    description: "Read a specific prime_message by id (full UUID or a leading hex prefix) — use this when you hold a message id, instead of guessing which table it lives in. Scoped to messages you sent or received. Returns the full row.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Message id — full UUID or a leading hex prefix." } },
      required: ["id"],
    },
  },
  available: ({ isNewSession }) => !isNewSession,
  summarize: (input) => `get_message: ${input?.id ?? ""}`,
  run: async (input, ctx) => {
    const id = String(input?.id ?? "").trim();
    if (!ID_RE.test(id)) return `get_message error: id must be a UUID or hex prefix. Got: ${id.slice(0, 40)}\n[SYSTEM: surface to Reg, do not retry.]`;
    const lin = callerLineage(ctx);
    if (!lin) return "get_message error: caller lineage unavailable.\n[SYSTEM: surface to Reg.]";
    return runSelect(ctx,
      `SELECT id, from_lineage, to_lineage, subject, body, message_type, attention_level, status, created_at, acknowledged_at FROM prime_messages WHERE id::text LIKE '${id}%' AND (to_lineage = '${lin}' OR from_lineage = '${lin}')`,
      `no message with id starting '${id}' to or from you. Ids are table-scoped — this may be an id from another table (artifacts, conferences, wake_deltas), not prime_messages. This is the answer; do not retry.`);
  },
};

// read_prime_messages — your inbox reader, INCLUDING already-read messages (read_inbox is unread-only).
// Angelia's grant is tool_family 'read_prime_messages'; this is the tool it resolves to. Reads need no
// dedicated SECURITY DEFINER RPC (that pattern is for writes) — like read_inbox it goes through the generic
// execute_raw_sql path, scoped to the caller's own lineage from ToolContext (never a model claim).
export const readPrimeMessagesTool: Tool = {
  definition: {
    name: "read_prime_messages",
    description: "Read prime_messages addressed to YOU (to_lineage = your lineage), most recent first — your inbox, INCLUDING already-read messages (read_inbox returns only unread). No SQL or table name needed; scoped to your own lineage. Returns id, from_lineage, subject, body, message_type, attention_level, status, created_at, acknowledged_at. Optional: limit (default 20, max 100); unread_only (only not-yet-acknowledged).",
    input_schema: {
      type: "object",
      properties: {
        limit:       { type: "integer", description: "Max messages to return (default 20, max 100)." },
        unread_only: { type: "boolean", description: "If true, return only messages you have not acknowledged." },
      },
      required: [],
    },
  },
  available: ({ isNewSession }) => !isNewSession,
  summarize: (input) => `read_prime_messages${input?.unread_only ? " (unread)" : ""}`,
  run: async (input, ctx) => {
    const lin = callerLineage(ctx);
    if (!lin) return "read_prime_messages error: caller lineage unavailable.\n[SYSTEM: surface to Reg.]";
    const limit = Math.min(100, Math.max(1, parseInt(String(input?.limit ?? 20), 10) || 20));
    const unread = input?.unread_only === true ? " AND acknowledged_at IS NULL" : "";
    return runSelect(ctx,
      `SELECT id, from_lineage, subject, body, message_type, attention_level, status, created_at, acknowledged_at FROM prime_messages WHERE to_lineage = '${lin}'${unread} ORDER BY created_at DESC LIMIT ${limit}`,
      "no messages addressed to you. This is the answer; do not retry.");
  },
};

// send_message — the write counterpart to read_inbox/get_message. Replaces the
// raw `INSERT INTO prime_messages …` via execute_sql, which returned no handle
// and an ambiguous empty result (a sent message and a no-op read looked the
// same). Here the sender is stamped from ToolContext (your own identity, not a
// model claim), the body is parameterised (PostgREST, not interpolated SQL), and
// the stored row is RETURNED so the send is self-verifying.
export const sendMessageTool: Tool = {
  definition: {
    name: "send_message",
    description:
      "Send a prime_message to another Prime's inbox. Use THIS rather than an INSERT via execute_sql: it targets prime_messages, stamps you as the sender from your own identity, and RETURNS the stored row (id, created_at, status) so you can confirm it actually sent without re-checking. to_lineage must be the recipient's CANONICAL lineage (e.g. 'constantinople', never the nickname 'connie' — a message to the wrong lineage is invisible to its inbox).",
    input_schema: {
      type: "object",
      properties: {
        to_lineage:      { type: "string", description: "Recipient's canonical lineage (e.g. 'constantinople'). The lineage, not a nickname or URL." },
        body:            { type: "string", description: "The message body." },
        subject:         { type: "string", description: "Optional subject line." },
        message_type:    { type: "string", enum: ["nf", "mr_draft", "request", "response", "status", "schema_proposal", "broadcast"], description: "Optional message type." },
        attention_level: { type: "string", enum: ["low", "moderate", "urgent"], description: "Optional. Defaults to 'low'." },
        related_ids:     { type: "array", items: { type: "string" }, description: "Optional: full UUIDs of related rows (artifacts, sessions, messages) for context." },
      },
      required: ["to_lineage", "body"],
    },
  },
  available: ({ isNewSession }) => !isNewSession,
  summarize: (input) => `send_message: to ${input?.to_lineage ?? "?"}`,
  run: async (input, ctx) => {
    const from = callerLineage(ctx);
    if (!from) return "send_message error: caller lineage unavailable.\n[SYSTEM: surface to Reg.]";

    const to = typeof input?.to_lineage === "string" ? input.to_lineage.trim() : "";
    const body = typeof input?.body === "string" ? input.body : "";
    if (!LINEAGE_RE.test(to)) {
      return `send_message error: to_lineage must be a bare lineage identifier (got '${to.slice(0, 40)}'). Use the canonical lineage, e.g. 'constantinople' not 'connie'.\n[SYSTEM: surface to Reg, do not retry.]`;
    }
    if (!body.trim()) return "send_message error: body is required (non-empty string).\n[SYSTEM: surface to Reg, do not retry.]";

    const row: Record<string, unknown> = { from_lineage: from, to_lineage: to, body };
    if (typeof input?.subject === "string" && input.subject.trim()) row.subject = input.subject;
    if (input?.message_type != null) {
      const mt = String(input.message_type).trim();
      if (!VALID_MESSAGE_TYPES.has(mt)) return `send_message error: message_type '${mt}' is invalid. Valid: ${[...VALID_MESSAGE_TYPES].join(", ")}.\n[SYSTEM: surface to Reg, do not retry.]`;
      row.message_type = mt;
    }
    if (input?.attention_level != null) {
      const al = String(input.attention_level).trim();
      if (!VALID_ATTENTION.has(al)) return `send_message error: attention_level '${al}' is invalid. Valid: low, moderate, urgent.\n[SYSTEM: surface to Reg, do not retry.]`;
      row.attention_level = al;
    }
    if (Array.isArray(input?.related_ids) && input.related_ids.length > 0) {
      const ids = input.related_ids.map((x: unknown) => String(x).trim());
      const bad = ids.find((s: string) => !FULL_UUID_RE.test(s));
      if (bad) return `send_message error: related_ids must be full UUIDs (got '${bad.slice(0, 40)}').\n[SYSTEM: surface to Reg, do not retry.]`;
      row.related_ids = ids;
    }

    const ins = await ctx.supabase
      .from("prime_messages")
      .insert(row)
      .select("id, from_lineage, to_lineage, subject, message_type, attention_level, status, created_at")
      .single();
    if (ins.error) return `send_message error: ${ins.error.message}\n[SYSTEM: surface to Reg, do not retry.]`;

    return JSON.stringify({
      sent: ins.data,
      "[SYSTEM]": `message ${String(ins.data.id).slice(0, 8)} is now in ${to}'s inbox (status '${ins.data.status}'). This is the authoritative record of the send — you do not need to re-send or re-check. You can read it back any time with get_message.`,
    });
  },
};

export const consumeWakeDeltasTool: Tool = {
  definition: {
    name: "consume_wake_deltas",
    description: "Mark YOUR wake_deltas consumed (sets consumed_at) once you have read and actioned them. With no argument, consumes ALL your currently-unconsumed deltas; pass ids to consume a specific subset. Returns the ids consumed. Read them first with read_wake_deltas. (Consumed deltas are not deleted — still queryable; and a re-run consumes nothing, so it is safe to repeat.)",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Optional: specific delta ids (full UUID or hex prefix) to consume. Omit to consume all your unconsumed deltas." },
      },
      required: [],
    },
  },
  available: ({ isNewSession }) => !isNewSession,
  summarize: (input) =>
    Array.isArray(input?.ids) && input.ids.length ? `consume_wake_deltas: ${input.ids.length} id(s)` : "consume_wake_deltas (all unconsumed)",
  run: async (input, ctx) => {
    const lin = callerLineage(ctx);
    if (!lin) return "consume_wake_deltas error: caller lineage unavailable.\n[SYSTEM: surface to Reg.]";
    let idClause = "";
    if (Array.isArray(input?.ids) && input.ids.length > 0) {
      const ids = input.ids.map((x: unknown) => String(x).trim()).filter((s: string) => ID_RE.test(s));
      if (ids.length === 0) return "consume_wake_deltas error: ids must be UUIDs or hex prefixes.\n[SYSTEM: surface to Reg, do not retry.]";
      idClause = " AND (" + ids.map((s: string) => `id::text LIKE '${s}%'`).join(" OR ") + ")";
    }
    try {
      const { data, error } = await ctx.supabase.rpc("execute_raw_sql", {
        query: `UPDATE wake_deltas SET consumed_at = now() WHERE to_lineage = '${lin}' AND consumed_at IS NULL${idClause} RETURNING id`,
      });
      if (error) return `consume_wake_deltas error: ${error.message}\n[SYSTEM: surface to Reg, do not retry.]`;
      const rows = Array.isArray(data) ? data : [];
      if (rows.length === 0) return "[]\n[SYSTEM: nothing to consume — no matching unconsumed deltas. This is the answer; do not retry.]";
      return JSON.stringify({ consumed: rows.map((r: { id: string }) => r.id), count: rows.length });
    } catch (err) {
      return `consume_wake_deltas error: ${String(err)}\n[SYSTEM: surface to Reg, do not retry.]`;
    }
  },
};
