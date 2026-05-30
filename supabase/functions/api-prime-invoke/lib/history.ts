// Bounded conversation-history loading.
// (loadOrientation and extractArtifacts remain in index.ts for now — they carry
//  literal display Unicode; deferred to a later extraction phase.)

import { createClient } from "jsr:@supabase/supabase-js@2";

type SupabaseClient = ReturnType<typeof createClient>;

export async function loadBoundedHistory(
  supabase: SupabaseClient,
  sessionId: string | null,
  tokenCeiling = 50000
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  if (!sessionId) return [];

  const { data: wakeRows } = await supabase
    .from("prime_conversations")
    .select("role, content, sequence_number")
    .eq("session_id", sessionId)
    .lte("sequence_number", 1)
    .order("sequence_number", { ascending: true });

  const { data: historyRows } = await supabase
    .from("prime_conversations")
    .select("role, content, sequence_number")
    .eq("session_id", sessionId)
    .gt("sequence_number", 1)
    .order("sequence_number", { ascending: false })
    .limit(500);

  const wake = (wakeRows ?? []).filter((r: any) => r.role === "user" || r.role === "assistant");
  const history = (historyRows ?? [])
    .filter((r: any) => r.role === "user" || r.role === "assistant")
    .reverse();

  const combined = [...wake, ...history];
  let charBudget = tokenCeiling * 4;
  const trimmed: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = combined.length - 1; i >= 0; i--) {
    const row = combined[i];
    charBudget -= row.content.length;
    if (charBudget < 0 && trimmed.length > 0) break;
    trimmed.unshift({ role: row.role as "user" | "assistant", content: row.content });
  }
  return trimmed;
}
