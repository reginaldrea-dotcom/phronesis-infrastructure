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

// execute_sql, get_conference_result, and the read_wake_deltas/read_inbox/get_message/
// send_message/consume_wake_deltas/enqueue_dispatch/read_dispatch_results/
// write_synthesis_section/read_synthesis tools are withheld on the wake turn (see
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
  readGithubFileTool,
  writeGithubFileTool,
  listGithubDirectoryTool,
];

const BY_NAME: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.definition.name, t]));

export function availableToolDefinitions(opts: { isNewSession: boolean }) {
  return TOOLS.filter((t) => (t.available ? t.available(opts) : true)).map((t) => t.definition);
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
