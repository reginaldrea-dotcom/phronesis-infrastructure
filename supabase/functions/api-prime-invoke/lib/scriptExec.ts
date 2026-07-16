// api-prime-invoke | scriptExec | B1 Phase 3+4 (MR fdc37ee8; Aegis 247f51d5 + cfe2f1f4) | 7 Jun 2026
//
// Mediates every call() a sandboxed script makes: registry membership → grants check
// (deny-by-default) → execute under prime_cut2 scope (db bindings) or in the parent EF
// (non-db bindings) → write the execution_ledger row with the SERVICE client (the opacity
// gap — a different connection than the script's cut2 path; the script can neither see nor
// write its own log). Transparency comes AFTER, via the read_execution_ledger tool.

import type { SupabaseClient } from "../tools/types.ts";
import { withCut2 } from "./cut2conn.ts";
import { digestToolCall, extractLedgerJuncture } from "./provenance.ts";

export interface ScriptRunCtx {
  lineage: string;
  sessionId: string;
  scriptRunId: string;
  service: SupabaseClient;
}

interface BindingCtx { lineage: string; sessionId: string; service: SupabaseClient; }

interface Binding {
  kind: "db" | "parent";          // db → runs under cut2 (tx); parent → runs in the EF (own credential)
  grant: { family: string; scope: string }; // looked up against tool_grants.script_scopes (deny-by-default)
  run: (input: any, ctx: BindingCtx, tx?: any) => Promise<unknown>;
}

// ── v1 binding set — grant-honest to prime_cut2's verified footprint ──────────────────────
// prime_cut2 can SELECT exactly render_source_v1 + render_claim_v1 (verified 7 Jun). So v1 is
// the READ/TRANSPORT tier over those two views, scoped by the session_id argument. This proves
// the scoped-execution + grants + ledger + opacity path end to end on internal Primes.
//
// DEFERRED (named, not silent — each needs a sanctioned function or a grant expansion in Connie's
// lane before it can be a cut2 binding): read_synthesis, enqueue_dispatch (the dispatch program),
// write_synthesis_section, deliver_artefact, send_message, write_github_file (parent/github token).
// EXCLUDED as invariants (Aegis): execute_sql, consume_wake_deltas, file_super_t, write_claims,
// commit_synthesis.
//
// SCOPING NOTE (flagged to Connie/Aegis): the two render views are read by argument (session_id);
// per-Prime ROW isolation under cut2 (via the request.jwt.claims GUC) requires the views be
// security_invoker with RLS reading the claim — a hardening step before any client-data Prime.
const BINDINGS: Record<string, Binding> = {
  read_dispatch_results: {
    kind: "db",
    grant: { family: "research", scope: "read" },
    run: async (input, _ctx, tx) => {
      const sid = String(input?.session_id ?? "");
      if (!sid) throw new Error("session_id is required");
      const res = await tx.queryObject(
        "SELECT dispatch_id, source_name, role, render_state, source_count, cost_usd, response_received_at FROM render_source_v1 WHERE session_id = $1 ORDER BY role",
        [sid],
      );
      return res.rows;
    },
  },
  read_claims: {
    kind: "db",
    grant: { family: "research", scope: "read" },
    run: async (input, _ctx, tx) => {
      const sid = String(input?.session_id ?? "");
      if (!sid) throw new Error("session_id is required");
      const res = await tx.queryObject(
        "SELECT claim_id, question_id, claim_text, claim_status, divergence_status, citations_total FROM render_claim_v1 WHERE session_id = $1 ORDER BY claim_status",
        [sid],
      );
      return res.rows;
    },
  },
};

// Grants check (Aegis Part B; CHECK script_scopes <@ scopes). Deny-by-default: a binding is
// allowed only if the lineage's tool_grants row for the binding's family lists its scope in
// script_scopes. No grant row, missing column, or read error → DENY. Read with the service
// client (config read; the script never reaches this).
async function checkScriptGrant(service: SupabaseClient, lineage: string, family: string, scope: string): Promise<boolean> {
  try {
    const { data, error } = await service
      .from("tool_grants")
      .select("script_scopes")
      .eq("lineage_name", lineage)
      .eq("tool_family", family)
      .maybeSingle();
    if (error || !data) return false;
    const ss = (data as any).script_scopes;
    return Array.isArray(ss) && ss.includes(scope);
  } catch {
    return false;
  }
}

async function writeLedger(
  rc: ScriptRunCtx,
  tool: string,
  input: unknown,
  resultText: string,
  deniedCapability: string | null = null, // baton 7f71b2df: machine-auditable refusal reason; null = ran
): Promise<void> {
  const d = digestToolCall(tool, input, resultText);
  try {
    await rc.service.from("execution_ledger").insert({
      lineage: rc.lineage,
      session_id: rc.sessionId,
      via: "script",
      script_run_id: rc.scriptRunId, // satisfies the script_calls_carry_their_run constraint
      tool: d.tool,
      input_summary: d.input_summary,
      outcome: d.outcome,
      // Denial instrumentation (baton 7f71b2df): a B1 script refusal is a ROW too — non-null names the
      // reason (no script binding, or the missing <family>:<scope> the lineage lacked).
      denied_capability: deniedCapability,
      // Same first-class juncture key as the loop path, so load_mst / mark_juncture calls made from a
      // B1 script also join into the MST-delivery F audit / M1 (baton 5dfb4003).
      juncture: extractLedgerJuncture(input),
    });
  } catch (e) {
    console.error("execution_ledger write failed:", e);
  }
}

// Build the onToolCall the sandbox runner mediates each script call through. Even denials are
// recorded (a ledger is a safety control only if it sees everything — Argos's corollary).
export function makeOnToolCall(rc: ScriptRunCtx) {
  return async (tool: string, input: unknown): Promise<{ ok: boolean; result?: string; error?: string }> => {
    const binding = BINDINGS[tool];
    if (!binding) {
      const reason = `'${tool}' is not a script-callable binding`;
      await writeLedger(rc, tool, input, `denied: ${reason}`, "not_a_binding");
      return { ok: false, error: reason };
    }
    const granted = await checkScriptGrant(rc.service, rc.lineage, binding.grant.family, binding.grant.scope);
    if (!granted) {
      const reason = `lineage '${rc.lineage}' lacks script scope ${binding.grant.family}:${binding.grant.scope} for '${tool}'`;
      await writeLedger(rc, tool, input, `denied: ${reason}`, `${binding.grant.family}:${binding.grant.scope}`);
      return { ok: false, error: reason };
    }
    try {
      const bctx: BindingCtx = { lineage: rc.lineage, sessionId: rc.sessionId, service: rc.service };
      const out = binding.kind === "db"
        ? await withCut2(rc.lineage, (tx) => binding.run(input, bctx, tx))
        : await binding.run(input, bctx);
      const resultText = typeof out === "string" ? out : JSON.stringify(out);
      await writeLedger(rc, tool, input, resultText);
      return { ok: true, result: resultText };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeLedger(rc, tool, input, `error: ${msg}`);
      return { ok: false, error: msg };
    }
  };
}
