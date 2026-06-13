// Bounded conversation-history loading.
// (loadOrientation and extractArtifacts remain in index.ts for now — they carry
//  literal display Unicode; deferred to a later extraction phase.)

import { createClient } from "jsr:@supabase/supabase-js@2";

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

// Mortality experiment — forgetting_log dose detection (baton 3db33c0e; conf d06fd700).
// easeOlderTurns recomputes every turn, so the same older turns get re-eased on every load.
// To make the easing DOSE a clean variable (not a per-turn re-count), report only turns eased
// for the FIRST time — those whose stored row is not yet flagged metadata.b4_eased. The caller
// logs one forgetting_log row per load with a new easing and flags those rows so the next load
// does not recount them. Detection mirrors easeOlderTurns' window+threshold exactly.
export interface EasingSummary {
  newlyEasedTurns: number;
  newlyEasedBytes: number;     // stored bytes beyond the retained head — the dose increment
  sequenceNumbers: number[];   // rows to flag b4_eased so they are counted once
}

function detectNewEasing(histAsc: Array<{ sequence_number: number; content: string; metadata: any }>): EasingSummary {
  const cutoff = histAsc.length - EASE_RECENT_WINDOW;
  let turns = 0, bytes = 0;
  const seqs: number[] = [];
  histAsc.forEach((r, i) => {
    if (i >= cutoff) return;                                  // recent window: never eased
    const len = (r.content ?? "").length;
    if (len <= EASE_SIZE_THRESHOLD) return;                   // light turn: not eased
    if (r.metadata?.b4_eased === true) return;                // already counted on an earlier load
    turns++;
    bytes += Math.max(0, len - EASE_HEAD_CHARS);
    seqs.push(r.sequence_number);
  });
  return { newlyEasedTurns: turns, newlyEasedBytes: bytes, sequenceNumbers: seqs };
}

const NO_EASING: EasingSummary = { newlyEasedTurns: 0, newlyEasedBytes: 0, sequenceNumbers: [] };

export async function loadBoundedHistory(
  supabase: SupabaseClient,
  sessionId: string | null,
  tokenCeiling = 50000
): Promise<{ turns: { role: "user" | "assistant"; content: string }[]; easing: EasingSummary }> {
  if (!sessionId) return { turns: [], easing: NO_EASING };

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

  // Provenance ledger attribution (Aegis ruling af3a857e; FLAG debb024c). We deliberately do NOT
  // append the EF's "[tools this turn — system record, ground truth]" block to the assistant turns
  // on replay. The old WO d4501dbc behaviour re-voiced the EF's ledger AS the assistant's own past
  // output, which conditioned Primes to imitate and author the block themselves — and the provenance
  // safeguard then flagged that imitation as forgery (an EF-induced loop, not Prime deception). The
  // ledger stays in the system's channel — metadata.tool_log (audit), the live tool_result blocks
  // during each turn, and the live response — never re-attributed to the model's voice on replay.
  const augment = (r: any): { role: "user" | "assistant"; content: string } =>
    ({ role: r.role as "user" | "assistant", content: r.content });

  const wake = (wakeRows ?? [])
    .filter((r: any) => r.role === "user" || r.role === "assistant")
    .map(augment);
  const history = (historyRows ?? [])
    .filter((r: any) => r.role === "user" || r.role === "assistant")
    .reverse()
    .map(augment);

  // Forgetting-log dose: detect turns eased for the first time this load (ascending order,
  // same window+threshold as easeOlderTurns). The raw stored content/metadata is the basis —
  // not the tool-log-augmented copy — so the dose reflects the actual retained payload.
  const histAsc = (historyRows ?? [])
    .filter((r: any) => r.role === "user" || r.role === "assistant")
    .slice().reverse()
    .map((r: any) => ({ sequence_number: r.sequence_number, content: r.content ?? "", metadata: r.metadata }));
  const easing = detectNewEasing(histAsc);

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
  return { turns: trimmed, easing };
}
