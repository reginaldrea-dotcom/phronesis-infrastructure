// Acceptance test for ledger denial instrumentation (baton 7f71b2df). Proves the REAL belt + chokepoint +
// digest produce the machine-auditable denial vocabulary the ledger records — so a refusal is a ROW, not a
// prose self-report. Exercises the actual production functions (no re-implementation).
// Run: deno test --no-check denialInstrumentation.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enforceCapability } from "./capabilityMap.ts";
import { runTool } from "./index.ts";
import { digestToolCall } from "../lib/provenance.ts";
import type { ToolContext } from "./types.ts";

// A Mode-1 sealed sibling (the djinn in the completion-check): permit = {read_grounded, verify_figure}.
// supabase is never touched on a DENIED path (the tool's run() is never reached), so a stub is safe.
const mode1 = (): ToolContext => ({
  supabase: {} as unknown as ToolContext["supabase"],
  directArtefacts: [],
  lineageName: "delphia_mode1_proof",
  siblingGrant: { permit: ["read_grounded", "verify_figure"], cargo: {} },
});

// A standing Prime — no sealed grant. The belt is a no-op (unrestricted, non-breaking).
const standing = (): ToolContext => ({
  supabase: {} as unknown as ToolContext["supabase"],
  directArtefacts: [],
  lineageName: "angelia",
  siblingGrant: null,
});

// An interrogate djinn (baton bac007e0): permit = {read_grounded, trace_interrogation}. Read-side + the
// sanctioned answer path only — no capture, commission, project_slice, or free-write.
const interrogate = (): ToolContext => ({
  supabase: {} as unknown as ToolContext["supabase"],
  directArtefacts: [],
  lineageName: "delphia_interrogate_proof",
  siblingGrant: { permit: ["read_grounded", "trace_interrogation"], cargo: {} },
});

// ── The belt names the missing capability structurally (not parsed from prose) ─────────────────────────
Deno.test("belt: Mode-1 djinn attempting enqueue_dispatch is denied with capability 'raw_web_dispatch'", () => {
  const d = enforceCapability("enqueue_dispatch", mode1());
  assert(d, "enqueue_dispatch must be refused for a Mode-1 permit");
  assertEquals(d!.deniedCapability, "raw_web_dispatch");
  assert(d!.message.includes("DENIED below the model"), "message is the verbatim refusal the model sees");
});

Deno.test("belt: a permitted read (read_synthesis -> read_grounded) is NOT a denial", () => {
  assertEquals(enforceCapability("read_synthesis", mode1()), null);
});

Deno.test("belt: an unmapped privileged tool (execute_sql) denies by default", () => {
  const d = enforceCapability("execute_sql", mode1());
  assert(d, "execute_sql is unmapped + privileged -> deny-by-default");
  assertEquals(d!.deniedCapability, "deny_by_default");
});

Deno.test("belt: a baseline harness tool (read_inbox) is allowed even for a sealed sibling", () => {
  assertEquals(enforceCapability("read_inbox", mode1()), null);
});

Deno.test("belt: a standing Prime is ungated (enqueue_dispatch permitted)", () => {
  assertEquals(enforceCapability("enqueue_dispatch", standing()), null);
});

// ── Interrogate permit-wiring (baton bac007e0): trace_interrogation gated under the interrogate permit ──
Deno.test("belt: a Mode-1 djinn calling trace_interrogation is denied with capability 'trace_interrogation'", () => {
  const d = enforceCapability("trace_interrogation", mode1());
  assert(d, "trace_interrogation must be refused for a Mode-1 permit (it holds no such capability)");
  assertEquals(d!.deniedCapability, "trace_interrogation");
});

Deno.test("belt: an interrogate djinn calling trace_interrogation is PERMITTED", () => {
  assertEquals(enforceCapability("trace_interrogation", interrogate()), null);
});

Deno.test("belt: an interrogate djinn is read-side only — enqueue_dispatch still denied (raw_web_dispatch)", () => {
  const d = enforceCapability("enqueue_dispatch", interrogate());
  assert(d, "interrogate permit is read-side + trace only; raw_web_dispatch is not in it");
  assertEquals(d!.deniedCapability, "raw_web_dispatch");
});

Deno.test("belt: an interrogate djinn may read (read_synthesis -> read_grounded) but not commission", () => {
  assertEquals(enforceCapability("read_synthesis", interrogate()), null);
  assertEquals(enforceCapability("write_ground_fact", interrogate())!.deniedCapability, "commission_grounding");
});

// ── The chokepoint surfaces the denial WITHOUT running the tool ─────────────────────────────────────────
Deno.test("runTool: denied enqueue_dispatch returns the refusal + deniedCapability, never runs the tool", async () => {
  const r = await runTool("enqueue_dispatch", { query: "anything" }, mode1());
  assertEquals(r.deniedCapability, "raw_web_dispatch");
  assert(r.content.includes("DENIED below the model"), "the model sees only the refusal");
});

// ── The completion-check: given the ledger row's fields, a refusal is distinguishable from a success ─────
Deno.test("ledger row: a refusal is machine-distinguishable from a success", async () => {
  const r = await runTool("enqueue_dispatch", { query: "x" }, mode1());
  // What the loop writes to execution_ledger for this call:
  const row = {
    tool: "enqueue_dispatch",
    outcome: digestToolCall("enqueue_dispatch", { query: "x" }, r.content).outcome,
    denied_capability: r.deniedCapability,
  };
  // The predicate a Denial Proof / the interrogate integrity test uses — no payload reading:
  assert(row.denied_capability !== null, "refused = denied_capability IS NOT NULL");
  assertEquals(row.denied_capability, "raw_web_dispatch");
  // And the human/model-facing outcome text no longer reads like an opaque success payload ("→ 251 chars").
  assertEquals(row.outcome, "→ denied below the model");
});

// ── The outcome text stays honest across the denial shapes; a real success still records as before ──────
Deno.test("outcome text: loop deny-by-default reads as denied, not '→ N chars'", () => {
  const msg = enforceCapability("execute_sql", mode1())!.message;
  assertEquals(digestToolCall("execute_sql", {}, msg).outcome, "→ denied below the model");
});

Deno.test("outcome text: B1 script denial string reads as denied", () => {
  assertEquals(
    digestToolCall("some_tool", {}, "denied: lineage 'x' lacks script scope sql:read").outcome,
    "→ denied: lineage 'x' lacks script scope sql:read",
  );
});

Deno.test("outcome text: a genuine success payload is unaffected (regression guard)", () => {
  const success = JSON.stringify({ theo_session_id: "abc", state: "queued" });
  const out = digestToolCall("enqueue_dispatch", {}, success).outcome;
  assert(out.startsWith("→ 1 row"), `a real success must NOT read as denied: ${out}`);
});
