import type { Tool } from "./types.ts";

// Classify a statement as data-modifying so an empty result can be reported in
// the right dialect: an empty SELECT means "nothing matched" (the answer), but an
// empty INSERT/UPDATE/DELETE means "no RETURNING clause" — NOT a confirmation of
// what changed. Conflating the two is what made writes-via-execute_sql a
// confabulation/double-write hazard. Leading keyword catches the common case; a
// data-modifying CTE (WITH … INSERT/UPDATE/DELETE) is caught by the second test.
function isWriteStatement(query: string): boolean {
  const head = String(query ?? "")
    .replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, "")
    .slice(0, 4000);
  if (/^\s*(insert|update|delete|merge)\b/i.test(head)) return true;
  if (/^\s*with\b/i.test(head) && /\b(insert|update|delete)\b/i.test(head)) return true;
  return false;
}

export const executeSqlTool: Tool = {
  definition: {
    name: "execute_sql",
    description: "Execute a SQL query against the Phronesis Supabase database. Use this for database reads and writes. Returns results as a JSON array. For writes (INSERT/UPDATE/DELETE), add a RETURNING clause (e.g. RETURNING id) so you get a handle back confirming what changed — without it a write returns no rows and cannot confirm it landed. Where a purpose-built tool exists (e.g. send_message), prefer it over a raw write.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The SQL query to execute. Use single quotes for string literals." },
      },
      required: ["query"],
    },
  },
  // execute_sql is withheld on the wake turn (new session), matching the original.
  available: ({ isNewSession }) => !isNewSession,
  summarize: (input) => `execute_sql: ${String(input?.query ?? "").slice(0, 120)}`,
  run: async (input, { supabase }) => {
    try {
      const { data: sqlData, error: sqlError } = await supabase.rpc("execute_raw_sql", { query: input.query });
      if (sqlError) {
        return `SQL Error: ${sqlError.message}\n[SYSTEM: this is the answer — surface this error to Reg immediately. Do not retry with another query.]`;
      } else if (Array.isArray(sqlData) && sqlData.length === 0) {
        if (isWriteStatement(input.query)) {
          return `[]\n[SYSTEM: this was a write (INSERT/UPDATE/DELETE) and it returned no rows — that is exactly what a write WITHOUT a RETURNING clause looks like. It does NOT tell you whether, or how many, rows changed. Do not assume it failed, and do NOT re-run it to "make sure" — re-running can duplicate the write. To get a handle next time, add e.g. "RETURNING id"; to confirm what landed now, run a SELECT. This is the system speaking, not a result.]`;
        }
        return `[]\n[SYSTEM: empty result — this is the answer. Do not retry with a different query. Report to Reg what you queried and what it returned.]`;
      }
      return JSON.stringify(sqlData ?? []);
    } catch (err) {
      return `Execution error: ${String(err)}\n[SYSTEM: surface this error to Reg immediately. Do not retry.]`;
    }
  },
};
