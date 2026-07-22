// coLocationGate — the anchor gate for a claim_on_fact edge. Eames rulings 83163028 (per-edge,
// co-location) + 5e1f603e (clause-scoped) + 29bc91a0 (subject-term rule v2: distinctive + coverage).
//
// Anchoring is a property of the SUPPORT RELATION, not the captured page: to anchor, THIS claim's figure
// AND THIS claim's subject must BOTH be found inside one verbatim span (anchor_quote) of the fact's
// rendered page. The reasoner LOCATES (supplies a page span); it does not ASSERT — the subject terms are
// derived here from Theo's upstream synthesis_claim.claim_text, clause-scoped to the figure.
//
// SUBJECT-TERM RULE v2 (29bc91a0, ported from Eames' tested subject_term_gate.py). NO mandatory head
// token — a single required token tests VOCABULARY match, not SUBJECT match, because claim and source
// legitimately differ in surface phrasing (accommodation vs hotels; crossings vs arrivals). Instead:
//   1. DISTINCTIVENESS — at least ONE distinctive claim term present in the quote. Distinctive = content
//      terms MINUS a synonym-prone MEASURE/CONTAINER list and MINUS temporal tokens (they name the
//      measure/context, not the subject, and are exactly what sources paraphrase).
//   2. COVERAGE — >= 50% of the clause's content terms present in the quote.
// Matching: case-insensitive, 6-char bidirectional stem/substring (industr* == industrial/industry).
//
// FAIL-SAFE: any miss yields cited_not_verified, never a silent pass. A brittle gate costs false-NEGATIVES
// (a human looks), never false-POSITIVES.

// ---- normalisation -------------------------------------------------------------------------------------

