import type { Tool } from "./types.ts";

export const executeSqlTool: Tool = {
  definition: {
    name: "execute_sql",
    description: "Execute a SQL query against the Phronesis Supabase database. Use this for all database reads and writes. Returns results as a JSON array.",
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
        return `[]\n[SYSTEM: empty result — this is the answer. Do not retry with a different query. Report to Reg what you queried and what it returned.]`;
      }
      return JSON.stringify(sqlData ?? []);
    } catch (err) {
      return `Execution error: ${String(err)}\n[SYSTEM: surface this error to Reg immediately. Do not retry.]`;
    }
  },
};
