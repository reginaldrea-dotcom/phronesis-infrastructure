// Email alert via Resend (https://resend.com). Supabase Edge Functions block outbound SMTP, so email must
// go through an HTTPS API — Resend is a single POST, free tier, no SMTP. Sends only if RESEND_API_KEY is
// set (no-op otherwise, so callers can invoke unconditionally). Best-effort: never throws into the caller.
//
// TO   = ALERT_EMAIL secret (falls back to the owner's address below).
// FROM = EMAIL_FROM secret (falls back to Resend's shared onboarding sender). NOTE: with the onboarding
//        sender and no verified domain, Resend only DELIVERS to the Resend account owner's own email —
//        which is exactly the personal-alert-to-yourself case here. To send elsewhere, verify a domain in
//        Resend and set EMAIL_FROM to an address on it.

const DEFAULT_TO = "reginaldrea@gmail.com";
const DEFAULT_FROM = "Phronesis Alerts <onboarding@resend.dev>";

export async function notifyEmail(subject: string, text: string): Promise<{ ok: boolean; detail?: string }> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, detail: "RESEND_API_KEY not set" };
  const to = Deno.env.get("ALERT_EMAIL") || DEFAULT_TO;
  const from = Deno.env.get("EMAIL_FROM") || DEFAULT_FROM;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    const body = (await res.text()).slice(0, 300);
    if (!res.ok) {
      console.error("notifyEmail non-OK:", res.status, body);
      return { ok: false, detail: `HTTP ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (e) {
    console.error("notifyEmail failed (non-fatal):", e);
    return { ok: false, detail: String(e) };
  }
}
