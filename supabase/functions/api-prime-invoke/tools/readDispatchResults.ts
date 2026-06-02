// read_dispatch_results — Theo's read tool for engine_dispatch outputs.
//
// Given a theo_session_id (UUID or hex prefix), returns:
//   - session header (state, refined_prompt, rationale, timestamps)
//   - per-engine status counts (pending / dispatched / completed / partial / failed)
//   - per-row details with quality signals: source count, text length, finish reason,
//     dispatched_at, response_received_at, tokens, error_detail, plus a short text
//     excerpt so Theo can scan without pulling the full payload via execute_sql.
//
// The full response (including the raw provider envelope) is stored in
// engine_dispatch.response_raw as JSON of the worker's AdapterResponse shape
// { text, sources[], labels[], usage, raw }. This tool parses that JSON and
// surfaces structured quality signals. If response_raw is malformed JSON
// (defensive — shouldn't happen), the row is reported with parse_error=true.

import type { Tool, ToolContext } from "./types.ts";

const ID_RE = /^[0-9a-f-]{4,36}$/i;
const EXCERPT_LEN = 800;

interface ParsedResponse {
  text?: string;
  sources?: unknown[];
  labels?: Array<{ key?: string; value?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
  raw?: unknown;
}

function safeParse(s: string | null): { ok: true; parsed: ParsedResponse } | { ok: false; reason: string } {
  if (!s) return { ok: false, reason: "empty" };
  try {
    return { ok: true, parsed: JSON.parse(s) as ParsedResponse };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

function excerpt(text: string | undefined): string {
  if (!text) return "";
  return text.length > EXCERPT_LEN ? text.slice(0, EXCERPT_LEN) + " …[truncated]" : text;
}

function fail(msg: string): string {
  return `read_dispatch_results error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const readDispatchResultsTool: Tool = {
  definition: {
    name: "read_dispatch_results",
    description:
      "Read the current state of a dispatched research session (theo_session + its engine_dispatch rows). Use when a completion wake_delta tells you a dispatch is done — or to check progress mid-flight. Returns the session header, per-status counts, and per-engine quality signals (source count, finish reason, token usage, error detail, text excerpt). For the full text of any engine's response, follow up with execute_sql against engine_dispatch.response_raw (which holds the full AdapterResponse JSON including the raw provider envelope).",
    input_schema: {
      type: "object",
      properties: {
        theo_session_id: { type: "string", description: "Session id — full UUID or a leading hex prefix." },
      },
      required: ["theo_session_id"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => `read_dispatch_results: ${String((input as { theo_session_id?: unknown })?.theo_session_id ?? "").slice(0, 12)}`,

  run: async (input, ctx: ToolContext) => {
    const raw = String((input as { theo_session_id?: unknown })?.theo_session_id ?? "").trim();
    if (!ID_RE.test(raw)) return fail(`theo_session_id must be a UUID or hex prefix. Got: ${raw.slice(0, 40)}`);

    // Resolve full UUID via prefix match (executeSql precedent — id::text LIKE prefix%)
    const sessionLookup = await ctx.supabase.rpc("execute_raw_sql", {
      query: `SELECT id, state, original_brief, refined_prompt, engine_selection_rationale, anonymisation_mode, created_at, delivered_at FROM theo_session WHERE id::text LIKE '${raw}%' LIMIT 2`,
    });
    if (sessionLookup.error) return fail(`session lookup failed: ${sessionLookup.error.message}`);
    const sessRows = (sessionLookup.data ?? []) as Array<{
      id: string; state: string; original_brief: string | null; refined_prompt: string | null;
      engine_selection_rationale: string | null; anonymisation_mode: string | null;
      created_at: string; delivered_at: string | null;
    }>;
    if (sessRows.length === 0) return `[]\n[SYSTEM: no theo_session with id starting '${raw}'. Ids are table-scoped — confirm this is a theo_session_id. This is the answer; do not retry.]`;
    if (sessRows.length > 1) return fail(`prefix '${raw}' matches ${sessRows.length} sessions — supply more characters.`);
    const session = sessRows[0];

    // Engine rows
    const dispatch = await ctx.supabase
      .from("engine_dispatch")
      .select("id, engine_name, role_in_dispatch, role_description, status, provider_job_ref, dispatched_at, response_received_at, response_raw, tokens_in, tokens_out, cost_usd, error_detail")
      .eq("theo_session_id", session.id)
      .order("engine_name");
    if (dispatch.error) return fail(`engine_dispatch read failed: ${dispatch.error.message}`);
    const engineRows = (dispatch.data ?? []) as Array<{
      id: string; engine_name: string; role_in_dispatch: string; role_description: string | null;
      status: string; provider_job_ref: string | null; dispatched_at: string | null;
      response_received_at: string | null; response_raw: string | null;
      tokens_in: number | null; tokens_out: number | null; cost_usd: number | null;
      error_detail: string | null;
    }>;

    const counts = { pending: 0, dispatched: 0, completed: 0, partial: 0, failed: 0 };
    const engines = engineRows.map(r => {
      if (r.status in counts) counts[r.status as keyof typeof counts]++;

      const parsed = safeParse(r.response_raw);
      let textLength: number | null = null;
      let sourceCount: number | null = null;
      let textExcerpt: string | null = null;
      let labels: Array<{ key: string; value: string }> = [];
      let parseError: string | null = null;

      if (parsed.ok) {
        const p = parsed.parsed;
        textLength = typeof p.text === "string" ? p.text.length : null;
        sourceCount = Array.isArray(p.sources) ? p.sources.length : null;
        textExcerpt = typeof p.text === "string" ? excerpt(p.text) : null;
        labels = Array.isArray(p.labels)
          ? p.labels
              .filter((l): l is { key: string; value: string } =>
                typeof l?.key === "string" && typeof l?.value === "string")
              .map(l => ({ key: l.key, value: l.value }))
          : [];
      } else if (r.response_raw) {
        parseError = parsed.reason;
      }

      return {
        id: r.id,
        engine_name: r.engine_name,
        role: r.role_in_dispatch,
        role_description: r.role_description,
        status: r.status,
        dispatched_at: r.dispatched_at,
        response_received_at: r.response_received_at,
        tokens_in: r.tokens_in,
        tokens_out: r.tokens_out,
        cost_usd: r.cost_usd,
        error_detail: r.error_detail,
        text_length: textLength,
        source_count: sourceCount,
        text_excerpt: textExcerpt,
        labels,
        parse_error: parseError,
      };
    });

    const terminal = counts.completed + counts.partial + counts.failed;
    const inFlight = counts.pending + counts.dispatched;
    let systemNote: string;
    if (engineRows.length === 0) {
      systemNote = "session has no engine_dispatch rows — enqueue_dispatch was not called or rolled back. This is the answer; do not retry.";
    } else if (inFlight > 0) {
      systemNote = `${inFlight} of ${engineRows.length} engines still in flight (pending/dispatched); ${terminal} terminal. Wait for the completion wake_delta before synthesising.`;
    } else if (counts.completed + counts.partial === 0) {
      systemNote = `all ${counts.failed} engines failed — read error_detail per row and decide whether to re-enqueue with different engines or surface the failure to the user.`;
    } else {
      systemNote = `dispatch complete — ${counts.completed} completed, ${counts.partial} partial, ${counts.failed} failed. Proceed to comparison/synthesis. Full text + raw provider payload available in engine_dispatch.response_raw if needed.`;
    }

    return JSON.stringify({
      session: {
        id: session.id,
        state: session.state,
        original_brief: session.original_brief,
        refined_prompt: session.refined_prompt,
        engine_selection_rationale: session.engine_selection_rationale,
        anonymisation_mode: session.anonymisation_mode,
        created_at: session.created_at,
        delivered_at: session.delivered_at,
      },
      counts,
      engines,
      "[SYSTEM]": systemNote,
    });
  },
};
