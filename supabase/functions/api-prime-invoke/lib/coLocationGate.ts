// coLocationGate — the anchor gate for a claim_on_fact edge. Eames rulings 83163028 (per-edge,
// co-location) + 5e1f603e (clause-scoped extraction).
//
// Anchoring is a property of the SUPPORT RELATION, not the captured page: to anchor, THIS claim's figure
// AND THIS claim's subject must BOTH be found inside one verbatim span (anchor_quote) of the fact's
// rendered page. The reasoner LOCATES (supplies a page span); it does not ASSERT — the subject terms are
// derived here from Theo's upstream synthesis_claim.claim_text, so the party seeking the anchor never
// chooses the subject it must match against.
//
// CLAUSE-SCOPED (5e1f603e): subject terms come from the CLAUSE CONTAINING THE FIGURE, not the whole claim.
// A claim carrying two figures with different subjects ("enforced returns … 8,164 and voluntary returns …
// 25,186") would otherwise yield a flat term bag and let the 8,164 edge co-locate against a "voluntary …
// 25,186" span — the industry/buildings failure one level in. Clause-scoping keeps the subjects separate.
//
// FAIL-SAFE: any miss yields cited_not_verified, never a silent pass. Brittleness costs false-NEGATIVES
// (a human looks), never false-POSITIVES — the correct direction for the error to point.
//
// NOTE: the stopword set + term threshold below are provisional to this spec; Eames holds a reference
// regex/stopword set tested against the 15 sweep claims. Reconcile against his probes via the acceptance
// test (coLocationGate.test.ts): the 4 separation cases must separate AND industry/buildings must fail.

// ---- normalisation -------------------------------------------------------------------------------------

// Figure identity: lower-case, fold million/billion to m/bn, strip separators/currency/percent. So
// "£290 million" == "£290m" == "290000000"? no — we match figures AS WRITTEN in prose (claim_text vs the
// page span), where both use the same surface form; the m/bn fold covers the common "290 million"/"290m"
// split. Needle must be >=2 chars to be meaningful evidence.
export function normFigure(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/billion/g, "bn")
    .replace(/million/g, "m")
    .replace(/[,\s£$€%]/g, "")
    .replace(/[^a-z0-9.]/g, "");
}

export function figureIn(haystack: string, figure: string): boolean {
  const h = normFigure(haystack), n = normFigure(figure);
  return n.length >= 2 && h.includes(n);
}

