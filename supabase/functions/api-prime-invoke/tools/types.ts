// Tool contract: a model-callable tool is a definition (handed to Anthropic) plus
// an executor. The invoke loop builds its tools[] from availableToolDefinitions()
// and dispatches tool_use blocks through runTool().

import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Artifact } from "../lib/types.ts";

export type SupabaseClient = ReturnType<typeof createClient>;

// The spawner-sealed per-invocation grant (Delphia; conf 75d90356 / baton cdb7693c). Loaded by the EF from
// sibling_grant BELOW THE MODEL, keyed to (session, lineage) — never from the request body. permit = the
// capability classes this sibling HOLDS (deny-by-default: anything absent is refused); cargo = the {dossier,
// identity} scope the scoped-DB-identity (item 2) constrains reads/writes to. null for a standing Prime.
export interface SiblingGrant {
  permit: string[];
  cargo: Record<string, unknown>;
}

export interface ToolContext {
  supabase: SupabaseClient;
  directArtefacts: Artifact[]; // deliver_artefact pushes delivered artefacts here
  lineageName: string;         // the calling Prime's lineage — for caller-scoped reads (read_wake_deltas/read_inbox/get_message)
  userId?: string | null;      // end-user id from JWT — required by enqueue_dispatch; null when caller is unauthenticated
  sessionId?: string;          // active session — keys the execution ledger / script-run rows (B1)
  instanceId?: string | null;  // the calling Prime's instance — bound onto self-filed Super-Ts (file_super_t tool)
  siblingGrant?: SiblingGrant | null; // spawner-sealed permit+cargo (Delphia); null for standing Primes
}

// EXECUTION-LAYER GRANT CHECK — the durable, TOOL_GRANTS_ENFORCE-independent belt (conf 75d90356, Heph's
// hinge; baton cdb7693c). A privileged tool calls this at the TOP of run(). If the invocation carries a
// SEALED sibling grant whose permit lacks `capability`, it returns a denial string the tool returns verbatim
// — the action is REFUSED BELOW THE MODEL (never executed; the model only ever sees the refusal). For a
// standing Prime (no sealed grant) it is a NO-OP (returns null) — additive and non-breaking. This is layer
// (b): it holds even if the tool-visibility layer (a) regressed, because it does not consult tool_grants or
// TOOL_GRANTS_ENFORCE — it reads the sealed permit that travelled in the context.
export function requireGrant(ctx: ToolContext, capability: string): string | null {
  const g = ctx.siblingGrant;
  if (!g) return null;                                             // not a sealed sibling — unrestricted
  if (Array.isArray(g.permit) && g.permit.includes(capability)) return null; // permitted
  return `[SYSTEM: DENIED below the model — this session's sealed permit does not include '${capability}'. `
    + `That capability is structurally UNAVAILABLE to this sibling (not discouraged, unavailable); the action did not run. Do not retry — this is the answer.]`;
}

export interface Tool {
  definition: { name: string; description: string; input_schema: unknown };
  available?: (opts: { isNewSession: boolean }) => boolean;
  summarize?: (input: any) => string;
  run: (input: any, ctx: ToolContext) => Promise<string>;
}
