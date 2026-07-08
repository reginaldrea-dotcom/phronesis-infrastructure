// Conference participation tools — the harness surface a Prime needs to take a seat:
// read the charge, read the responses (blind-round enforced), post its own response.
// Mirrors messaging.ts: the table choice and caller-scoping are baked in (no SQL to
// miswrite), reads go through execute_raw_sql, and the WRITE stamps the posting lineage
// from ToolContext (the caller's own identity) — never a model claim, so a Prime can
// only ever post AS ITSELF.
//
// Tool names match the tool_grants families already approved for the participating
// lineages: read_conferences / read_conference_responses / post_conference_response.

import type { Tool, ToolContext } from "./types.ts";

const ID_RE        = /^[0-9a-f-]{4,36}$/i;   // full UUID or a leading hex prefix
const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINEAGE_RE   = /^[a-z][a-z0-9_]*$/i;   // simple identifier; guards the SQL interpolation

function callerLineage(ctx: ToolContext): string | null {
  return LINEAGE_RE.test(ctx.lineageName ?? "") ? ctx.lineageName : null;
}

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

// read_conferences — with a conference_id, returns that conference's full charge (topic + body +
// seats + current_round + status). Without one, LISTS the open conferences you are seated in or
// synthesise, so a waking Prime can discover it has been convened. No SQL, no table to find.
export const readConferencesTool: Tool = {
  definition: {
    name: "read_conferences",
    description:
      "Read conferences. With conference_id: returns that conference's full charge — topic, body (the charge you answer), invited_lineages (the seats), synthesist_lineage, current_round, status. Without conference_id: LISTS the OPEN conferences you are seated in or synthesise (id, topic, current_round, status) so you can discover you have been convened. No SQL needed.",
    input_schema: {
      type: "object",
      properties: {
        conference_id: { type: "string", description: "Optional. A conference UUID (or leading hex prefix). Omit to list the open conferences you are part of." },
      },
      required: [],
    },
  },
  available: ({ isNewSession }) => !isNewSession,
  summarize: (input) => (input?.conference_id ? `read_conferences: ${input.conference_id}` : "read_conferences (my open conferences)"),
  run: async (input, ctx) => {
    const lin = callerLineage(ctx);
    if (!lin) return "read_conferences error: caller lineage unavailable.\n[SYSTEM: surface to Reg.]";
    const id = String(input?.conference_id ?? "").trim();
    if (id) {
      if (!ID_RE.test(id)) return `read_conferences error: conference_id must be a UUID or hex prefix. Got: ${id.slice(0, 40)}\n[SYSTEM: surface to Reg, do not retry.]`;
      return runSelect(ctx,
        `SELECT id, topic, body, invited_lineages, synthesist_lineage, current_round, status, conference_type, created_at
         FROM conferences WHERE id::text LIKE '${id}%'`,
        `no conference with id starting '${id}'. Ids are table-scoped — this may be an id from another table. This is the answer; do not retry.`);
    }
    return runSelect(ctx,
      `SELECT id, topic, current_round, status, synthesist_lineage, created_at
       FROM conferences
       WHERE status = 'open' AND ('${lin}' = ANY(invited_lineages) OR synthesist_lineage = '${lin}')
       ORDER BY created_at DESC`,
      "no open conferences you are seated in. This is the answer; do not retry.");
  },
};

// read_conference_responses — reads the responses, with the BLIND-ROUND rule enforced BELOW THE MODEL:
// you see a response only if its round has CLOSED (round < the conference's current_round), or it is your
// own, or you are the synthesist. So during an open blind round you cannot read the other seats' current-
// round answers — the wall is structural, not a promise in the brief. When the round advances, prior-round
// responses become visible to everyone.
export const readConferenceResponsesTool: Tool = {
  definition: {
    name: "read_conference_responses",
    description:
      "Read the responses posted in a conference. BLIND-ROUND enforced: you see a response only if its round has already CLOSED (round below the conference's current round), or it is your OWN, or you are the synthesist. During an open blind round you cannot read the other seats' current-round answers — post yours first; they become readable when the round advances. Returns posting_lineage, round, summary, body, created_at. Optional: round (restrict to one round).",
    input_schema: {
      type: "object",
      properties: {
        conference_id: { type: "string", description: "The conference UUID (or leading hex prefix)." },
        round:         { type: "integer", description: "Optional. Restrict to a single round number." },
      },
      required: ["conference_id"],
    },
  },
  available: ({ isNewSession }) => !isNewSession,
  summarize: (input) => `read_conference_responses: ${input?.conference_id ?? ""}`,
  run: async (input, ctx) => {
    const lin = callerLineage(ctx);
    if (!lin) return "read_conference_responses error: caller lineage unavailable.\n[SYSTEM: surface to Reg.]";
    const id = String(input?.conference_id ?? "").trim();
    if (!ID_RE.test(id)) return `read_conference_responses error: conference_id must be a UUID or hex prefix. Got: ${id.slice(0, 40)}\n[SYSTEM: surface to Reg, do not retry.]`;
    let roundClause = "";
    if (input?.round != null) {
      const r = parseInt(String(input.round), 10);
      if (!Number.isFinite(r) || r < 1) return "read_conference_responses error: round must be an integer >= 1.\n[SYSTEM: surface to Reg, do not retry.]";
      roundClause = ` AND r.round = ${r}`;
    }
    // The visibility filter IS the blind wall: closed round, or own, or synthesist.
    return runSelect(ctx,
      `SELECT r.posting_lineage, r.round, r.summary, r.body, r.created_at
       FROM conference_responses r
       JOIN conferences c ON c.id = r.conference_id
       WHERE r.conference_id::text LIKE '${id}%'${roundClause}
         AND (r.round < c.current_round OR r.posting_lineage = '${lin}' OR c.synthesist_lineage = '${lin}')
       ORDER BY r.round, r.created_at`,
      "no responses visible to you yet. If this is an open BLIND round, the other seats' current-round answers are withheld until the round closes — post yours, then they become readable. This is the answer; do not retry.");
  },
};

