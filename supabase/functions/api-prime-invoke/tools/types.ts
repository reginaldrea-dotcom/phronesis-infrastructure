// Tool contract: a model-callable tool is a definition (handed to Anthropic) plus
// an executor. The invoke loop builds its tools[] from availableToolDefinitions()
// and dispatches tool_use blocks through runTool().

import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Artifact } from "../lib/types.ts";

export type SupabaseClient = ReturnType<typeof createClient>;

export interface ToolContext {
  supabase: SupabaseClient;
  directArtefacts: Artifact[]; // deliver_artefact pushes delivered artefacts here
}

export interface Tool {
  definition: { name: string; description: string; input_schema: unknown };
  available?: (opts: { isNewSession: boolean }) => boolean;
  summarize?: (input: any) => string;
  run: (input: any, ctx: ToolContext) => Promise<string>;
}
