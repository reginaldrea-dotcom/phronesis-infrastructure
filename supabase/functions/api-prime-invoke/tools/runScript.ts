// api-prime-invoke | tools/runScript | B1 Phase 4 (MR fdc37ee8; Aegis 247f51d5 + cfe2f1f4) | 7 Jun 2026
//
// run_script: the Prime composes its granted bindings programmatically in a sandboxed worker.
// read_execution_ledger: the after-the-fact mirror (Aegis PQ2 — served by the EF service client,
// since prime_cut2 cannot read the ledger). Opacity DURING, transparency AFTER.

import type { Tool } from "./types.ts";
import { runScriptInSandbox } from "../lib/sandbox.ts";
import { makeOnToolCall } from "../lib/scriptExec.ts";

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const runScriptTool: Tool = {
  definition: {
    name: "run_script",
    description:
      "Run a sandboxed script that composes your granted tools programmatically. The script runs in an isolated worker — NO network, NO filesystem, NO direct database — and its only affordance is `await call(toolName, input)` (plus `log(msg)`); return a value at the end. A declared `purpose` is required and is recorded for audit against what the run actually did. Opacity during, transparency after: the run is logged where the script cannot see it; read it back with read_execution_ledger. Bindings are a restricted, granted subset; write_claims and commit_synthesis are loop-only (they assert truth — that is the mind's act, not a program's).",
    input_schema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript body. Use `await call(tool, input)` and optionally `log(msg)`. Return a value." },
        purpose: { type: "string", description: "Declared purpose of this run — recorded and audited against actual behaviour." },
      },
      required: ["script", "purpose"],
    },
  },
  available: (o) => !o.isNewSession, // withheld on the wake turn, like the other working tools
  summarize: (i) => `run_script (${String(i?.purpose ?? "").slice(0, 40)})`,
  run: async (input, ctx) => {
    const script = String(input?.script ?? "");
    const purpose = String(input?.purpose ?? "");
    if (!script.trim()) return "run_script error: empty script";
    if (!purpose.trim()) return "run_script error: a declared purpose is required";
    const sessionId = ctx.sessionId ?? "";
    if (!sessionId) return "run_script error: no session context";

    const hash = await sha256Hex(script);

    // Open the script-run provenance row (service client; append-only). script_text + hash +
    // declared_purpose feed Argos's run-vs-declared sampling.
    let runId = "";
    try {
      const { data, error } = await ctx.supabase
        .from("execution_script_run")
        .insert({
          lineage: ctx.lineageName,
          session_id: sessionId,
          script_text: script,
          script_hash: hash,
          declared_purpose: purpose,
          status: "running",
          started_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error || !data) return `run_script error: could not open the script run (${error?.message ?? "no row returned"})`;
      runId = (data as any).id;
    } catch (e) {
      return `run_script error: ${e instanceof Error ? e.message : String(e)}`;
    }

    const onToolCall = makeOnToolCall({ lineage: ctx.lineageName, sessionId, scriptRunId: runId, service: ctx.supabase });
    const res = await runScriptInSandbox(script, { onToolCall });

    try {
      await ctx.supabase
        .from("execution_script_run")
        .update({ status: res.ok ? "completed" : "failed", finished_at: new Date().toISOString() })
        .eq("id", runId);
    } catch (e) {
      console.error("script-run close failed:", e);
    }

    const lines: string[] = [];
    lines.push(res.ok ? "Script completed." : `Script failed: ${res.error}`);
    lines.push(`Tool calls dispatched: ${res.callCount}. Run id: ${runId}.`);
    lines.push("The system record of each call is in read_execution_ledger (your transparency-after mirror).");
    if (res.logs.length) lines.push("Logs:\n" + res.logs.map((l) => "  " + l).join("\n"));
    if (res.ok && res.returnValue !== undefined) {
      lines.push("Returned: " + (typeof res.returnValue === "string" ? res.returnValue : JSON.stringify(res.returnValue)));
    }
    return lines.join("\n");
  },
};

export const readExecutionLedgerTool: Tool = {
  definition: {
    name: "read_execution_ledger",
    description:
      "Read your execution ledger — the system-authored record of what your tool calls and script runs actually did (transparency after the fact). Use it to confirm a script ran and what each binding returned, denied, or errored. You cannot write this record; it is your mirror, not your pen.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max rows (default 30, capped 100)." },
        session_only: { type: "boolean", description: "Limit to this session (default true)." },
      },
    },
  },
  available: (o) => !o.isNewSession,
  summarize: () => "read_execution_ledger",
  run: async (input, ctx) => {
    const limit = Math.min(Math.max(Number(input?.limit ?? 30), 1), 100);
    const sessionOnly = input?.session_only !== false;
    let q = ctx.supabase
      .from("execution_ledger")
      .select("via, tool, input_summary, outcome, occurred_at, script_run_id")
      .eq("lineage", ctx.lineageName)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (sessionOnly && ctx.sessionId) q = q.eq("session_id", ctx.sessionId);
    const { data, error } = await q;
    if (error) return `read_execution_ledger error: ${error.message}`;
    if (!data || !data.length) return "Execution ledger: no entries for this scope.";
    return JSON.stringify(data, null, 2);
  },
};