// post_conference_response — the write. Stamps YOU as the poster from ToolContext (not a model field, so
// you cannot post as another seat), defaults the round to the conference's CURRENT round, and returns the
// stored row so the post is self-verifying. Goes through the post_conference_response RPC (validates the
// conference is open; one response per lineage per round).
export const postConferenceResponseTool: Tool = {
  definition: {
    name: "post_conference_response",
    description:
      "Post YOUR response to a conference. Use this rather than an INSERT: it stamps you as the poster from your own identity, defaults to the conference's CURRENT round, and RETURNS the stored row so you can confirm it posted. summary is a one-paragraph headline of your position; body is the full argument. One response per seat per round (re-posting the same round is refused).",
    input_schema: {
      type: "object",
      properties: {
        conference_id: { type: "string", description: "The conference UUID (full UUID or leading hex prefix)." },
        summary:       { type: "string", description: "One-paragraph headline of your position — what the room reads first." },
        body:          { type: "string", description: "The full response / argument." },
        round:         { type: "integer", description: "Optional. Defaults to the conference's current round." },
      },
      required: ["conference_id", "summary", "body"],
    },
  },
  available: ({ isNewSession }) => !isNewSession,
  summarize: (input) => `post_conference_response: ${input?.conference_id ?? ""}`,
  run: async (input, ctx) => {
    const lin = callerLineage(ctx);
    if (!lin) return "post_conference_response error: caller lineage unavailable.\n[SYSTEM: surface to Reg.]";
    const rawId = String(input?.conference_id ?? "").trim();
    const summary = typeof input?.summary === "string" ? input.summary : "";
    const body = typeof input?.body === "string" ? input.body : "";
    if (!ID_RE.test(rawId)) return `post_conference_response error: conference_id must be a UUID or hex prefix. Got: ${rawId.slice(0, 40)}\n[SYSTEM: surface to Reg, do not retry.]`;
    if (!summary.trim()) return "post_conference_response error: summary is required (a one-paragraph headline).\n[SYSTEM: surface to Reg, do not retry.]";
    if (!body.trim()) return "post_conference_response error: body is required (the full response).\n[SYSTEM: surface to Reg, do not retry.]";

    // Resolve id (prefix -> full) and read the current round so we post to the ACTIVE round by default.
    let confId = rawId;
    let currentRound = 1;
    try {
      const { data, error } = await ctx.supabase.rpc("execute_raw_sql", {
        query: `SELECT id, current_round, status FROM conferences WHERE id::text LIKE '${rawId}%' LIMIT 2`,
      });
      if (error) return `post_conference_response error: ${error.message}\n[SYSTEM: surface to Reg, do not retry.]`;
      const rows = (Array.isArray(data) ? data : []) as Array<{ id: string; current_round: number; status: string }>;
      if (rows.length === 0) return `post_conference_response error: no conference with id starting '${rawId}'.\n[SYSTEM: surface to Reg, do not retry.]`;
      if (rows.length > 1) return `post_conference_response error: ambiguous conference id '${rawId}' — supply more characters.\n[SYSTEM: surface to Reg, do not retry.]`;
      confId = rows[0].id;
      currentRound = Number(rows[0].current_round) || 1;
      if (rows[0].status !== "open") return `post_conference_response error: conference ${confId.slice(0, 8)} is not open (status: ${rows[0].status}).\n[SYSTEM: this is the answer; do not retry.]`;
    } catch (err) {
      return `post_conference_response error: ${String(err)}\n[SYSTEM: surface to Reg, do not retry.]`;
    }

    let round = currentRound;
    if (input?.round != null) {
      const r = parseInt(String(input.round), 10);
      if (!Number.isFinite(r) || r < 1) return "post_conference_response error: round must be an integer >= 1.\n[SYSTEM: surface to Reg, do not retry.]";
      round = r;
    }

    const instanceId = FULL_UUID_RE.test(String(ctx.instanceId ?? "")) ? ctx.instanceId : null;
    const { data, error } = await ctx.supabase.rpc("post_conference_response", {
      p_conference_id: confId,
      p_posting_lineage: lin,          // YOUR identity from ToolContext — never a model field
      p_summary: summary,
      p_body: body,
      p_round: round,
      p_posting_instance_id: instanceId,
    });
    if (error) return `post_conference_response error: ${error.message}\n[SYSTEM: surface to Reg, do not retry — if it says you already posted this round, that is the answer.]`;
    const row = Array.isArray(data) ? data[0] : data;
    return JSON.stringify({
      posted: row,
      "[SYSTEM]": `your response for round ${round} of conference ${confId.slice(0, 8)} is recorded (response ${String(row?.id ?? "").slice(0, 8)}). This is the authoritative record — do not re-post. Other seats' current-round answers stay blind until the round advances.`,
    });
  },
};
