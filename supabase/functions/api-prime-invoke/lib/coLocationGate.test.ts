// Acceptance test for the co-location gate, subject-term rule v2 (Eames 29bc91a0, ported from his tested
// subject_term_gate.py + the temporal fix he specified + a provenance clause-split for real-corpus claims).
// Run: deno test --no-check coLocationGate.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { subjectCoLocate, runCoLocationGate, clauseContaining, contentTerms, figureIn, stripApparatus } from "./coLocationGate.ts";

// --- Leading-citation APPARATUS exclusion (Eames ratification 07e30e99, 4th exclusion class) --------------
Deno.test("apparatus: the full bloated Jiang-et-al claim now anchors (citation + method stripped)", () => {
  const r = runCoLocationGate({
    claimText: "Jiang et al. (2023, Environmental Science & Technology, DOI 10.1021/acs.est.3c06180) find that in 2019, machinery production required 8% of global carbon emissions, using input-output analysis integrated with dynamic material flow analysis; this figure covers the full lifecycle supply-chain carbon footprint.",
    pageContent: "machinery production required 30% of global\nmetal production and 8% of global carbon emissions.",
    anchorQuote: "machinery production required 30% of global\nmetal production and 8% of global carbon emissions",
    claimFigure: "8%", hasScreenshot: true,
  });
  assertEquals(r.verificationState, "anchored", r.reason);
});
Deno.test("apparatus: a LEADING INSTITUTION actor is NEVER stripped (IPCC, NAO survive)", () => {
  assert(contentTerms(stripApparatus("IPCC AR6 WG3 reports the industrial sector accounted for 24% of direct global GHG emissions in 2019")).includes("ipcc"), "IPCC actor must survive");
  assert(contentTerms(stripApparatus("The NAO estimated the marginal cost at £182,000")).includes("nao"), "NAO actor must survive");
});
// Eames' leadcite.py discriminator cases, ported verbatim (07e30e99): apparatus dropped, subject KEPT, a leading
// institution actor never stripped. [clause, must-keep subject terms, must-be-dropped apparatus terms]
const LEADCITE: [string, string[], string[]][] = [
  ["Jiang et al. (2023, Environmental Science & Technology, DOI 10.1021/acs.est.3c01234) find that global steel production accounts for 8% of industrial emissions using input-output analysis integrated with dynamic material flow analysis",
    ["steel", "production", "industrial", "emissions"], ["jiang", "environmental", "science", "technology", "doi"]],
  ["IPCC AR6 WG3 reports the industrial sector accounted for 24% of direct global GHG emissions",
    ["ipcc", "industrial", "sector", "direct", "ghg", "emissions"], []],
  ["The National Audit Office estimated the marginal cost at £182,000",
    ["national", "audit", "office", "marginal", "cost"], []],
];
for (const [clause, keep, drop] of LEADCITE) {
  Deno.test(`leadcite: ${clause.slice(0, 42)}...`, () => {
    const after = contentTerms(stripApparatus(clause));
    for (const k of keep) assert(after.includes(k), `subject '${k}' must survive: ${after}`);
    for (const d of drop) assert(!after.includes(d), `apparatus '${d}' must be dropped: ${after}`);
  });
}

// --- Single-digit percent regression (the 8% bug: "8%" collapsed to "8" and failed the length>=2 guard) --
Deno.test("figure: a single-digit percent anchors when subject + figure co-locate", () => {
  const r = runCoLocationGate({
    claimText: "Machinery production required 8% of global carbon emissions in 2019, according to Jiang et al. (2023).",
    pageContent: "machinery production required 30% of global\nmetal production and 8% of global carbon emissions.",
    anchorQuote: "machinery production required 30% of global\nmetal production and 8% of global carbon emissions",
    claimFigure: "8%", hasScreenshot: true,
  });
  assertEquals(r.verificationState, "anchored", r.reason);
});
Deno.test("figure: '%' and 'percent' surface forms normalise alike", () => {
  assert(figureIn("8 percent of global carbon emissions", "8%"), "8 percent should match 8%");
  assert(figureIn("8% of global carbon emissions", "8 percent"), "8% should match 8 percent");
  assert(!figureIn("the figure was 8 out of 10", "8%"), "a bare 8 must NOT match 8% (precision kept)");
});

// --- The provenance invariant (Eames 0d6af588): strip TRAILING attribution, keep a LEADING source -------
Deno.test("invariant: trailing 'according to ONS' is stripped from the figure clause", () => {
  const terms = contentTerms(clauseContaining("UK net migration for the year ending December 2025 was 171,000, according to ONS provisional estimates published 21 May 2026.", "171,000"));
  assert(!terms.includes("ons"), `trailing ONS should be stripped: ${terms}`);
  assert(terms.includes("migration"), `subject should survive: ${terms}`);
});
Deno.test("invariant: a LEADING source (ONS ... revised) is NOT stripped — it is subject-bearing", () => {
  const terms = contentTerms(clauseContaining("ONS subsequently revised the 2023 net migration peak upward to 944,000.", "944,000"));
  assert(terms.includes("ons"), `leading ONS must survive: ${terms}`);
  assert(terms.includes("migration") && terms.includes("peak"), `subject must survive: ${terms}`);
});

