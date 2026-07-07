// Microsoft Teams incoming-webhook notifier. Posts to the URL in the TEAMS_WEBHOOK_URL secret (a Supabase
// env secret — never in code or chat). No-op if the secret is unset, so callers can invoke it
// unconditionally. Best-effort: never throws into the caller's path.
//
// Payload uses the Adaptive Card envelope accepted by the current Teams "Workflows" incoming webhook
// (Power Automate — the legacy O365 "Incoming Webhook" connector / MessageCard is being retired). Create
// the webhook via: Teams channel -> Workflows -> "Post to a channel when a webhook request is received".

export async function notifyTeams(
  title: string,
  text: string,
  opts?: { attention?: boolean; facts?: Record<string, string> },
): Promise<boolean> {
  const url = Deno.env.get("TEAMS_WEBHOOK_URL");
  if (!url) return false; // notifier not configured — silently skip

  const body = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: title,
              weight: "Bolder",
              size: "Large",
              wrap: true,
              color: opts?.attention ? "Attention" : "Default",
            },
            { type: "TextBlock", text, wrap: true },
            ...(opts?.facts
              ? [{
                  type: "FactSet",
                  facts: Object.entries(opts.facts).map(([t, v]) => ({ title: t, value: v })),
                }]
              : []),
          ],
        },
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("notifyTeams non-OK:", res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error("notifyTeams failed (non-fatal):", e);
    return false;
  }
}
