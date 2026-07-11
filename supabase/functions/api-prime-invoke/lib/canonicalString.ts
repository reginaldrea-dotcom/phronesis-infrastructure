// canonical_string — Mode-1 figure-match normalisation. Ported from Eames's language-agnostic reference
// (SP 6df44541, canonical_string.py, sha256 ebe33bcc...09063) to the gate's actual language: the api-prime-invoke
// TS EF (confirmed by Heph, baton b28d6e36). Currency ruling extended per Napoleon (baton b28d6e36, ratifying
// Eames's flagged knob; Aegis confirms at the Denial Proof).
//
// INTENT: make verify_figure's match FORMAT-INDEPENDENT structurally, so a caller cannot flip
// CITED_NOT_VERIFIED <-> ANCHORED by re-typing the same figure differently. Anchor state depends on the VALUE
// on the page, never on presentation.
//
// GOVERNING PRINCIPLE (Napoleon): ERR FALSE-NEGATIVE, NEVER FALSE-POSITIVE. A false CITED_NOT_VERIFIED is safe
// (the caller re-anchors); a false ANCHORED to the wrong figure is career-grade. Every ambiguous case FAILS.
//
// CARE POINTS ON PORT (Eames):
//  (1) DECIMAL not float. We use an exact BigInt (reduced mantissa, exponent) key — 7.6e9 equals 7,600,000,000
//      equals "7,600 million" exactly; no IEEE-754 error can enter. NO numerical tolerance band, ever
//      (7.6bn != 7.63bn MUST fail — that band is the judgement the gate exists to remove).
//  (2) fullmatch semantics for single-token normalise vs finditer (scan) for figure_present.
//  (3) percent matches only percent (12% != 12; 12% != 0.12 — never silently converted).

export type FigureKind = "plain" | "percent";
export type Currency = "GBP" | "USD" | "EUR" | null;

// A parsed figure: an EXACT value as (mantissa, exp) reduced so equal values share one key, plus kind + currency.
export interface CanonicalFigure {
  mantissa: bigint; // reduced: no trailing-zero factors of 10 (those live in exp). 0 is mantissa=0n, exp=0.
  exp: number;      // power of ten: value = mantissa * 10^exp
  kind: FigureKind;
  cur: Currency;
}

const SCALE_WORDS: Record<string, number> = {
  k: 3, thousand: 3, thousands: 3,
  m: 6, mn: 6, mm: 6, million: 6, millions: 6,
  b: 9, bn: 9, billion: 9, billions: 9,
  t: 12, tr: 12, trn: 12, trillion: 12, trillions: 12,
};

const CURRENCY_SYMBOL: Record<string, Currency> = { "£": "GBP", "$": "USD", "€": "EUR" };
const CURRENCY_CODE: Record<string, Currency> = { gbp: "GBP", usd: "USD", eur: "EUR" };

// Reduce (mantissa, exp) by dividing out factors of 10 so equal values share one canonical key.
function reduce(mantissa: bigint, exp: number): { mantissa: bigint; exp: number } {
  if (mantissa === 0n) return { mantissa: 0n, exp: 0 };
  let m = mantissa < 0n ? -mantissa : mantissa;
  let e = exp;
  while (m % 10n === 0n) { m /= 10n; e += 1; }
  return { mantissa: mantissa < 0n ? -m : m, exp: e };
}

// Parse a bare numeric string (may carry thousands separators + a decimal point) to an exact (mantissa, exp).
// Returns null on anything that is not a clean number.
function parseNumber(raw: string): { mantissa: bigint; exp: number } | null {
  const s = raw.replace(/,/g, ""); // thousands separators are presentation only
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf(".");
  if (dot === -1) {
    return { mantissa: (neg ? -1n : 1n) * BigInt(body), exp: 0 };
  }
  const intPart = body.slice(0, dot);
  const fracPart = body.slice(dot + 1);
  const digits = intPart + fracPart;         // 7.6 -> "76"
  const exp = -fracPart.length;              // ...with exp -1
  return { mantissa: (neg ? -1n : 1n) * BigInt(digits), exp };
}