// --- Eames' tested table: distinctive >= 1 AND coverage >= 0.5, no mandatory head token ----------------
// (term-lists + page strings exactly as in his subject_term_gate.py, run through the SAME code path.)
const TABLE: [string, string[], string, boolean][] = [
  ["24% industry", ["industrial","sector","direct","ghg","emissions"], "industrial sector accounted for 24% of direct global GHG emissions", true],
  ["171,000 net migration", ["net","migration","december","long-run","uk","ons"], "net migration in the year ending December 2025 was 171,000 ONS provisional", true],
  ["£4.7bn asylum (was false-neg)", ["home","office","spending","hotel-based","asylum","accommodation","billion","march"], "Home Office spending on asylum support reached £4.7 billion in the year ending March 2024, including hotels", true],
  ["39,000 small boats (was false-neg)", ["small","boat","crossings","march"], "small boat arrivals accounted for 39,000 in the year to March 2026", true],
  ["£290m Rwanda (must hold)", ["direct","payments","rwandan","government","asylum","partnership","scheme"], "total spent with Rwanda to £290 million under the migration and economic development partnership", false],
  ["industry vs buildings term-poor (must fail)", ["industrial","sector","direct","ghg","emissions"], "buildings sector reached 21%, with some framings reaching 24% depending on scope", false],
];
for (const [label, terms, page, expect] of TABLE) {
  Deno.test(`table: ${label} -> ${expect ? "PASS" : "HOLD"}`, () => {
    assertEquals(subjectCoLocate(terms, page).pass, expect);
  });
}

// --- Adversarial subject-bleed (must hold on the wrong subject, pass on the right one) ------------------
Deno.test("adversarial: 8,164 enforced vs a VOLUNTARY page holds", () => {
  assertEquals(subjectCoLocate(["enforced","returns","immigration","offenders"], "voluntary returns totalled 25,186 in 2024").pass, false);
});
Deno.test("adversarial: 8,164 enforced vs an ENFORCED page passes", () => {
  assertEquals(subjectCoLocate(["enforced","returns","immigration","offenders"], "enforced returns of immigration offenders totalled 8,164 in 2024").pass, true);
});
Deno.test("adversarial: 813,000 immigration vs an EMIGRATION page holds", () => {
  assertEquals(subjectCoLocate(["long-run","immigration","uk","december"], "emigration was 642,000 in the year ending December 2025").pass, false);
});

// --- Full-gate on the real sweep corpus (located spans): 4 anchor, £290m holds ------------------------
const SWEEP: [string, string, string, string, boolean][] = [
  ["24% industry", "24%", "IPCC AR6 WG3 reports the industrial sector accounted for 24% of direct global GHG emissions in 2019; basic materials dominate at approximately 62% of direct industrial emissions.", "GHG emissions attributed to the industrial sector originate from fuel combustion, process emissions, product use and waste, which jointly accounted for 14.1 GtCO2-eq or 24% of all direct anthropogenic emissions in 2019", true],
  ["171,000 net migration", "171,000", "UK net migration for the year ending December 2025 was 171,000, according to ONS provisional estimates published 21 May 2026.", "At 171,000, long-term international net migration for year ending (YE) December 2025 has nearly halved from YE December 2024", true],
  ["£4.7bn asylum", "£4.7 billion", "UK Home Office spending on hotel-based asylum accommodation reached £4.7 billion in the year ending March 2024, of which £3.1 billion was hotel accommodation specifically.", "In the financial year to March 2024, the Home Office expects to spend £4.7 billion on asylum support, including £3.1 billion on hotels.", true],
  ["39,000 small boats", "39,000", "There were approximately 39,000 small boat crossings to the UK in the year to March 2026.", "small boat arrivals accounted for 39,000 (90%) of these", true],
  ["£290m Rwanda (genuine overstatement -> hold)", "£290 million", "Direct UK payments to the Rwandan government under the asylum partnership scheme totalled a minimum of £290 million.", "This brings the total spent with Rwanda to £290 million.", false],
];
for (const [label, figure, claim, quote, expectAnchor] of SWEEP) {
  Deno.test(`sweep: ${label} -> ${expectAnchor ? "anchored" : "held"}`, () => {
    const r = runCoLocationGate({ claimText: claim, pageContent: quote, anchorQuote: quote, claimFigure: figure, hasScreenshot: true });
    assertEquals(r.verificationState === "anchored", expectAnchor, r.reason);
  });
}

// --- The original incident must stay dead even with a rich-overlap buildings span ---------------------
Deno.test("stress: rich-overlap buildings span does NOT anchor the industry claim", () => {
  const r = runCoLocationGate({
    claimText: "IPCC AR6 WG3 reports the industrial sector accounted for 24% of direct global GHG emissions in 2019.",
    pageContent: "The buildings sector reached 24% of global GHG emissions depending on scope.",
    anchorQuote: "The buildings sector reached 24% of global GHG emissions depending on scope.",
    claimFigure: "24%", hasScreenshot: true,
  });
  assertEquals(r.verificationState, "cited_not_verified", r.reason);
});

// --- Fail-safe guards ----------------------------------------------------------------------------------
Deno.test("guard: quote not on the page -> cited_not_verified", () => {
  const r = runCoLocationGate({ claimText: "The industrial sector emitted 24%.", pageContent: "Something else.", anchorQuote: "The industrial sector emitted 24%", claimFigure: "24%", hasScreenshot: true });
  assertEquals(r.verificationState, "cited_not_verified", r.reason);
});
Deno.test("guard: figure absent from the quote -> cited_not_verified", () => {
  const r = runCoLocationGate({ claimText: "The industrial sector emitted 24%.", pageContent: "The industrial sector is a large emitter.", anchorQuote: "The industrial sector is a large emitter", claimFigure: "24%", hasScreenshot: true });
  assertEquals(r.verificationState, "cited_not_verified", r.reason);
});
Deno.test("guard: qualitative (no figure) -> screenshot_review", () => {
  const r = runCoLocationGate({ claimText: "The 1951 Convention prohibits refoulement.", pageContent: "No Contracting State shall expel or return a refugee.", anchorQuote: "No Contracting State shall expel or return a refugee", claimFigure: null, hasScreenshot: true });
  assertEquals(r.verificationState, "screenshot_review", r.reason);
});