// Prose identity for quote-on-page and term matching: lower-case, non-alphanumerics to spaces, collapse.
// Markdown artefacts (asterisks, links, quotes) and whitespace differences between the rendered page and
// the supplied span therefore don't break the match.
export function normProse(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

// ---- clause scoping + subject terms --------------------------------------------------------------------

// Split on clause boundaries: semicolon, and/while/whereas (comma-and is covered by the bare "and"). Bare
// "and" over-splits phrases like "iron and steel", but that is fail-safe: over-splitting yields FEWER
// terms in the figure's clause -> at worst a false-negative (human looks), never a false-positive.
export function splitClauses(text: string): string[] {
  return (text || "")
    .split(/\s*;\s*|\s+and\s+|\s+while\s+|\s+whereas\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

// The clause containing the figure (normalised match). Falls back to the whole text if no clause carries it.
export function clauseContaining(claimText: string, figure: string): string {
  const clauses = splitClauses(claimText);
  for (const c of clauses) if (figureIn(c, figure)) return c;
  return claimText || "";
}

// Content words that are scaffolding, not subject. Month names are deliberately NOT here — "December"
// distinguishes one release/period from another and is a real subject term (Eames' 813,000 case).
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "and", "or", "was", "were", "is", "are", "be",
  "been", "by", "with", "as", "that", "which", "this", "these", "those", "from", "into", "per", "its",
  "their", "it", "some", "same", "release", "approximately", "about", "around", "reached", "totalled",
  "total", "accounted", "stood", "reflecting", "targeted", "recorded", "estimated", "reported", "reports",
  "report", "subsequently", "revised", "upward", "upwards", "provisional", "estimate", "estimates",
  "published", "year", "ending", "period", "between", "under", "over", "up", "down", "figure", "figures",
  "representing", "including", "dominate", "dominates",
]);

// Extract distinctive subject terms from a clause: lower-case, drop figures/dates/currency, drop stopwords,
// keep content tokens (>=3 chars, or a hyphenated/compound token). Preserves order of appearance.
export function extractSubjectTerms(clause: string): string[] {
  const cleaned = (clause || "")
    .toLowerCase()
    .replace(/£|\$|€|%/g, " ")
    .replace(/\b\d[\d,.]*\b/g, " ")      // strip figures and 4-digit years
    .replace(/[^a-z\s-]/g, " ");
  const out: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    const t = raw.replace(/^-+|-+$/g, "").trim();
    if (!t || t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// A term matches a span by conservative stem/substring: "industr" matches industrial/industry. Stem =
// drop a common inflectional suffix; match if the normalised span contains the stem.
function stem(term: string): string {
  return term.replace(/(ies|ing|ed|es|s|al|ly)$/i, "");
}
export function termInQuote(term: string, quote: string): boolean {
  const q = normProse(quote);
  const st = stem(term);
  if (st.length < 3) return q.includes(normProse(term));
  return q.includes(st);
}

// Threshold: a majority of clause terms must co-locate AND the most distinctive (longest) term must be
// present — the "head noun-phrase" guard. Tunable; the acceptance test pins the required behaviour.
function longest(terms: string[]): string | null {
  let best: string | null = null;
  for (const t of terms) if (!best || t.length > best.length) best = t;
  return best;
}

// ---- the gate ------------------------------------------------------------------------------------------

export interface GateInput {
  claimText: string;         // synthesis_claim.claim_text (upstream, Theo's)
  pageContent: string;       // source_document.content (rendered page text)
  anchorQuote: string;       // reasoner-supplied verbatim span it claims supports the link
  claimFigure: string | null; // the claim's load-bearing figure this edge anchors; null => qualitative
  hasScreenshot: boolean;    // does the fact have a frozen screenshot (for the qualitative review path)
}
export interface GateResult {
  verificationState: "anchored" | "screenshot_review" | "cited_not_verified";
  reviewState: "not_required" | "pending";
  reason: string;
  subjectTerms: string[];
  matchedTerms: string[];
}

export function runCoLocationGate(inp: GateInput): GateResult {
  const quote = (inp.anchorQuote || "").trim();
  const none = (state: GateResult["verificationState"], review: GateResult["reviewState"], reason: string):
    GateResult => ({ verificationState: state, reviewState: review, reason, subjectTerms: [], matchedTerms: [] });

  // Qualitative edge (no figure to co-locate): a human confirms the screenshot supports the claim.
  if (!inp.claimFigure || !inp.claimFigure.trim()) {
    if (quote && inp.hasScreenshot) return none("screenshot_review", "pending", "qualitative — screenshot awaits human review");
    return none("cited_not_verified", "pending", "qualitative — no quote or no screenshot to review");
  }
  const figure = inp.claimFigure.trim();

  // 0. The figure must be the claim's OWN figure (the reasoner can't invent one it then anchors).
  if (!figureIn(inp.claimText, figure)) {
    return none("cited_not_verified", "pending", `figure '${figure}' is not present in the claim being grounded`);
  }
  // 1. The anchor_quote must actually be on the rendered page.
  if (!quote || !normProse(inp.pageContent).includes(normProse(quote))) {
    return none("cited_not_verified", "pending", "anchor_quote is not present verbatim on the rendered page");
  }
  // 2. The figure must be inside the quote.
  if (!figureIn(quote, figure)) {
    return none("cited_not_verified", "pending", `figure '${figure}' is not inside the anchor_quote`);
  }
  // 3. The clause-scoped subject terms must co-locate in the quote (majority + head-noun guard).
  const clause = clauseContaining(inp.claimText, figure);
  const terms = extractSubjectTerms(clause);
  if (terms.length === 0) {
    return none("cited_not_verified", "pending", "no subject terms could be extracted from the figure's clause");
  }
  const matched = terms.filter((t) => termInQuote(t, quote));
  const head = longest(terms);
  const majority = matched.length >= Math.max(1, Math.ceil(terms.length / 2));
  const headOk = head ? termInQuote(head, quote) : true;
  if (!majority || !headOk) {
    return {
      verificationState: "cited_not_verified", reviewState: "pending",
      reason: `subject did not co-locate: matched ${matched.length}/${terms.length}` +
        (headOk ? "" : `, head term '${head}' absent`),
      subjectTerms: terms, matchedTerms: matched,
    };
  }
  return {
    verificationState: "anchored", reviewState: "not_required",
    reason: `co-located: figure '${figure}' + subject (${matched.length}/${terms.length} terms incl. head '${head}') in the anchor_quote on the page`,
    subjectTerms: terms, matchedTerms: matched,
  };
}