// Figure identity for the figure-in-claim and figure-in-quote checks.
export function normFigure(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/billion/g, "bn")
    .replace(/million/g, "m")
    // Percentages -> a "pct" token, NOT stripped. Stripping the % collapsed a single-digit percent to a
    // length-1 string ("8%" -> "8"), which figureIn's length>=2 guard then rejected: single-digit percents
    // (0-9%) could NEVER anchor. Mapping %/percent to the same token both fixes that and unifies the two
    // surface forms ("8%" == "8 percent") while keeping precision (an "8%" no longer matches a bare "8").
    .replace(/percent/g, "pct")
    .replace(/%/g, "pct")
    .replace(/[,\s£$€]/g, "")
    .replace(/[^a-z0-9.]/g, "");
}
export function figureIn(haystack: string, figure: string): boolean {
  const h = normFigure(haystack), n = normFigure(figure);
  return n.length >= 2 && h.includes(n);
}
// Prose identity for the quote-on-page check.
export function normProse(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

// ---- clause scoping ------------------------------------------------------------------------------------

// Trailing-attribution provenance markers (Eames 0d6af588). Provenance is context about the SOURCE, not
// the claim's subject (the third exclusion class, with measure nouns and temporal tokens) — scoping it off
// keeps it out of the coverage denominator so a figure clause isn't diluted by attribution the page never
// repeats. THE INVARIANT (ratify this, not the list): strip ONLY provenance that FOLLOWS the assertion; a
// source that LEADS the clause is subject-bearing and must survive. Same token, opposite treatment by
// POSITION: dropped in "…was 171,000, according to ONS…" but kept in "ONS revised … to 944,000". So this
// list must contain ONLY multi-word attribution phrases — NEVER bare verbs (reports/estimated/recorded),
// which appear in LEADING position ("IPCC reports…", "NAO recorded…") and would strip the subject actor.
const PROVENANCE_MARKERS = [
  "according to", "as reported by", "as recorded by", "as estimated by", "as verified by",
  "as assessed by", "as certified by", "as published in", "as published by", "reported in",
  "reported by", "published by", "per the", "data from", "figures from", "estimates from",
  "estimates by", "citing", "as set out in", "as set out by", "as stated in", "as stated by",
];

// Clause boundaries: semicolon, and/while/whereas, and trailing provenance. The provenance alternatives are
// prefixed with \s*,?\s+ — the mandatory whitespace BEFORE the marker is what enforces the invariant: a
// sentence-initial marker ("According to ONS, …") has no preceding whitespace, so it never splits, and the
// leading source is preserved. Only a mid/trailing marker (" …, according to …") fires.
const CLAUSE_SPLIT = new RegExp(
  "\\s*;\\s*|\\s+and\\s+|\\s+while\\s+|\\s+whereas\\s+|\\s*,?\\s+(?:" +
    PROVENANCE_MARKERS.join("|") + ")\\s+",
  "i",
);
export function splitClauses(text: string): string[] {
  return (text || "").split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
}
export function clauseContaining(claimText: string, figure: string): string {
  const clauses = splitClauses(claimText);
  for (const c of clauses) if (figureIn(c, figure)) return c;
  return claimText || "";
}

// ---- subject terms (Eames v2) --------------------------------------------------------------------------

const STOP = new Set(
  ("the a an of to in for on at by and or was were is are be been approximately about totalled totaled " +
   "reached stood recorded estimated reported revised representing which that with under from between per " +
   "year ending same release main plus there total according subsequently upward before after during when " +
   "as it its their this these those one two people cases person nationals reflecting targeted associated " +
   "measures").split(/\s+/),
);

// Names a MEASURE/CONTAINER rather than the subject — never distinctive, never required: the source
// routinely uses a synonym (accommodation/hotels; crossings/arrivals). Temporal tokens are added here too
// (29bc91a0 fix): months/quarters/etc. are context, not subject, so they must not satisfy distinctiveness.
const SYNONYM_PRONE = new Set(
  ("accommodation crossings arrivals spending payments rates cost costs applications returns removals " +
   "backlog estimates estimate " +
   "january february march april may june july august september october november december " +
   "quarter quarterly annual annually monthly weekly nightly daily").split(/\s+/),
);

// Eames' content_terms: strip figures (with optional currency prefix + scale suffix), keep letter/hyphen/
// apostrophe tokens longer than 2 chars that aren't stopwords, lower-cased.
export function contentTerms(text: string): string[] {
  const stripped = (text || "").replace(/[£$]?\d[\d,.]*\s*(%|percent|million|billion|bn|m)?/gi, " ");
  const words = stripped.match(/[A-Za-z][A-Za-z\-']+/g) || [];
  const out: string[] = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw.length > 2 && !STOP.has(lw) && !out.includes(lw)) out.push(lw);
  }
  return out;
}

// Leading-citation APPARATUS exclusion — the FOURTH exclusion class (Eames ratification 07e30e99, additive to
// measure-nouns / temporal / trailing-attribution). Citation MACHINERY — author-year, journal/DOI, method
// boilerplate — is provenance/how-derived, not subject, and no page span repeats it, so it dilutes the coverage
// denominator and sinks a genuinely-sourced claim. Strip it STRUCTURALLY (patterns, never a name blocklist) so a
// NAMED INSTITUTION that LEADS the clause as the subject-bearing actor (IPCC, NAO, ONS) is NEVER removed — the
// same actor-preserving invariant as the trailing-attribution rule (0d6af588). Institutions carry no "et al", sit
// in no year-parenthetical, are no DOI, and are not a method noun, so none of these patterns can reach them. If in
// doubt the pattern KEEPS the token: a false-negative costs a human review, a false-positive lets a wrong subject anchor.
// Apparatus regexes ported from Eames' tested discriminator (leadcite.py, ratification 07e30e99). Structural,
// never a name blocklist: author-year ("Jiang et al"), a year-LEADING parenthetical (journal + DOI live inside
// it), and DOI — none of which a named-institution actor (IPCC, NAO, ONS) can match. (et-al widened to
// multi-author "X and Y et al", still actor-safe: an institution carries no "et al".)
const APPARATUS_PATTERNS: RegExp[] = [
  /\b[A-Z][a-z]+(?:\s+(?:and|&)\s+[A-Z][a-z]+)*\s+et\s+al\.?/g,
  /\(\s*\d{4}[^)]*\)/g,
  /\bdoi\b:?\s*\S*/gi,
  /\b10\.\d{4,}\/\S+/g,
];
// Method boilerplate — curated multi-word phrases + derivation connectives (how-derived, not subject). Seeded
// from leadcite.py's METHOD_PHRASES; EXPANDABLE like PROVENANCE_MARKERS (the invariant is "method machinery,
// not subject", not the exact list). Removed only where a phrase appears VERBATIM, so an unlisted method phrase
// merely dilutes coverage → a human review (fail-safe), never a wrong anchor.
// STANDING RULE for additions (Eames 7767ac01): every entry must be a MULTIWORD method phrase whose removal
// leaves a grammatical object behind (or a bare derivation connective like "based on"). NEVER add a bare method
// NOUN — "analysis", "model", "assessment", "review" — on its own: those collide with subject usage. Matching
// the WHOLE phrase is exactly what keeps those words untouched when they are the subject ("water saving systems
// assessment", "asylum outcomes review"). Phrases only; erring short stays safe.
const METHOD_PHRASES: string[] = [
  "input-output analysis", "input output analysis", "dynamic material flow analysis", "material flow analysis",
  "life cycle assessment", "life-cycle assessment", "lifecycle assessment", "regression analysis",
  "sensitivity analysis", "meta-analysis", "monte carlo simulation", "econometric analysis", "systematic review",
  "using", "integrated with", "based on", "drawing on",
];
function escapeRe(s: string): string { return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"); }
export function stripApparatus(text: string): string {
  let c = text || "";
  for (const p of APPARATUS_PATTERNS) c = c.replace(p, " ");
  for (const m of METHOD_PHRASES) c = c.replace(new RegExp("\\b" + escapeRe(m) + "\\b", "gi"), " ");
  return c;
}

// 6-char bidirectional stem/substring match, as in Eames' gate().
function termMatches(t: string, pageTerms: string[]): boolean {
  const ts = t.slice(0, 6);
  return pageTerms.some((p) => p.includes(ts) || t.includes(p.slice(0, 6)));
}

// The subject decision (Eames v2), exposed for testing: distinctive >= 1 AND coverage >= 0.5.
// claimTerms are the clause-scoped content terms; quoteText is the anchor span (or a page string).
export function subjectCoLocate(claimTerms: string[], quoteText: string):
  { pass: boolean; coverage: number; present: string[]; distinctivePresent: string[] } {
  const quoteTerms = contentTerms(quoteText);
  const present = claimTerms.filter((t) => termMatches(t, quoteTerms));
  const distinctivePresent = claimTerms.filter((t) => !SYNONYM_PRONE.has(t) && termMatches(t, quoteTerms));
  const coverage = present.length / Math.max(1, claimTerms.length);
  return { pass: distinctivePresent.length >= 1 && coverage >= 0.5, coverage, present, distinctivePresent };
}

// ---- the gate ------------------------------------------------------------------------------------------

export interface GateInput {
  claimText: string;
  pageContent: string;
  anchorQuote: string;
  claimFigure: string | null;
  hasScreenshot: boolean;
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
  // 3. Subject co-location — Eames v2: distinctive >= 1 AND coverage >= 0.5, over clause-scoped terms.
  const clause = clauseContaining(inp.claimText, figure);
  const claimTerms = contentTerms(stripApparatus(clause));  // 4th exclusion class: drop citation apparatus, keep the actor
  if (claimTerms.length === 0) {
    return none("cited_not_verified", "pending", "no subject terms could be extracted from the figure's clause");
  }
  const d = subjectCoLocate(claimTerms, quote);
  if (!d.pass) {
    return {
      verificationState: "cited_not_verified", reviewState: "pending",
      reason: `subject did not co-locate: coverage ${d.present.length}/${claimTerms.length}=${d.coverage.toFixed(2)}` +
        `, distinctive present [${d.distinctivePresent.join(", ")}]`,
      subjectTerms: claimTerms, matchedTerms: d.present,
    };
  }
  return {
    verificationState: "anchored", reviewState: "not_required",
    reason: `co-located: figure '${figure}' + subject (coverage ${d.coverage.toFixed(2)}, distinctive [${d.distinctivePresent.join(", ")}]) in the anchor_quote on the page`,
    subjectTerms: claimTerms, matchedTerms: d.present,
  };
}
