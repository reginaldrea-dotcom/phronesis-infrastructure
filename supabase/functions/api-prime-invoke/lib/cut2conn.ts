// api-prime-invoke | cut2conn | B1 Phase 3 (Aegis amended ruling cfe2f1f4; Argos finding c7500cae) | 7 Jun 2026
//
// Scoped identity via a DIRECT pg connection — the JWT mint is dead (asymmetric signing-key
// migration). A restricted LOGIN role, prime_runner (NOINHERIT, zero own privileges, member of
// prime_cut2), connects via PRIME_CUT2_DB_URL (direct, port 5432; password NordPass-only, never
// logged). Each binding runs in its OWN short transaction (Aegis Q1: per-binding) that does:
//   set_config('request.jwt.claims', {role,lineage}, local) — the lineage claim as a tx-local GUC,
//                                                              read by per-Prime RLS unchanged (Q2);
//   SET LOCAL ROLE prime_cut2 — prime_runner's ONLY capability (membership + NOINHERIT).
// The GUC + role are transaction-local, so they reset on commit/rollback — no leakage between
// bindings. This connection is the cut2 path ONLY; the service client stays the loop + ledger
// path, so the opacity gap is a different connection entirely (Aegis property 2). NEVER reachable
// from the Worker — the parent EF owns this module; the script has no DB handle at all.

import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

let pool: Pool | null = null;
let txSeq = 0;

function getPool(): Pool {
  if (!pool) {
    const url = Deno.env.get("PRIME_CUT2_DB_URL");
    if (!url) throw new Error("PRIME_CUT2_DB_URL not set — cannot open the prime_cut2 scoped connection");
    // Small, lazy pool: the EF is short-lived and the direct (5432) connection budget is finite.
    pool = new Pool(url, 3, true);
  }
  return pool;
}

// Run `fn` under prime_cut2 scope for `lineage`, in its own short transaction. The first call
// through here is also the live verification of the whole chain (login → membership → SET ROLE);
// a failure at any link surfaces as a thrown error the executor records, with nothing secret in it.
export async function withCut2<T>(lineage: string, fn: (tx: unknown) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    const tx = client.createTransaction(`b1_${Date.now()}_${++txSeq}`);
    await tx.begin();
    try {
      const claims = JSON.stringify({ role: "prime_cut2", lineage });
      await tx.queryArray`SELECT set_config('request.jwt.claims', ${claims}, true)`;
      await tx.queryArray("SET LOCAL ROLE prime_cut2");
      const out = await fn(tx);
      await tx.commit();
      return out;
    } catch (e) {
      try { await tx.rollback(); } catch (_) { /* connection may already be unusable */ }
      throw e;
    }
  } finally {
    client.release();
  }
}
