// evaluateCaptureState — the row-derived capture-completion gate (a90e1410 instance 3:
// capture, sibling to retirement and the baton board). Connie's pinned predicate
// (msg 070f74f0) + Eames's three-state render contract (cac6810c). The point, per
// both rulings: NEVER trust the Prime's word that a capture is "complete" — derive
// it from the substrate, and make the surface tell the truth on its own (Angelia
// SC1, 30 Jun: 4 completed dispatches, 0 claims, reported as progress not failure).
//
// THREE STATES (do NOT collapse to binary — collapsing is how retire false-closed):
//   - complete    : the brief's required outputs landed for the owned synthesis.
//                   ONLY here may any surface render "complete/done".
//   - incomplete  : predicate false AND nothing is still in flight → the Prime has
//                   everything it needs and has not captured. LOUD, surfaced to Reg.
//   - in_progress : predicate false BUT dispatches still pending/dispatched → a
//                   mid-flight capture, legitimately unfinished. QUIET (no alarm —
//                   crying wolf mid-run trains Primes to wave the warning away).
//
// PREDICATE (Connie 070f74f0; all row/chain-derived, brief-relative):
//   claims_required := (>=1 completed/partial dispatch) OR (>=1 research_question)
//   FLOOR     : if claims_required, active claim_count > 0 (keys on DISPATCHES, not
//               questions — SC1 had 0 questions, so a question-only check vacuously passes).
//   COVERAGE  : if questions exist, every research_question is resolved by an ACTIVE
//               claim carrying its question_id (answered or a gap claim) — not by the
//               Prime-set research_question.status flag (that is the self-report loophole).
//   When neither dispatch nor question exists, sections-only is acceptable → complete
//   (no false-incomplete, the symmetric error Eames warned against).
//
// STRICT tier (+citation grounding) is Eames's call and not gated here yet; floor +
// coverage is the STANDARD threshold. tier is reported so the surface can show which ran.

import type { SupabaseClient } from "../tools/types.ts";

export type CaptureState = "complete" | "incomplete" | "in_progress" | "none";

export interface CaptureEval {
  state: CaptureState;
  synthesis_id: string | null;
  theo_session_id: string;
  sections: number;
  claims: number;          // active (non-superseded)
  dispatches_done: number; // completed + partial
  dispatches_in_flight: number;
  questions: number;
  questions_uncovered: number;
  claims_required: boolean;
  tier: "standard";
  // A row-derived, human-readable gap line the SURFACE shows independently of the Prime's narration.
  detail: string;
}

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

