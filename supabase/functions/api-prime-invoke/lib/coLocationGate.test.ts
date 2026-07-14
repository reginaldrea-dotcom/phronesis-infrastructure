// Acceptance test for the co-location gate, subject-term rule v2 (Eames 29bc91a0, ported from his tested
// subject_term_gate.py + the temporal fix he specified + a provenance clause-split for real-corpus claims).
// Run: deno test --no-check coLocationGate.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { subjectCoLocate, runCoLocationGate } from "./coLocationGate.ts";

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
