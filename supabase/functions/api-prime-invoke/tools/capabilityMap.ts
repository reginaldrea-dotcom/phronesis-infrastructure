// capabilityMap — the Delphia capability->tool map, wired as the execution-layer gate (baton b28d6e36,
// Phase-1 map SP 67b43866; the enforcement half Heph owns). This is the reference data the central gate
// consults: which capability each privileged tool demands, and (for the sealed sibling) whether its permit
// carries it. It sits at the runTool chokepoint, BELOW THE MODEL.
//
// SAFETY MODEL (Napoleon/Aegis): a sealed sibling (Delphia) is DENY-BY-DEFAULT. It may touch only
//   (a) a tool mapped to a capability its sealed permit holds, or
//   (b) a harmless BASELINE harness tool (read-only self-context; no Dossier write, no exfil).
// Every other tool is refused below the model. So a half-built Delphia is STRUCTURALLY incapable of an
// unearned mode: free_write and assign_tier hold no tool and are in no permit, so any free-writing or
// tier-assigning tool (present or future) is refused — Aegis's explicit gate, not a by-absence posture.
//
// Standing Primes (no sealed grant) are UNAFFECTED — the gate is a no-op for them (ctx.siblingGrant null).

import type { ToolContext } from "./types.ts";
import { requireGrant } from "./types.ts";

// The capability vocabulary (permit elements), grounded in the real tool surface (SP 67b43866, verified 11 Jul).
export type Capability =
  | "read_grounded"        // read grounded facts / dispatch results / synthesis / cargo. Safe baseline read.
  | "verify_figure"        // the figure-verification gate (mechanical canonical_string match). Mode-1 core.
  | "capture_page"         // fetch-a-NAMED-page (declare_capture_target).
  | "commission_grounding" // walled write: real source + tier (write_ground_fact / _element_dependency / _claims).
  | "raw_web_dispatch"     // open multi-engine search (enqueue_dispatch). Gated since piece 1.
  | "project_slice"        // bounded grounded write (pin / fold a dossier_slice).
  | "read_user_document"   // [NEW, the intersect] user-upload ingest, private-cargo-scoped. Not built yet.
  | "trace_interrogation"  // the interrogate answer path: draft segments -> server-vetted grounding trace. Interrogate-only.
  | "assign_tier"          // manual tier override. NEVER in a Delphia permit (tiering is Theo's, via tier-map).
  | "free_write";          // ungrounded free write. NO tool exists; defined-but-never-granted (Aegis's gate).

// Never legitimately in ANY Delphia permit. Sealing a grant that carries one of these is a defect (see
// assertPermitClean). This is what makes the free_write / assign_tier deny EXPLICIT, not merely by-absence.
export const NEVER_GRANTED: ReadonlySet<Capability> = new Set(["assign_tier", "free_write"]);

// tool name -> the capability it demands. A privileged tool absent here is NOT ungated for a sealed sibling —
// it is deny-by-default (see enforceCapability). Only BASELINE_TOOLS are ungated.
export const TOOL_CAPABILITY: Readonly<Record<string, Capability>> = {
  // read_grounded — the safe baseline read set
  read_dispatch_results: "read_grounded",
  read_synthesis: "read_grounded",
  read_cargo_slices: "read_grounded",
  // verify_figure — Mode-1 core
  verify_figure: "verify_figure",
  // capture_page
  declare_capture_target: "capture_page",
  // commission_grounding — walled writes
  write_ground_fact: "commission_grounding",
  write_element_dependency: "commission_grounding",
  write_claims: "commission_grounding",
  write_figure: "commission_grounding",
  // raw_web_dispatch
  enqueue_dispatch: "raw_web_dispatch",
  // project_slice — bounded grounded write (the pin/fold lifecycle)
  pin_dossier_slice: "project_slice",
  fold_session: "project_slice",
  // trace_interrogation — the interrogate answer path (baton bac007e0). Wired here so it is DENY-BY-DEFAULT
  // for any sealed sibling whose permit lacks 'trace_interrogation' (e.g. a Mode-1 djinn — refused below the
  // model, auditable via execution_ledger.denied_capability), and OFFERED to an interrogate djinn whose
  // sealed permit holds it. Standing Primes (no sealed grant) are unaffected — the belt is a no-op for them.
  trace_interrogation: "trace_interrogation",
};

