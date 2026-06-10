// Tool registry. Adding a tool = new file + one line here.

import type { Tool, ToolContext } from "./types.ts";
import { executeSqlTool } from "./executeSql.ts";
import { deliverArtefactTool } from "./deliverArtefact.ts";
import { readGithubFileTool, writeGithubFileTool, listGithubDirectoryTool } from "./github.ts";
import { getConferenceResultTool } from "./getConferenceResult.ts";
import { readWakeDeltasTool, readInboxTool, getMessageTool, sendMessageTool, consumeWakeDeltasTool } from "./messaging.ts";
import { enqueueDispatchTool } from "./enqueueDispatch.ts";
import { readDispatchResultsTool } from "./readDispatchResults.ts";
import { writeSynthesisSectionTool } from "./writeSynthesisSection.ts";
import { readSynthesisTool } from "./readSynthesis.ts";
import { commitSynthesisTool } from "./commitSynthesis.ts";
import { writeClaimsTool } from "./writeClaims.ts";
import { runScriptTool, readExecutionLedgerTool } from "./runScript.ts";

// execute_sql, get_conference_result, and the read_wake_deltas/read_inbox/get_message/
// send_message/consume_wake_deltas/enqueue_dispatch/read_dispatch_results/
// write_synthesis_section/read_synthesis/commit_synthesis/write_claims tools are withheld on the wake turn (see
// each tool's available()); the rest are always offered.
const TOOLS: Tool[] = [
  executeSqlTool,
  deliverArtefactTool,
  getConferenceResultTool,
  readWakeDeltasTool,
  readInboxTool,
  getMessageTool,
  sendMessageTool,
  consumeWakeDeltasTool,
  enqueueDispatchTool,
  readDispatchResultsTool,
  writeSynthesisSectionTool,
  readSynthesisTool,
  commitSynthesisTool,
  writeClaimsTool,
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

// Per-lineage least-privilege loop gate (Conf 295d610a enforcement, loop side).
// Governed ONLY if the lineage holds at least one EF-tool grant row — so legacy
// lineages with no grants, or connector-only grants (drive/firecrawl), are
// ungoverned and keep the full default set (no blast radius on working Primes).
// For a governed lineage, allowed = the EF tools whose grant scopes include
// 'invoke'. Deny-by-default within governed.
export function computeLoopGate(
  grantRows: Array<{ tool_family: string; scopes: string[] | null }>,
): { governed: boolean; allowed: ReadonlySet<string> | null } {
  const efRows = grantRows.filter((g) => EF_TOOL_NAMES.has(g.tool_family));
  if (efRows.length === 0) return { governed: false, allowed: null };
  const allowed = new Set(
    efRows
      .filter((g) => Array.isArray(g.scopes) && g.scopes.includes("invoke"))
      .map((g) => g.tool_family),
  );
  return { governed: true, allowed };
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
