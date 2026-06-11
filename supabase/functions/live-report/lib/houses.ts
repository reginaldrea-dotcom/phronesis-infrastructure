// House keying. Reweighting is over HOUSES, not citations (Decision 1, fence 3): a
// citation's URL identifies its research house, and several citations across engines
// can resolve to one house — they must collapse to a single weight/data point.
//
// claim_figure.house_key is authoritative once figures are populated research-side.
// For citations without a structured figure (status-only claims), we derive the
// house_key from the citation host so reweighting still groups them correctly.

interface HouseDef { house_key: string; display_name: string; }

// The named houses on the AESSEAL spine (session 353faa7d). Keyed by registrable host.
const HOST_TO_HOUSE: Record<string, HouseDef> = {
  "mordorintelligence.com":        { house_key: "mordor_intelligence",        display_name: "Mordor Intelligence" },
  "grandviewresearch.com":         { house_key: "grand_view_research",        display_name: "Grand View Research" },
  "marketsandmarkets.com":         { house_key: "marketsandmarkets",          display_name: "MarketsandMarkets" },
  "persistencemarketresearch.com": { house_key: "persistence_market_research", display_name: "Persistence Market Research" },
  "fortunebusinessinsights.com":   { house_key: "fortune_business_insights",  display_name: "Fortune Business Insights" },
  "technavio.com":                 { house_key: "technavio",                  display_name: "Technavio" },
};

function registrableHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    // collapse a sub.domain.tld to the registrable domain.tld (good enough for these hosts)
    const parts = host.split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : host;
  } catch {
    return null;
  }
}

// Resolve a citation (url + title) to a house. Falls back to the registrable host as the
// key and the title (or host) as the display name when the house is not in the known map.
export function houseForCitation(url: string | null, title: string | null): HouseDef {
  const host = registrableHost(url);
  if (host && HOST_TO_HOUSE[host]) return HOST_TO_HOUSE[host];
  if (host) return { house_key: host.replace(/[^a-z0-9]+/g, "_"), display_name: title ?? host };
  // No URL at all: key off a slug of the title so it still groups deterministically.
  const slug = (title ?? "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return { house_key: slug || "unknown", display_name: title ?? "Unknown house" };
}
