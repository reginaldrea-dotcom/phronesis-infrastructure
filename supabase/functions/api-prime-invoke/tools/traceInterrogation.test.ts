// Acceptance test for the interrogate trace RESOLVER (baton bac007e0; ruling 6a0cd457; Eames SP 2ca58f83).
// Proves the SERVER's adjudication on the two hard criteria: (1) the BLENDED SENTENCE separates — a figure
// span is KEPT + tiered while the inference it suggests is WITHHELD as narration; (2) a CLEAN ATTRIBUTION —
// a contested/political claim SURVIVES as a tiered attribution, not as the house asserting it.
// The graph is mocked so the adjudication logic is tested in isolation; the LIVE run over the betterworld
// instance is the companion proof (first live run, per the baton).
// Run: deno test --no-check traceInterrogation.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { traceInterrogationTool } from "./traceInterrogation.ts";
import type { ToolContext } from "./types.ts";

const FIG_FACT = "11111111-1111-1111-1111-111111111111"; // a ground_fact the figure span resolves to
const CONTESTED_CLAIM = "22222222-2222-2222-2222-222222222222"; // a contested synthesis_claim, grounded T2

// Mock the graph the resolver walks. Routes by the table each query names.
function mockCtx(canned: { claims?: unknown[]; facts?: unknown[]; figures?: unknown[] }): ToolContext {
  const supabase = {
    rpc: (_name: string, args: { query: string }) => {
      const q = args.query;
      if (q.includes("FROM synthesis_claim")) return Promise.resolve({ data: canned.claims ?? [], error: null });
      if (q.includes("FROM ground_fact")) return Promise.resolve({ data: canned.facts ?? [], error: null });
      if (q.includes("FROM claim_figure")) return Promise.resolve({ data: canned.figures ?? [], error: null });
      return Promise.resolve({ data: [], error: null });
    },
  } as unknown as ToolContext["supabase"];
  return { supabase, directArtefacts: [], lineageName: "delphia_interrogate_proof" };
}

async function runTrace(ctx: ToolContext, segments: unknown[]) {
  const out = await traceInterrogationTool.run(
    { question: "Did the policy work?", dossier_id: "be770000-2222-0000-0000-000000000001", segments },
    ctx,
  );
  return JSON.parse(out);
}

// ── (1) THE BLENDED SENTENCE — Eames's hard criterion: separate, never fused ────────────────────────────
Deno.test("blended sentence: figure span KEPT + tiered, inference span WITHHELD — separated", async () => {
  const ctx = mockCtx({ facts: [{ id: FIG_FACT, authority_tier: "T1", source_url: "https://ons.gov.uk/x" }] });
  const res = await runTrace(ctx, [
    { text: "Net migration fell to 171,000.", grounding: "ground_fact", ref_id: FIG_FACT },
    { text: "which shows the policy worked", grounding: "model_voice" },
  ]);
  assertEquals(res.kept, 1, "the figure span is kept");
  assertEquals(res.withheld, 1, "the inference span is withheld");
  // Two DISTINCT, SEPARABLE spans — never one fused unit.
  assertEquals(res.vetted_answer.length, 2);
  // Span 0: the sourced figure — stampable, carries its tier.
  assertEquals(res.vetted_answer[0].withheld, undefined);
  assertEquals(res.vetted_answer[0].tier, "T1");
  assertEquals(res.vetted_answer[0].text, "Net migration fell to 171,000.");
  // Span 1: the model's leap — withheld, rendered as a gap-note (narration), reason = model_voice.
  assertEquals(res.vetted_answer[1].withheld, true);
  assertEquals(res.vetted_answer[1].reason, "model_voice");
});

// ── (2) THE CLEAN ATTRIBUTION — a contested claim survives AS a tiered attribution ──────────────────────
Deno.test("clean attribution: a contested political claim survives as a tiered attribution", async () => {
  const ctx = mockCtx({
    claims: [{
      claim_id: CONTESTED_CLAIM, claim_text: "AESSEAL achieved net zero for Scope 1 & 2.",
      assertion_contestability: "contested", claim_role: "subject_assertion",
      gf_id: FIG_FACT, gf_tier: "T2", gf_source: "https://x", cf_id: null, cf_tier: null,
    }],
  });
  const res = await runTrace(ctx, [
    { text: "AESSEAL states it achieved net zero for Scope 1 and 2.", grounding: "synthesis_claim",
      ref_id: CONTESTED_CLAIM, as_attribution: true, attributed_to: "AESSEAL" },
  ]);
  assertEquals(res.kept, 1);
  assertEquals(res.withheld, 0);
  const span = res.vetted_answer[0];
  assertEquals(span.withheld, undefined, "an attributed contested claim is KEPT, not withheld");
  assertEquals(span.framing, "attribution", "kept AS an attribution, not as the house asserting it");
  assertEquals(span.attributed_to, "AESSEAL");
  assertEquals(span.tier, "T2", "tiered as what actually grounds it (the attribution)");
  const led = res.ledger[0];
  assertEquals(led.reason, "grounded_attribution");
});

// ── Fail-safe: an uncited factual claim in the model's own voice is WITHHELD (absence-of-SOURCE) ─────────
Deno.test("fail-safe: a bare model-voice factual claim is withheld, not smuggled through", async () => {
  const res = await runTrace(mockCtx({}), [
    { text: "The policy was the decisive factor.", grounding: "model_voice" },
  ]);
  assertEquals(res.kept, 0);
  assertEquals(res.vetted_answer[0].withheld, true);
  assertEquals(res.ledger[0].reason, "model_voice");
});

// ── Regression (baton bac007e0, first live run): a NON-ARRAY graph response degrades to withholding, ────
// never crashes the interrogation. The live bug was execute_raw_sql misclassifying a newline-led SELECT as
// a write and returning {rows_affected} (non-iterable); the Array.isArray guard fails safe.
Deno.test("regression: a non-array graph response withholds (does not throw)", async () => {
  const ctx = {
    supabase: {
      rpc: (_n: string, _a: unknown) => Promise.resolve({ data: { rows_affected: 1 }, error: null }),
    } as unknown as ToolContext["supabase"],
    directArtefacts: [], lineageName: "delphia_interrogate_proof",
  } as ToolContext;
  const res = await runTrace(ctx, [
    { text: "A claim that should resolve.", grounding: "synthesis_claim", ref_id: CONTESTED_CLAIM },
  ]);
  assert(res.ok, "must not error out — the gate degrades to withholding");
  assertEquals(res.kept, 0);
  assertEquals(res.ledger[0].reason, "unresolved_ref");
});

// ── Fail-safe: a citation that does not resolve cannot be dressed as grounded ────────────────────────────
Deno.test("fail-safe: an unresolved citation is withheld", async () => {
  // The graph returns no row for the cited claim -> unresolved -> withheld.
  const res = await runTrace(mockCtx({ claims: [] }), [
    { text: "A grounded-looking claim.", grounding: "synthesis_claim", ref_id: CONTESTED_CLAIM },
  ]);
  assertEquals(res.kept, 0);
  assertEquals(res.ledger[0].reason, "unresolved_ref");
});
