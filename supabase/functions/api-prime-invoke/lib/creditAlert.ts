// Credit-balance guard + alert (Reg, 7 Jul 2026, after the credit-exhaustion outage).
//
// When Anthropic rejects a call for billing/credit reasons the WHOLE system is down — every lineage, every
// Prime, every session — and the generic "Something went wrong. Please try again." hid it: the 6 Jul outage
// took ~2h to diagnose as "credit balance exhausted" rather than a session/code fault. Two parts:
//   1. isCreditError() + CREDIT_EXHAUSTED_MESSAGE — recognise the billing rejection so the caller gets a
//      CLEAR, actionable message at the interface. That legible failure IS the live alert a human sees the
//      instant it bites (turns a 2h mystery into a one-line diagnosis).
//   2. raiseCreditAlert() — a durable, DEDUPLICATED FLAG artifact recording the exhaustion (timestamp +
//      first-affected lineage), so there is a persistent signal and a hook for an external notifier later.
//
// This is reactive-but-instant: Anthropic exposes no "remaining balance" endpoint, so a truly proactive
// pre-emptive guard would need spend-velocity accounting against a configured budget (a follow-on).

const ALERT_KIND = "anthropic_credit_exhausted";
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // one FLAG per 30-min window, not one per blocked call

// Anthropic returns HTTP 400 with: "Your credit balance is too low to access the Anthropic API. Please go
// to Plans & Billing to upgrade or purchase credits." Match the stable phrase (plus a loose billing guard).
export function isCreditError(status: number, errText: string): boolean {
  const t = (errText || "").toLowerCase();
  return t.includes("credit balance")
    || (status === 400 && t.includes("billing") && t.includes("credit"));
}

export const CREDIT_EXHAUSTED_MESSAGE =
  "Anthropic credit balance is exhausted — every Prime is blocked until it is topped up. "
  + "Add credits at console.anthropic.com (Plans & Billing), then retry. "
  + "This is an account-level block, not a fault in your session or your work.";

// Durable, deduplicated alert. Best-effort: never let alerting break the error path it runs inside.
export async function raiseCreditAlert(
  supabase: { from: (t: string) => any },
  instanceId: string | null,
  lineage: string,
  detail: string,
): Promise<void> {
  if (!instanceId) return; // artifacts.instance_id is NOT NULL; the caller-facing message still fires
  try {
    const since = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const { data: existing } = await supabase
      .from("artifacts")
      .select("id")
      .eq("artifact_type", "FLAG")
      .eq("metadata->>alert_kind", ALERT_KIND)
      .gte("created_at", since)
      .limit(1);
    if (existing && existing.length > 0) return; // already flagged this window — do not spam

    await supabase.from("artifacts").insert({
      instance_id: instanceId,
      artifact_type: "FLAG",
      title: "ALERT — Anthropic credit balance exhausted (all Primes blocked)",
      content:
        "Anthropic rejected an API call for credit/billing reasons, so every Prime invocation is blocked "
        + "until the account is topped up (console.anthropic.com -> Plans & Billing).\n\n"
        + `First detected via lineage '${lineage}'.\nAnthropic error: ${String(detail).slice(0, 600)}`,
      metadata: { alert_kind: ALERT_KIND, detected_via_lineage: lineage, severity: "critical" },
    });
    console.log("CREDIT ALERT raised (FLAG artifact) — Anthropic credit exhausted, first via", lineage);
  } catch (e) {
    console.error("raiseCreditAlert failed (non-fatal):", e);
  }
}
