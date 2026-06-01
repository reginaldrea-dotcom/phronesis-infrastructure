// Bounded conversation-history loading.
// (loadOrientation and extractArtifacts remain in index.ts for now — they carry
//  literal display Unicode; deferred to a later extraction phase.)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { renderToolLog } from "./provenance.ts";

type SupabaseClient = ReturnType<typeof createClient>;

export async function loadBoundedHistory(
  supabase: SupabaseClient,
  sessionId: string | null,
  tokenCeiling = 50000
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  if (!sessionId) return [];

  const { data: wakeRows } = await supabase
    .from("prime_conversations")
    .select("role, content, sequence_number, metadata")
    .eq("session_id", sessionId)
    .lte("sequence_number", 1)
    .order("sequence_number", { ascending: true });

  const { data: historyRows } = await supabase
    .from("prime_conversations")
    .select("role, content, sequence_number, metadata")
    .eq("session_id", sessionId)
    .gt("sequence_number", 1)
    .order("sequence_number", { ascending: false })
    .limit(500);

  // Provenance ledger (WO d4501dbc): append the per-turn tool record to each assistant
  // turn so the model sees what it actually did and what came back — not just what it
  // said. metadata.tool_log is absent on pre-ledger rows, so renderToolLog returns "" and
  // nothing is appended (no false "none"). The appended block is bounded, so the existing
  // char budget below keeps aggregate context in check.
  const augment = (r: any): { role: "user" | "assistant"; content: string } => {
    if (r.role === "assistant") {
      const block = renderToolLog(r.metadata?.tool_log);
      if (block) return { role: "assistant", content: `${r.content}\n\n${block}` };
    }
    return { role: r.role as "user" | "assistant", content: r.content };
  };

  const wake = (wakeRows ?? [])
    .filter((r: any) => r.role === "user" || r.role === "assistant")
    .map(augment);
  const history = (historyRows ?? [])
    .filter((r: any) => r.role === "user" || r.role === "assistant")
    .reverse()
    .map(augment);

  const combined = [...wake, ...history];
  let charBudget = tokenCeiling * 4;
  const trimmed: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = combined.length - 1; i >= 0; i--) {
    const row = combined[i];
    charBudget -= row.content.length;
    if (charBudget < 0 && trimmed.length > 0) break;
    trimmed.unshift(row);
  }
  return trimmed;
}
