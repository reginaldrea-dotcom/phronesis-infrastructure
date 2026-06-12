// House resolution. Reweighting is over HOUSES (Decision 1, fence 3). The authoritative
// registry is source_house (id, canonical_name, aliases[]); claim_figure rows already
// carry house_id directly. The work here is resolving a status-only CITATION (no figure)
// to its source_house, so excluding a house also drops its status-only support.
//
// Resolution: match the citation's registrable host or its title against a house's
// canonical_name + aliases. ASSUMPTION (flagged to Connie): source_house.aliases includes
// the registrable domain (e.g. "mordorintelligence.com") and/or name variants.
//
// Fallback: when source_house is empty (pre-population) or a citation matches nothing, a
// deterministic URL-derived synthetic id keeps status-only recompute working. Once the
// registry is populated with aliases, citations resolve to the real source_house.id and
// the engine + surface key on the same house_id.

export interface SourceHouseRow {
  id: string;
  canonical_name: string;
  aliases: string[] | null;
}

export interface ResolvedHouse {
  house_id: string;
  display_name: string;
}

function registrableHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const parts = host.split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : host;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Resolve a citation to a registered house, or synthesise a stable fallback identity.
export function resolveHouse(registry: SourceHouseRow[], url: string | null, title: string | null): ResolvedHouse {
  const host = registrableHost(url);
  const titleNorm = title ? norm(title) : "";

  for (const h of registry) {
    const aliases = (h.aliases ?? []).map((a) => a.toLowerCase());
    // host match: an alias equals or is contained by the registrable host
    if (host && aliases.some((a) => a === host || host.includes(a) || a.includes(host))) {
      return { house_id: h.id, display_name: h.canonical_name };
    }
    // name match: canonical_name or an alias appears in the citation title
    const nameNeedles = [norm(h.canonical_name), ...aliases.map(norm)].filter(Boolean);
    if (titleNorm && nameNeedles.some((n) => n.length >= 3 && titleNorm.includes(n))) {
      return { house_id: h.id, display_name: h.canonical_name };
    }
  }

  // Fallback (pre-population / unmatched): deterministic synthetic id from the host, else title.
  if (host) return { house_id: `host:${host}`, display_name: title ?? host };
  const slug = norm(title ?? "unknown").replace(/\s+/g, "_") || "unknown";
  return { house_id: `name:${slug}`, display_name: title ?? "Unknown house" };
}
