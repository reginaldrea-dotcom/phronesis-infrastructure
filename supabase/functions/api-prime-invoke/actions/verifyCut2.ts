// api-prime-invoke | action verify_cut2 | B1 Phase 3 live verification | 7 Jun 2026
//
// Zero-queue-impact proof of the scoped-identity chain. Action handlers short-circuit BEFORE
// the wake/orientation path in index.ts, so this consumes NO wake_deltas, writes NO Super-T,
// and opens NO Prime session — it just opens the cut2 connection and reports who it became.
//
// A green result proves every link at once:
//   session_user = prime_runner  → the LOGIN over PRIME_CUT2_DB_URL succeeded
//   current_user = prime_cut2     → SET ROLE worked (membership + NOINHERIT)
//   claims        = {role,lineage} → the request.jwt.claims GUC is set (RLS would see it)
//   render_source_v1 count        → cut2's SELECT grant on the view is live
// A failure returns the pg error, which names the failed link (login / membership / grant)
// without ever containing the password. Lineage is a label only — no deltas are loaded by it.

import type { Action } from "./types.ts";
import { corsHeaders } from "../lib/http.ts";
import { withCut2 } from "../lib/cut2conn.ts";

export const verifyCut2Action: Action = {
  name: "verify_cut2",
  handle: async ({ body }) => {
    const lineage = String(body?.lineage_name ?? body?.lineage ?? "verify");
    try {
      const result = await withCut2(lineage, async (tx: any) => {
        const who = await tx.queryObject(
          "SELECT current_user AS current_user, session_user AS session_user, current_setting('request.jwt.claims', true) AS claims",
        );
        let viewCount: number | null = null;
        let viewError: string | null = null;
        try {
          const v = await tx.queryObject("SELECT count(*)::int AS n FROM render_source_v1");
          viewCount = (v.rows[0] as any).n;
        } catch (e) {
          viewError = e instanceof Error ? e.message : String(e);
        }
        return { ...(who.rows[0] as Record<string, unknown>), render_source_v1_count: viewCount, render_source_v1_error: viewError };
      });
      return new Response(
        JSON.stringify({ ok: true, chain: "prime_runner login → SET ROLE prime_cut2 → GUC → grant", ...result }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(
        JSON.stringify({ ok: false, error: msg, hint: "names the failed link — login(prime_runner) / SET ROLE(membership) / read(grant); contains no secret" }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  },
};