export async function evaluateCaptureState(
  supabase: SupabaseClient,
  theoSessionId: string,
): Promise<CaptureEval | null> {
  if (!FULL_UUID.test(theoSessionId)) return null;

  // One round-trip: counts for the session's latest synthesis + dispatch/question state.
  // NB: execute_raw_sql routes SELECT vs write by btrim()+LIKE 'WITH%'/'SELECT%', and btrim strips
  // spaces but NOT newlines — so the query string MUST start with "WITH" (no leading newline/indent),
  // or it is misclassified as a write and returns {rows_affected} instead of rows.
  const q = await supabase.rpc("execute_raw_sql", {
    query: `WITH sy AS (
        SELECT id FROM synthesis WHERE theo_session_id = '${theoSessionId}'
        ORDER BY created_at DESC LIMIT 1
      ),
      d AS (
        SELECT
          count(*) FILTER (WHERE status IN ('completed','partial'))   AS dp_done,
          count(*) FILTER (WHERE status IN ('pending','dispatched'))  AS dp_inflight
        FROM engine_dispatch WHERE theo_session_id = '${theoSessionId}'
      ),
      qn AS (SELECT count(*) AS n FROM research_question WHERE theo_session_id = '${theoSessionId}'),
      sec AS (SELECT count(*) AS n FROM synthesis_section WHERE synthesis_id = (SELECT id FROM sy)),
      cl AS (
        SELECT count(*) AS n FROM synthesis_claim
        WHERE synthesis_id = (SELECT id FROM sy)
          AND COALESCE(claim_lifecycle,'active') <> 'superseded'
      ),
      uncov AS (
        SELECT count(*) AS n FROM research_question rq
        WHERE rq.theo_session_id = '${theoSessionId}'
          AND NOT EXISTS (
            SELECT 1 FROM synthesis_claim sc
            WHERE sc.synthesis_id = (SELECT id FROM sy)
              AND sc.question_id = rq.id
              AND COALESCE(sc.claim_lifecycle,'active') <> 'superseded'
          )
      )
      SELECT (SELECT id FROM sy) AS synthesis_id,
             d.dp_done, d.dp_inflight, qn.n AS questions, sec.n AS sections, cl.n AS claims, uncov.n AS uncovered
      FROM d, qn, sec, cl, uncov
    `,
  });
  if (q.error) {
    console.error("evaluateCaptureState query failed:", q.error.message);
    return null;
  }
  const row = ((q.data ?? []) as Array<Record<string, unknown>>)[0];
  if (!row) return null;

  const synthesisId = (row.synthesis_id as string | null) ?? null;
  const dispatchesDone = Number(row.dp_done ?? 0);
  const dispatchesInFlight = Number(row.dp_inflight ?? 0);
  const questions = Number(row.questions ?? 0);
  const sections = Number(row.sections ?? 0);
  const claims = Number(row.claims ?? 0);
  const uncovered = Number(row.uncovered ?? 0);

  const claimsRequired = dispatchesDone > 0 || questions > 0;

  // Predicate (standard tier): floor + coverage, brief-relative.
  let predicateMet: boolean;
  if (!claimsRequired) {
    predicateMet = true; // sections-only capture is legitimately complete
  } else {
    const floorMet = claims > 0;
    const coverageMet = questions === 0 ? true : uncovered === 0;
    predicateMet = floorMet && coverageMet;
  }

  // Three states (Eames cac6810c): in_progress only while work is still arriving.
  let state: CaptureState;
  if (predicateMet) state = "complete";
  else if (dispatchesInFlight > 0) state = "in_progress";
  else state = "incomplete";

  // Surface-owned gap line — what Reg sees regardless of what the Prime narrates.
  const synthShort = synthesisId ? synthesisId.slice(0, 8) : "(none)";
  let detail: string;
  if (state === "complete") {
    detail = claimsRequired
      ? `synthesis ${synthShort}: ${claims} claim(s) across ${sections} section(s); ${dispatchesDone} completed dispatch(es)${questions > 0 ? `, all ${questions} question(s) claim-covered` : ""} — capture complete.`
      : `synthesis ${synthShort}: ${sections} section(s), no dispatches/questions requiring claims — capture complete.`;
  } else if (state === "in_progress") {
    detail = `synthesis ${synthShort}: ${dispatchesInFlight} dispatch(es) still in flight; ${claims} claim(s) so far — capture in progress, not yet complete.`;
  } else {
    const why = claims === 0
      ? `0 claims despite ${dispatchesDone} completed dispatch(es)`
      : `${uncovered} of ${questions} question(s) not claim-covered`;
    detail = `synthesis ${synthShort}: ${sections} section(s), ${claims} claim(s), ${dispatchesDone} completed dispatch(es) — CAPTURE INCOMPLETE (${why}; the brief required claims). Not 'done' until write_claims lands.`;
  }

  return {
    state,
    synthesis_id: synthesisId,
    theo_session_id: theoSessionId,
    sections,
    claims,
    dispatches_done: dispatchesDone,
    dispatches_in_flight: dispatchesInFlight,
    questions,
    questions_uncovered: uncovered,
    claims_required: claimsRequired,
    tier: "standard",
    detail,
  };
}
