// Tool registry. Adding a tool = new file + one line here.

import type { Tool, ToolContext } from "./types.ts";
import { executeSqlTool } from "./executeSql.ts";
import { deliverArtefactTool } from "./deliverArtefact.ts";
import { readGithubFileTool, writeGithubFileTool, listGithubDirectoryTool } from "./github.ts";
import { getConferenceResultTool } from "./getConferenceResult.ts";
import { readWakeDeltasTool, readInboxTool, getMessageTool, readPrimeMessagesTool, sendMessageTool, consumeWakeDeltasTool } from "./messaging.ts";
import { enqueueDispatchTool } from "./enqueueDispatch.ts";
import { readDispatchResultsTool } from "./readDispatchResults.ts";
import { writeSynthesisSectionTool } from "./writeSynthesisSection.ts";
import { readSynthesisTool } from "./readSynthesis.ts";
import { commitSynthesisTool } from "./commitSynthesis.ts";
import { writeClaimsTool } from "./writeClaims.ts";
import { declareCaptureTargetTool } from "./declareCaptureTarget.ts";
import { renderDocumentTool } from "./renderDocument.ts";
import { writeGroundFactTool } from "./writeGroundFact.ts";
import { writeElementDependencyTool } from "./writeElementDependency.ts";
import { writeFigureTool } from "./writeFigure.ts";
import { fileSuperTTool } from "./fileSuperT.ts";
import { readSuperTTool } from "./readSuperT.ts";
import { loadMstTool } from "./loadMst.ts";
import { markJunctureTool } from "./markJuncture.ts";
import { runScriptTool, readExecutionLedgerTool } from "./runScript.ts";

// execute_sql, get_conference_result, and the read_wake_deltas/read_inbox/get_message/
// send_message/consume_wake_deltas/enqueue_dispatch/read_dispatch_results/
// write_synthesis_section/read_synthesis/commit_synthesis/write_claims/write_figure/file_super_t tools are withheld
// on the wake turn (see each tool's available()); the rest are always offered.
const TOOLS: Tool[] = [
  executeSqlTool,
  deliverArtefactTool,
  getConferenceResultTool,
  readWakeDeltasTool,
  readInboxTool,
  getMessageTool,
  readPrimeMessagesTool,
  sendMessageTool,
  consumeWakeDeltasTool,
  enqueueDispatchTool,
  readDispatchResultsTool,
  writeSynthesisSectionTool,
  readSynthesisTool,
  commitSynthesisTool,
  writeClaimsTool,
  declareCaptureTargetTool,
  renderDocumentTool,
  writeGroundFactTool,
  writeElementDependencyTool,
  writeFigureTool,
  fileSuperTTool,
  readSuperTTool,
  loadMstTool,
  markJunctureTool,
  runScriptTool,
  readExecutionLedgerTool,
  readGithubFileTool,
  writeGithubFileTool,
  listGithubDirectoryTool,
];

const BY_NAME: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.definition.name, t]));

// EF loop-tool names — the gate's universe. A lineage is "loop-governed" iff it
// holds a tool_grants row whose tool_family is one of these (see computeLoopGate).
export const EF_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.definition.name));

// Approvers whose grants the harness will honour. A grant is authorised ONLY if an
// authority (Aegis or Reg) approved it — Component 3 of the tool_grants hard wall
// (Aegis ruling 08549bd3). approver_role was previously stored but never consulted,
// so a self-inserted row was honoured identically to an approved one.
const GRANT_APPROVERS: ReadonlySet<string> = new Set(["aegis", "reg"]);

// Per-lineage least-privilege loop gate (Conf 295d610a; hardened per Aegis 08549bd3, Component 3).
//
// Behaviour is FLAG-GATED for a safe staged cutover (opts.enforce, driven by env
// TOOL_GRANTS_ENFORCE in index.ts). This lets the hardened code DEPLOY dark and ACTIVATE only
// once Connie's Postgres wall is up and every active lineage has an approved grant — Aegis's
// "deploy after, not before". Default (enforce=false) is the EXACT legacy behaviour.
//
//   LEGACY (enforce=false): governed only if the lineage holds ≥1 EF-tool grant row; ungoverned
//     lineages fail OPEN to the full default set (no blast radius on working Primes); approver_role
//     not consulted. This is the current live behaviour and stays until the cutover.
//   HARDENED (enforce=true): a grant counts ONLY if ALL THREE hold (Aegis 56fd9873, defence-in-depth
//     the Postgres structural check can't do alone): (a) approver_role IS NOT NULL; (b) approver_role
//     ∈ {aegis,reg}; (c) approver_role != the grantee lineage (self-grant rejection). Then FAIL-CLOSED —
//     every lineage is governed and one with no valid grant gets NO EF tools (closes the de-govern
//     escalation: deleting your own grant rows no longer fails open to the whole toolset).
// allowed = the EF tools whose (approved, when enforcing) grant scopes include 'invoke'. Deny-by-default.
// lineageName is the grantee (the fetch filters grantRows to this lineage) — needed for check (c).
export function computeLoopGate(
  grantRows: Array<{ tool_family: string; scopes: string[] | null; approver_role?: string | null }>,
  opts?: { enforce?: boolean; lineageName?: string },
): { governed: boolean; allowed: ReadonlySet<string> | null } {
  const hasInvoke = (g: { scopes: string[] | null }) => Array.isArray(g.scopes) && g.scopes.includes("invoke");
  if (opts?.enforce === true) {
    const validEf = grantRows.filter(
      (g) => EF_TOOL_NAMES.has(g.tool_family) &&
             typeof g.approver_role === "string" &&        // (a) not null
             GRANT_APPROVERS.has(g.approver_role) &&        // (b) an authority
             g.approver_role !== opts.lineageName,          // (c) not self-approved
    );
    return { governed: true, allowed: new Set(validEf.filter(hasInvoke).map((g) => g.tool_family)) };
  }
  // LEGACY (default): unchanged fail-open behaviour.
  const efRows = grantRows.filter((g) => EF_TOOL_NAMES.has(g.tool_family));
  if (efRows.length === 0) return { governed: false, allowed: null };
  return { governed: true, allowed: new Set(efRows.filter(hasInvoke).map((g) => g.tool_family)) };
}

// allowed: when provided (governed lineage), restrict to these tool names on top
// of the wake-turn withholding. When null/undefined (ungoverned), no restriction.
export function availableToolDefinitions(opts: { isNewSession: boolean; allowed?: ReadonlySet<string> | null }) {
  return TOOLS
    .filter((t) => (t.available ? t.available(opts) : true))
    .filter((t) => (opts.allowed ? opts.allowed.has(t.definition.name) : true))
    .map((t) => t.definition);
}

export function summarizeToolUse(name: string, input: any): string {
  const t = BY_NAME[name];
  return t?.summarize ? t.summarize(input) : name;
}

export async function runTool(name: string, input: any, ctx: ToolContext): Promise<string> {
  const t = BY_NAME[name];
  if (!t) return `Unknown tool: ${name}`;
  return await t.run(input, ctx);
}

export type { ToolContext };
