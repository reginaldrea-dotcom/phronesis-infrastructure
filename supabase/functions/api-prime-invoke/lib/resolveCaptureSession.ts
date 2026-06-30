// resolveCaptureSession — shared, tolerant target resolution for the capture write
// tools (write_synthesis_section, write_claims). All capture writes key on
// theo_session_id; the synthesis is reached THROUGH its session. But the model
// routinely conflates the two ids — passing a synthesis_id into the session slot
// (Angelia SC1, 30 Jun, session a20713d6: "→ no theo_session" dead-ends). This
// resolver accepts EITHER:
//   - a theo_session_id (UUID or leading hex prefix) — the normal path, OR
//   - a synthesis_id — resolved to its owning theo_session_id, with a note so the
//     model learns the right slot (mirrors the read_synthesis tolerant-id pattern).
//
// theo_session is tried FIRST; the synthesis fallback only runs when no session
// matches, so a real session id is never shadowed by a synthesis-id collision.
// Returns { sessionId, note? } or { err } — the caller wraps err in its own
// tool-prefixed fail() so the surface message names the right tool.

import type { SupabaseClient } from "../tools/types.ts";

const ID_RE = /^[0-9a-f-]{4,36}$/i;

export async function resolveCaptureSession(
  supabase: SupabaseClient,
  raw: string,
): Promise<{ sessionId: string; note?: string } | { err: string }> {
  const r = (raw ?? "").trim();
  if (!ID_RE.test(r)) return { err: `theo_session_id must be a UUID or hex prefix. Got: ${r.slice(0, 40)}` };

  // 1) theo_session by prefix — the normal path, tried first.
  const s = await supabase.rpc("execute_raw_sql", {
    query: `SELECT id FROM theo_session WHERE id::text LIKE '${r}%' LIMIT 2`,
  });
  if (s.error) return { err: `session lookup failed: ${s.error.message}` };
  const sRows = (s.data ?? []) as Array<{ id: string }>;
  if (sRows.length > 1) return { err: `prefix '${r}' matches ${sRows.length} theo_sessions — supply more characters.` };
  if (sRows.length === 1) return { sessionId: sRows[0].id };

  // 2) Fallback: the model may have passed a synthesis_id. Map it to its session.
  const syn = await supabase.rpc("execute_raw_sql", {
    query: `SELECT id, theo_session_id FROM synthesis WHERE id::text LIKE '${r}%' LIMIT 2`,
  });
  if (syn.error) return { err: `session lookup failed: ${syn.error.message}` };
  const synRows = (syn.data ?? []) as Array<{ id: string; theo_session_id: string | null }>;
  if (synRows.length > 1) return { err: `prefix '${r}' matches no theo_session and ${synRows.length} syntheses — supply the theo_session_id (the write tools key on the SESSION, not the synthesis).` };
  if (synRows.length === 1 && synRows[0].theo_session_id) {
    return {
      sessionId: synRows[0].theo_session_id,
      note: `you passed a synthesis_id (${synRows[0].id.slice(0, 8)}); the capture write tools key on theo_session_id, so it was resolved to its session ${synRows[0].theo_session_id.slice(0, 8)}. Pass the theo_session_id directly next time.`,
    };
  }
  return { err: `no theo_session (or synthesis) with id starting '${r}'. Ids are table-scoped — confirm this is a theo_session_id.` };
}