// The single-token matcher: one figure token -> its canonical key, or null if the whole string is not one figure.
// (2) fullmatch semantics — the entire trimmed string must be exactly one figure token.
export function normalise(input: string): CanonicalFigure | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;

  // percent notation (%, per cent, pc) — kind, not value. Strip and remember. (3) percent stays percent.
  let kind: FigureKind = "plain";
  const pct = /(%|per\s*cent|pc)\s*$/;
  if (pct.test(s)) { kind = "percent"; s = s.replace(pct, "").trim(); }

  // leading currency symbol or trailing/leading code (£, $, EUR, usd ...)
  let cur: Currency = null;
  const symMatch = s.match(/^([£$€])\s*/);
  if (symMatch) { cur = CURRENCY_SYMBOL[symMatch[1]]; s = s.slice(symMatch[0].length).trim(); }
  const codeMatch = s.match(/^(gbp|usd|eur)\s+/) || s.match(/\s+(gbp|usd|eur)$/);
  if (codeMatch) { cur = CURRENCY_CODE[codeMatch[1]]; s = s.replace(codeMatch[0], " ").trim(); }

  // optional scale word (k / m / bn / trillion ...) after the number, with or without a space
  let scaleExp = 0;
  const scaleMatch = s.match(/^([\d.,]+)\s*([a-z]+)$/);
  let numberStr = s;
  if (scaleMatch) {
    const word = scaleMatch[2];
    if (!(word in SCALE_WORDS)) return null; // a trailing word we do not recognise -> not a clean figure
    scaleExp = SCALE_WORDS[word];
    numberStr = scaleMatch[1];
  }

  const parsed = parseNumber(numberStr);
  if (parsed === null) return null;

  const { mantissa, exp } = reduce(parsed.mantissa, parsed.exp + scaleExp);
  return { mantissa, exp, kind, cur };
}

// Exact value equality: same reduced (mantissa, exp). No tolerance.
function sameValue(a: CanonicalFigure, b: CanonicalFigure): boolean {
  return a.mantissa === b.mantissa && a.exp === b.exp;
}

// figures_match(a, b, strict_currency): value + kind must match; currency per the ruling.
//  - lenient (default): if BOTH carry a currency they must be the SAME; a bare number matches a currency-tagged
//    number on value (symbol normalised away).
//  - strict_currency: currency must match whenever EITHER side carries one (bare vs £ fails).
export function figuresMatch(a: CanonicalFigure, b: CanonicalFigure, strictCurrency = false): boolean {
  if (a.kind !== b.kind) return false;
  if (!sameValue(a, b)) return false;
  if (strictCurrency) {
    if (a.cur !== null || b.cur !== null) return a.cur === b.cur;
    return true;
  }
  if (a.cur !== null && b.cur !== null) return a.cur === b.cur;
  return true;
}

// Scan text for figure-like tokens (finditer, care point 2). Captures optional currency, number with separators,
// optional scale word, optional percent — the same shapes normalise() accepts.
const PAGE_TOKEN_RE =
  /([£$€]\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(\s*(?:k|thousand|thousands|m|mn|mm|million|millions|b|bn|billion|billions|t|tr|trn|trillion|trillions))?(\s*(?:%|per\s*cent|pc))?/gi;

export function scanFigures(pageText: string): CanonicalFigure[] {
  if (typeof pageText !== "string" || !pageText) return [];
  const out: CanonicalFigure[] = [];
  for (const m of pageText.matchAll(PAGE_TOKEN_RE)) {
    const token = m[0].trim();
    if (!token) continue;
    // require at least a digit and either a scale/percent/currency or a standalone number
    const c = normalise(token);
    if (c) out.push(c);
  }
  return out;
}

// figure_present(query, page_text) -> ANCHORED?  The Mode-1 verdict, with Napoleon's page-ambiguity guard.
//
// A query token is present iff some page token figures_match it. THEN the guard (err false-negative):
//  - PAGE-AMBIGUITY GUARD (b): if the query carries NO currency and the value-matching page tokens carry MORE
//    THAN ONE distinct currency, the anchor FAILS rather than pick one (a bare number over an ambiguous page).
//  - strictCurrency (c): financial Dossiers pass strictCurrency=true so a bare query never matches a currency page.
export interface FigurePresentResult {
  anchored: boolean;
  reason: "anchored" | "not_found" | "page_ambiguous_currency";
  matched_currencies?: string[];
}

export function figurePresent(query: string, pageText: string, strictCurrency = false): FigurePresentResult {
  const q = normalise(query);
  if (!q) return { anchored: false, reason: "not_found" };
  const pageTokens = scanFigures(pageText);

  // value+kind matches on the page, regardless of currency (so we can inspect currency ambiguity)
  const valueKindMatches = pageTokens.filter((p) => p.kind === q.kind && sameValue(p, q));
  if (valueKindMatches.length === 0) return { anchored: false, reason: "not_found" };

  // Guard (b): bare query + more than one distinct currency at that value on the page -> ambiguous -> FAIL.
  if (q.cur === null && !strictCurrency) {
    const currencies = new Set(valueKindMatches.map((p) => p.cur).filter((c): c is Currency => c !== null));
    if (currencies.size > 1) {
      return { anchored: false, reason: "page_ambiguous_currency", matched_currencies: [...currencies] as string[] };
    }
  }

  // Otherwise apply the per-token currency rule; ANCHORED iff any token passes.
  const anchored = valueKindMatches.some((p) => figuresMatch(p, q, strictCurrency));
  return anchored ? { anchored: true, reason: "anchored" } : { anchored: false, reason: "not_found" };
}
