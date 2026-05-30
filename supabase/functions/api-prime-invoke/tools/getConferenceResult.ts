import type { Tool } from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getConferenceResultTool: Tool = {
  definition: {
    name: "get_conference_result",
    description: "Read a conference's ratified synthesis. Returns Napoleon's most recent synthesis post (summary + body) for the given conference. Use this to read a conference result instead of composing SQL — the synthesis lives in conference_responses, not the conferences table.",
    input_schema: {
      type: "object",
      properties: {
        conference_id: { type: "string", description: "The conference UUID." },
      },
      required: ["conference_id"],
    },
  },
  // Mirrors execute_sql: a substrate read, withheld on the wake turn.
  available: ({ isNewSession }) => !isNewSession,
  summarize: (input) => `get_conference_result: ${input?.conference_id ?? ""}`,
  run: async (input, { supabase }) => {
    const id = String(input?.conference_id ?? "");
    if (!UUID_RE.test(id)) {
      return `get_conference_result error: conference_id must be a UUID. Got: ${id.slice(0, 60)}\n[SYSTEM: this is the answer — surface to Reg, do not retry.]`;
    }
    try {
      const { data, error } = await supabase.rpc("execute_raw_sql", {
        query: `SELECT summary, body FROM conference_responses WHERE conference_id = '${id}' AND posting_lineage = 'napoleon' ORDER BY created_at DESC LIMIT 1`,
      });
      if (error) {
        return `get_conference_result error: ${error.message}\n[SYSTEM: surface to Reg, do not retry.]`;
      }
      const rows = Array.isArray(data) ? data : [];
      if (rows.length === 0) {
        return `No Napoleon synthesis found for conference ${id}.\n[SYSTEM: this is the answer — the conference has no ratified synthesis yet. Do not retry with a different query.]`;
      }
      return JSON.stringify(rows[0]);
    } catch (err) {
      return `get_conference_result error: ${String(err)}\n[SYSTEM: surface to Reg, do not retry.]`;
    }
  },
};