// Harness / self-context tools that carry no Dossier-capability and no exfil risk: read-only wake/inbox/self.
// A sealed sibling may use these regardless of permit. Deliberately MINIMAL (the narrowest posture); send_message
// (exfil), file_super_t (write), deliver_artefact, execute_sql, github, conferences are NOT here -> deny-by-default.
// FLAGGED to Napoleon/Angelia: confirm the Mode-1 Delphia needs no more than this; widening is a one-line add.
export const BASELINE_TOOLS: ReadonlySet<string> = new Set([
  "read_wake_deltas",
  "consume_wake_deltas",
  "read_inbox",
  "get_message",
  "read_super_t",
  "load_mst",
  "read_execution_ledger",
]);

// The canonical per-mode permits (the staged grant sequence = build order = safety model, SP 67b43866).
// The LIVE permit always comes from the sealed grant; this documents the intended sets and lets a spawner
// validate what it seals. Interrogate/project modes are later batons.
export const MODE_PERMITS: Readonly<Record<string, Capability[]>> = {
  mode1: ["read_grounded", "verify_figure"],
  mode2: ["read_grounded", "verify_figure", "capture_page", "commission_grounding"],
  mode3: ["read_grounded", "verify_figure", "capture_page", "commission_grounding", "raw_web_dispatch"],
  interrogate: ["read_grounded", "trace_interrogation"], // read-side + the sanctioned answer path (baton bac007e0).
  // Read-only content generation: NO capture / commission / project_slice / free-write (slice projection is a
  // deferred later mode, Reg's decision 1). trace_interrogation is the ONLY answer path — the djinn may not
  // answer EXCEPT through the server-vetted trace.
  project: ["read_grounded", "verify_figure", "project_slice", "read_user_document"],
};

// A permit is clean iff it names no NEVER_GRANTED capability. Used at grant load as a structural invariant:
// even a mis-sealed grant cannot smuggle free_write / assign_tier into a live permit.
export function assertPermitClean(permit: readonly string[]): { clean: boolean; offending: string[] } {
  const offending = permit.filter((c) => NEVER_GRANTED.has(c as Capability));
  return { clean: offending.length === 0, offending };
}

// A structured refusal (baton 7f71b2df). `message` is the denial string the caller returns verbatim to the
// model; `deniedCapability` is the machine-auditable reason recorded in execution_ledger.denied_capability —
// the missing CAPABILITY when the refusal is tied to one (e.g. 'raw_web_dispatch'), else the structural
// sentinel 'deny_by_default' (unmapped privileged tool). This is the point where the refusal is KNOWN, so it
// is the point where it is recorded — never parsed back out of the return prose (the anti-pattern we remove).
export interface CapabilityDenial {
  message: string;
  deniedCapability: string;
}

// THE CENTRAL GATE. Called at the runTool chokepoint for every tool dispatch. Returns a CapabilityDenial
// (whose .message the caller returns verbatim, so the action never runs and the model sees only the refusal,
// and whose .deniedCapability the ledger records) or null (allowed).
//
//  - No sealed grant (standing Prime): null. Ungated. Non-breaking.
//  - Sealed sibling:
//      * BASELINE tool -> allowed.
//      * mapped tool -> requireGrant on its capability (deny unless the sealed permit holds it; denied
//        capability = that capability).
//      * anything else (privileged/unmapped: execute_sql, deliver_artefact, github, conferences, a future
//        free_write/assign_tier tool, trace_interrogation before interrogate-mode wiring) -> DENY-BY-DEFAULT
//        (denied capability = the 'deny_by_default' sentinel — no single capability names the refusal).
export function enforceCapability(toolName: string, ctx: ToolContext): CapabilityDenial | null {
  if (!ctx.siblingGrant) return null; // standing Prime — ungated

  if (BASELINE_TOOLS.has(toolName)) return null;

  const cap = TOOL_CAPABILITY[toolName];
  if (cap) {
    const message = requireGrant(ctx, cap); // null if permitted, denial string otherwise
    return message ? { message, deniedCapability: cap } : null;
  }

  // Deny-by-default: a sealed sibling may not reach an unmapped privileged tool.
  return {
    message:
      `[SYSTEM: DENIED below the model — '${toolName}' is not part of this sealed sibling's permit and is `
      + `not a baseline harness tool. A grant-scoped sibling may only use the tools its mode's permit maps to. `
      + `The action did not run. Do not retry — this is the answer.]`,
    deniedCapability: "deny_by_default",
  };
}
