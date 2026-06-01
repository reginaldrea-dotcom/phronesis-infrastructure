// Purpose-built read tools that hide the table choice — the recurring "found the
// wrong table" tax (wake_deltas searched in prime_messages; a message-id looked up in
// artifacts; a conference-id confusion). The Prime calls the tool; the table and the
// caller-scoping are baked in, so there is no table to find and no SQL to miswrite.
// Reads only; scoped to the calling lineage (from ToolContext, not a model claim).

import type { Tool, ToolContext } from "./types.ts";

const ID_RE      = /^[0-9a-f-]{4,36}$/i;   // full UUID or a leading hex prefix
const LINEAGE_RE = /^[a-z][a-z0-9_]*$/i;   // simple identifier; guards the SQL interpolation

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
