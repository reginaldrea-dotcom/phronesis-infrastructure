// Bounded conversation-history loading.
// (loadOrientation and extractArtifacts remain in index.ts for now — they carry
//  literal display Unicode; deferred to a later extraction phase.)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { renderToolLog } from "./provenance.ts";

type SupabaseClient = ReturnType<typeof createClient>;

type Turn = { role: "user" | "assistant"; content: string };

// B4 — in-loop compaction, preserve-purpose (conf 1151109e). Persistent sessions accumulate
// context; heavy OLDER turns (large pasted documents, long returns) crowd out the recent
// overview the Prime actually needs to keep working. Ease them: a turn beyond the recent
// window that exceeds a size threshold is compacted to its head + a pointer. The GIST is
// preserved, the FULL turn stays in prime_conversations (recoverable, and still rendered in
// the browser tail), and the freed budget keeps more recent turns whole. The wake/orientation
// turn is never eased (it carries identity/purpose). No-op for short or light sessions.
const EASE_RECENT_WINDOW = 6;      // most-recent history turns always kept whole
const EASE_SIZE_THRESHOLD = 2400;  // chars (~600 tokens) — only ease genuinely heavy turns
const EASE_HEAD_CHARS = 400;       // gist retained from an eased turn

function easeOlderTurns(turns: Turn[]): Turn[] {
  const cutoff = turns.length - EASE_RECENT_WINDOW;
  return turns.map((t, i) => {
    if (i >= cutoff) return t;                              // recent window: whole
    if (t.content.length <= EASE_SIZE_THRESHOLD) return t;  // light turn: whole
    const head = t.content.slice(0, EASE_HEAD_CHARS).trimEnd();
    const elided = t.content.length - head.length;
    return {
      role: t.role,
      content: `${head}\n\n[… ${elided} chars eased here to preserve context budget; the full turn is retained in this session's record …]`,
    };
  });
}

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

  // B4: ease heavy older history turns before the budget trim (wake kept whole).
  const combined = [...wake, ...easeOlderTurns(history)];
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
