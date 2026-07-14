// Acceptance test for the co-location gate. Eames pinned it (5e1f603e): the 4 clause-separation cases
// must separate correctly AND industry/buildings must still FAIL. Run: deno test coLocationGate.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clauseContaining, extractSubjectTerms, runCoLocationGate } from "./coLocationGate.ts";

// --- The two real two-figure sweep claims (subject bleed hazard) ---------------------------------------
const RETURNS = "In 2024, enforced returns of immigration offenders totalled 8,164 and voluntary returns totalled 25,186.";
const MIGRATION = "For the year ending December 2025, long-run immigration to the UK was 813,000 and emigration was 642,000 (ONS, same release).";

function termsFor(claim: string, figure: string): string[] {
  return extractSubjectTerms(clauseContaining(claim, figure));
}

Deno.test("clause-scoping separates 8,164 (enforced) from 25,186 (voluntary)", () => {
  const t8164 = termsFor(RETURNS, "8,164");
  const t25186 = termsFor(RETURNS, "25,186");
  assert(t8164.includes("enforced"), `8,164 terms should include 'enforced': ${t8164}`);
  assert(t8164.includes("offenders"), `8,164 terms should include 'offenders': ${t8164}`);
  assert(!t8164.includes("voluntary"), `8,164 terms must NOT bleed 'voluntary': ${t8164}`);
  assert(t25186.includes("voluntary"), `25,186 terms should include 'voluntary': ${t25186}`);
  assert(!t25186.includes("enforced"), `25,186 terms must NOT bleed 'enforced': ${t25186}`);
});

Deno.test("clause-scoping separates 813,000 (immigration) from 642,000 (emigration)", () => {
  const t813 = termsFor(MIGRATION, "813,000");
  const t642 = termsFor(MIGRATION, "642,000");
  assert(t813.includes("immigration"), `813,000 terms should include 'immigration': ${t813}`);
  assert(t813.includes("december"), `813,000 terms should include 'december': ${t813}`);
  assert(!t813.includes("emigration"), `813,000 terms must NOT bleed 'emigration': ${t813}`);
  assert(t642.includes("emigration"), `642,000 terms should include 'emigration': ${t642}`);
  assert(!t642.includes("immigration"), `642,000 terms must NOT bleed 'immigration': ${t642}`);
});

// --- industry/buildings: the original incident MUST fail ------------------------------------------------
const INDUSTRY_CLAIM =
  "IPCC AR6 WG3 reports the industrial sector accounted for 24% of direct global GHG emissions in 2019; " +
  "basic materials (iron and steel, cement, chemicals, non-ferrous metals) dominate at approximately 62% of direct industrial emissions.";

Deno.test("industry claim ANCHORS against a genuine industry span", () => {
  const page = "Chapter 11 (Industry). The industrial sector accounted for 24% of direct global GHG emissions in 2019, rising to 34% with indirect emissions.";
  const quote = "The industrial sector accounted for 24% of direct global GHG emissions in 2019";
  const r = runCoLocationGate({ claimText: INDUSTRY_CLAIM, pageContent: page, anchorQuote: quote, claimFigure: "24%", hasScreenshot: true });
  assertEquals(r.verificationState, "anchored", r.reason);
});

Deno.test("industry claim FAILS against a buildings span even though generic terms (sector/global/ghg/emissions) match", () => {
  // The confabulated framing: a span that DOES carry 24% but attributes it to buildings. 4 of 6 generic
  // terms match, but the head noun 'industrial' is absent -> must not anchor.
  const page = "Chapter 9 (Buildings). The buildings sector reached 24% of global GHG emissions depending on scope.";
  const quote = "The buildings sector reached 24% of global GHG emissions depending on scope";
  const r = runCoLocationGate({ claimText: INDUSTRY_CLAIM, pageContent: page, anchorQuote: quote, claimFigure: "24%", hasScreenshot: true });
  assertEquals(r.verificationState, "cited_not_verified", `expected fail, got: ${r.reason}`);
});

// --- fail-safe guards -----------------------------------------------------------------------------------
Deno.test("quote not on the page -> cited_not_verified", () => {
  const r = runCoLocationGate({
    claimText: INDUSTRY_CLAIM, pageContent: "Something entirely different.",
    anchorQuote: "The industrial sector accounted for 24%", claimFigure: "24%", hasScreenshot: true,
  });
  assertEquals(r.verificationState, "cited_not_verified", r.reason);
});

Deno.test("figure absent from the quote -> cited_not_verified", () => {
  const page = "The industrial sector is a large emitter of greenhouse gases worldwide.";
  const r = runCoLocationGate({
    claimText: INDUSTRY_CLAIM, pageContent: page,
    anchorQuote: "The industrial sector is a large emitter of greenhouse gases worldwide", claimFigure: "24%", hasScreenshot: true,
  });
  assertEquals(r.verificationState, "cited_not_verified", r.reason);
});

Deno.test("qualitative edge (no figure) -> screenshot_review", () => {
  const r = runCoLocationGate({
    claimText: "The 1951 Convention prohibits refoulement.", pageContent: "No Contracting State shall expel or return a refugee.",
    anchorQuote: "No Contracting State shall expel or return a refugee", claimFigure: null, hasScreenshot: true,
  });
  assertEquals(r.verificationState, "screenshot_review", r.reason);
});
