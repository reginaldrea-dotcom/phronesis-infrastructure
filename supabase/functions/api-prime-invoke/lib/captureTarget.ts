// captureTarget — the run-scoped write-ownership carrier (a90e1410 instance 3; Connie
// ruling 0b788de1, carrier blessed 6d3fab47). Write-ownership is run-scoped (== prime
// session), and intent lives only with the Prime, so the carrier is a model-DECLARED
// target persisted against the prime session. setCaptureTarget records it (declare tool +
// auto-on-enqueue); assertCaptureTarget enforces "write what you declared" on the capture
// write tools. NB: this enforces the declaration, not its correctness — a wholesale wrong
// declaration cannot be caught, because intent is the disambiguator and only the Prime holds
// it (Connie's recorded boundary). The declaration is persisted so a wrong target is debuggable.

import type { SupabaseClient } from "../tools/types.ts";

export async function setCaptureTarget(
  supabase: SupabaseClient,
  primeSessionId: string,
  theoSessionId: string,
  lineage: string,
  opts?: { onlyIfAbsent?: boolean; note?: string },
): Promise<{ ok: true; created: boolean } | { err: string }> {
  if (!primeSessionId) return { err: "no prime session in context — cannot record a capture target." };
  if (opts?.onlyIfAbsent) {
    const ex = await supabase.from("capture_run_target")
      .select("theo_session_id").eq("prime_session_id", primeSessionId).maybeSingle();
    if (ex.error) return { err: `capture_run_target lookup failed: ${ex.error.message}` };
    if (ex.data) return { ok: true, created: false }; // keep an existing explicit declaration; never override
  }
  const up = await supabase.from("capture_run_target").upsert({
    prime_session_id: primeSessionId,
    theo_session_id: theoSessionId,
    declared_by_lineage: lineage,
    note: opts?.note ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "prime_session_id" });
  if (up.error) return { err: `capture_run_target upsert failed: ${up.error.message}` };
  return { ok: true, created: true };
}

// Enforce-if-declared: if this prime run has declared a target, a capture write may only
// hit that session — else REJECT and name the declared target. If no declaration exists,
// allow (undeclared/legacy flows untouched; the brief makes declaration step one for guarded
// runs). Fail-OPEN on a lookup error: a transient infra hiccup must not block a legitimate
// capture (the honesty gate still catches any resulting incompleteness); the clobber needs a
// misdirected write AND a coincident lookup failure, which is not worth blocking all writes for.
export async function assertCaptureTarget(
  supabase: SupabaseClient,
  primeSessionId: string | undefined | null,
  resolvedTargetSession: string,
): Promise<{ ok: true } | { err: string }> {
  if (!primeSessionId) return { ok: true }; // no run context → cannot enforce
  const r = await supabase.from("capture_run_target")
    .select("theo_session_id").eq("prime_session_id", primeSessionId).maybeSingle();
  if (r.error) { console.error("assertCaptureTarget lookup failed (fail-open):", r.error.message); return { ok: true }; }
  const declared = (r.data as { theo_session_id?: string } | null)?.theo_session_id;
  if (!declared) return { ok: true }; // enforce-if-declared
  if (declared !== resolvedTargetSession) {
    return { err: `ownership-bind: this capture run declared its target as theo_session ${declared.slice(0, 8)}, but this write targets ${resolvedTargetSession.slice(0, 8)}. A run may only write to the synthesis it declared. If you mean to write here, call declare_capture_target with this session first (e.g. an arc/read run adopts the arc); otherwise you are about to clobber a sibling synthesis — write rejected.` };
  }
  return { ok: true };
}
