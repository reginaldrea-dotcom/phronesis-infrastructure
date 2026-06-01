// lib/provenance.ts — Tool-Provenance Ledger (WO d4501dbc, critical path).
//
// Storage-AGNOSTIC core: turns each tool call + its result into a bounded digest,
// and renders a turn's digests as a tagged ground-truth block for replay in history.
//
// The PERSIST step (writing digests to the assistant row) and the LOAD step (reading
// them back in history.ts) are wired separately and are gated on Connie's storage
// ruling (metadata.tool_log vs a dedicated audit table) — this module is identical
// either way. Pure functions, no Deno/DB deps; unit-testable in isolation.

export interface ToolDigest {
  tool: string;
  input_summary: string; // the call, normalised + bounded — NOT the full input
  outcome: string;       // evidence (row count / ids / rows-affected / error) — NOT the full payload
}

const INPUT_MAX = 300;   // a SQL clause / path — enough to identify the call
const OUTCOME_MAX = 160;
const SAMPLE_ROWS = 10;
// Per-turn render budget. WO guideline was 300–500; raised to 1000 because (a) one
// execute_sql digest alone can approach 500, and (b) the failure-relevant turns are
// exactly the high-tool ones (Argos's 8-call turns) we must NOT truncate. history.ts
// still trims the whole context by its 50k-token budget, so aggregate cost stays bounded.
// Flagged for ratification.
const RENDER_BUDGET = 1000;

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s);

/** Per-tool input summary — the call, normalised and bounded. */
function summariseInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return clip(collapse(String(input ?? "")), INPUT_MAX);
  const i = input as Record<string, unknown>;
  switch (name) {
    case "execute_sql":           return clip(collapse(String(i.query ?? "")), INPUT_MAX);
    case "get_conference_result": return `conference ${i.conference_id ?? "?"}`;
    case "read_github_file":
    case "list_github_directory": return String(i.path ?? "");
    case "write_github_file":     return clip(`${i.path ?? "?"} (${i.message ?? ""})`, INPUT_MAX);
    default:                      return clip(collapse(JSON.stringify(i)), INPUT_MAX);
  }
}

const ERROR_RE =
  /^(sql error|execution error|.*error \d+:|get_conference_result error|read_github_file error|write_github_file error|list_github_directory error|github (write )?error)/i;

function sampleRows(rows: unknown[]): string {
  const s = rows.slice(0, SAMPLE_ROWS).map((r) => {
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      if (o.id != null) return String(o.id).slice(0, 8);
      const k = Object.keys(o)[0];
      return k ? `${k}=${clip(String(o[k]), 24)}` : "?";
    }
    return clip(String(r), 24);
  });
  return s.join(", ") + (rows.length > SAMPLE_ROWS ? " …" : "");
}

/** Outcome summary — evidence, not payload. */
function summariseOutcome(resultText: string): string {
  const txt = String(resultText ?? "").trim();
  if (!txt) return "→ (no result)";
  if (ERROR_RE.test(txt)) return clip(collapse(txt.split("\n")[0]), OUTCOME_MAX);
  if (txt.startsWith("[]")) return "→ 0 rows";
  if (/^No .*(found|synthesis)/i.test(txt)) return "→ none (nothing found)";

  const jsonPart = txt.split("\n[SYSTEM")[0].trim();
  if (jsonPart.startsWith("[") || jsonPart.startsWith("{")) {
    try {
      const parsed = JSON.parse(jsonPart);
      if (Array.isArray(parsed)) {
        return parsed.length === 0 ? "→ 0 rows" : clip(`→ ${parsed.length} row(s): ${sampleRows(parsed)}`, OUTCOME_MAX);
      }
      const keys = Object.keys(parsed as Record<string, unknown>).slice(0, 6).join(", ");
      return clip(`→ 1 row {${keys}}`, OUTCOME_MAX);
    } catch { /* not JSON — fall through */ }
  }
  if (/^File written:/.test(txt)) return clip(collapse(txt), OUTCOME_MAX);
  if (/^(dir |file )/m.test(txt)) {
    const lines = txt.split("\n").filter((l) => /^(dir |file )/.test(l));
    const names = lines.slice(0, SAMPLE_ROWS).map((l) => l.split(/\s+/)[1]).join(", ");
    return clip(`→ ${lines.length} entr${lines.length === 1 ? "y" : "ies"}: ${names}${lines.length > SAMPLE_ROWS ? " …" : ""}`, OUTCOME_MAX);
  }
  // Opaque string (e.g. a fetched file body) — record size, never the body.
  return `→ ${txt.length} chars`;
}

/** Build the bounded digest for one tool call from its name, input, and result string. */
export function digestToolCall(name: string, input: unknown, resultText: string): ToolDigest {
  return { tool: name, input_summary: summariseInput(name, input), outcome: summariseOutcome(resultText) };
}

/** Render a turn's digests as a tagged ground-truth block for replay.
 *  - []        → an explicit "none" (so a no-tool turn that claims a result is contradictable)
 *  - null/undef → "" (a pre-ledger turn: no record exists, so assert nothing) */
export function renderToolLog(entries: ToolDigest[] | null | undefined): string {
  if (entries == null) return "";
  if (entries.length === 0) return "[tools this turn — system record: none]";
  const header = "[tools this turn — system record, ground truth]";
  const lines: string[] = [];
  let used = header.length;
  for (let idx = 0; idx < entries.length; idx++) {
    const e = entries[idx];
    const line = `• ${e.tool}  ${e.input_summary}  ${e.outcome}`;
    if (used + line.length > RENDER_BUDGET) {
      lines.push(`• … (${entries.length - idx} more tool call(s) this turn)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return [header, ...lines].join("\n");
}
