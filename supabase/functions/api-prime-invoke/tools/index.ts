// Tool registry. Adding a tool = new file + one line here.

import type { Tool, ToolContext } from "./types.ts";
import { executeSqlTool } from "./executeSql.ts";
import { deliverArtefactTool } from "./deliverArtefact.ts";
import { readGithubFileTool, writeGithubFileTool, listGithubDirectoryTool } from "./github.ts";

// Order preserved from the original tools[] array.
const TOOLS: Tool[] = [
  executeSqlTool,
  deliverArtefactTool,
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
