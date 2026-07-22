// dossier-integrity-pass - the INTEGRITY PASS (Heph, baton 66bd5a5b, Aegis spec 827cdc7e).
//
// Re-grounds EDITED PROSE against the CLAIMS it may rest on and FLAGS any sentence that asserts more than
// the grounded record supports. "Audit the output" applied to writing - the interrogate trace, one layer over.
//
// FLAG-ONLY (Aegis ruling 1, STANDING CONSTRAINT): the pass IDENTIFIES; a human DECIDES. There is no
// auto-correct mode and never will be without a separate Aegis ruling. This EF only ever WRITES integrity_flag
// rows + stamps synthesis_overlay.integrity_checked_at/integrity_flag_count/resolution_status. It never edits prose.
//
// UNIT OF CONCERN = THE EDITOR'S DELTA, NOT THE WHOLE PROSE. Aegis: "re-grounding POST-EDIT ... detect
// assert-boundary violations"; the escalation seed patterns and curation_required are all DIFF-based
// (soft->hard, claim-changed). The pre-existing prose was already vetted upstream (Theo's coherence pass +
// grounding), so a sentence the edit left unchanged or merely TRIMMED is NOT this pass's concern. The pass
// flags only sentences whose FACTUAL CONTENT the edit ADDED or ALTERED. (For draft-first generation, Component
// 3 later, the whole draft is the delta - the same logic applies with an empty "original".)
//
// TAXONOMY (Aegis ruling 3): reuse the interrogate-trace distinction, no parallel taxonomy.
//   - model_voice      -> editorial narration / framing / opinion. The "no problem" disposition; NOT written
//                         as a flag (so a clean editorial pass yields zero flags, per Napoleon's completion-check).
//   - ungrounded_claim -> a factual assertion the edit ADDED that no section claim supports. WRITTEN as a flag.
//       -> escalation (named sub-type, HIGHEST priority): the edit HARDENED soft source language AND the
//          hardening is NOT carried by a grounded claim. Detected TWO ways for defence in depth: the model
//          proposes it, AND the EF runs the seed pattern list on the original->edited diff below the model.
//          The grounding gate is the whole game: a legitimately hard, GROUNDED word (ISO/DIS 14060 genuinely
//          "prohibits"; the Verra finding genuinely stands) is NOT flagged, because a grounded section claim
//          carries that strength. That gate IS the attributed/rule-setting exemption.
//   - curation_required (HIGHEST SEVERITY, non-overridable, Aegis confirmation 1): the edit changed what a
//          CLAIM ASSERTS about a named entity/event/finding/position. Flagged regardless of grounding.
//
// FACTUAL-CHECK TRIGGER (Aegis ruling 3): a sentence gets the factual check if it has (a) a quantified
// assertion, (b) an attributed position, (c) a categorical statement about a named entity, or (d) a
// temporal/causal claim. Over-inclusion is the safer error. Opinion/inference/framing/judgment are exempt
// (model_voice) UNLESS a specific claim exists to check them against.
//
// LLM-neutral: the model does the LINGUISTIC work (atomise, classify, propose the resting claim + hardening);
// the safety-critical DECISIONS stay BELOW the model in this EF - ref-ids are validated against real section
// claims, the escalation seed patterns are matched deterministically on the diff, and the grounding gate is
// applied here, not trusted from the model's prose.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = "claude-opus-4-8";          // the safety keystone; a bounded run (one call per overlay)
const EDIT_KINDS = ["language", "operator_edit"];

// ESCALATION SEED PATTERNS (Aegis ruling 3) - EXPANDABLE. soft source phrasing -> hardened output phrasing.
// Matched case-insensitively on the original->edited diff. This list is the deterministic floor under the
// model's own escalation judgment; add patterns here as new escalation shapes are seen.
const ESCALATION_PATTERNS: Array<{ soft: RegExp; hard: RegExp; label: string }> = [
  { soft: /\bnot\s+endorse[ds]?\b/i,    hard: /\bprohibit(s|ed|ion)?\b/i,     label: "not endorsed -> prohibited" },
  { soft: /\bassociated with\b/i,       hard: /\bcauses?\b/i,                 label: "associated with -> causes" },
  { soft: /\bsome evidence suggests\b/i,hard: /\bevidence shows\b/i,          label: "some evidence suggests -> evidence shows" },
  { soft: /\bdisputed\b/i,              hard: /\bdisproven\b/i,               label: "disputed -> disproven" },
];

function env(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface Claim { id: string; claim_text: string; grounded: boolean }
interface ModelChange {
  sentence: string;
  sentence_index: number;
  change_kind: "added" | "altered";
  classification: "model_voice" | "factual";
  rests_on_claim_id: string | null;
  asserts_beyond: boolean;
  gap: string;
  hardening: boolean;
  hardening_pattern: string | null;
  assert_boundary_change: boolean;
}

// The tool the model MUST call. It reports the DELTA (edit-introduced factual changes) - not the whole prose -
// and does NOT decide the flag: this EF adjudicates below the model, from validated fields + deterministic gates.
const REPORT_TOOL = {
  name: "report_integrity",
  description: "Report ONLY the sentences whose FACTUAL CONTENT the edit ADDED or ALTERED relative to the original. "
    + "Ignore sentences that are unchanged, merely shortened, reordered, or reworded without changing what they "
    + "assert - they are not this pass's concern. You report the linguistic facts; the server adjudicates flags below you.",
  input_schema: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        description: "The edit-introduced factual changes only. Empty array if the edit changed no factual content (a clean pass).",
        items: {
          type: "object",
          properties: {
            sentence: { type: "string", description: "The edited sentence carrying the change, VERBATIM from the edited prose." },
            sentence_index: { type: "integer", description: "0-based position in the edited prose." },
            change_kind: { type: "string", enum: ["added", "altered"], description: "added = a factual assertion not present in the original; altered = an original assertion whose factual content the edit changed." },
            classification: {
              type: "string", enum: ["model_voice", "factual"],
              description: "model_voice = the change is editorial (framing/opinion/register/connective) with no factual "
                + "assertion. factual = the change adds or alters a quantified assertion, an attributed position, a "
                + "categorical statement about a named entity, or a temporal/causal claim. Over-include in factual.",
            },
            rests_on_claim_id: {
              type: ["string", "null"],
              description: "If factual: the id of the ONE provided section claim that supports the changed assertion, or "
                + "null if none does. Must be an id from the provided claims list.",
            },
            asserts_beyond: {
              type: "boolean",
              description: "If factual: true if the CHANGED assertion says more than its resting claim supports. CRITICAL: "
                + "if a provided claim genuinely carries the assertion - even a hard word like 'prohibits' or a rejection - "
                + "this is FALSE (grounded, not drift).",
            },
            gap: { type: "string", description: "If asserts_beyond or unsupported: the SPECIFIC gap the change introduces. Else empty." },
            hardening: {
              type: "boolean",
              description: "True if the edit HARDENED soft original language (softer source -> harder output). Removing an "
                + "intensifier (e.g. deleting 'Crucially') is NOT hardening; only a real strength increase counts.",
            },
            hardening_pattern: { type: ["string", "null"], description: "If hardening: the softer->harder shift, e.g. 'not endorsed -> prohibited'. Else null." },
            assert_boundary_change: {
              type: "boolean",
              description: "True if the edit changed WHAT A CLAIM ASSERTS about a named entity/event/finding/position "
                + "(the factual content, not register/length/order/phrasing). Highest-severity signal.",
            },
          },
          required: ["sentence", "sentence_index", "change_kind", "classification", "rests_on_claim_id", "asserts_beyond", "gap", "hardening", "hardening_pattern", "assert_boundary_change"],
        },
      },
    },
    required: ["changes"],
  },
};

function systemPrompt(): string {
  return [
    "You are the INTEGRITY PASS. Ghostwheel/the editor made a LANGUAGE/EDITORIAL edit to already-vetted prose. Your job is to re-ground the EDIT: find where the edit ADDED or ALTERED factual content beyond what the record supports.",
    "You are FLAG-ONLY: you never rewrite, correct, or soften. You report the delta via the tool; the server decides flags below you.",
    "SCOPE DISCIPLINE - this is the whole point: report ONLY sentences whose FACTUAL CONTENT the edit changed. A sentence that is unchanged, merely trimmed/shortened, reordered, or reworded without changing what it asserts is NOT reported. The pre-existing prose was already vetted; do not re-audit it. If the edit changed no factual content, return an empty changes array.",
    "Reuse ONE distinction: model_voice (editorial - framing/opinion/register/connective) vs factual (an assertion about the world). Over-include in factual when the change is borderline.",
    "The grounding rule that matters most: a changed assertion is GROUNDED (asserts_beyond=false) when one of the PROVIDED claims genuinely carries it - INCLUDING hard words. If a claim says an authority 'prohibits' X, then prose saying 'prohibited' is grounded, not escalation. Hardening/ungrounding only matters when NO provided claim supports the strength.",
    "Call report_integrity exactly once.",
  ].join("\n");
}

function userPrompt(claims: Claim[], original: string, edited: string): string {
  const claimLines = claims.length
    ? claims.map((c) => `- [${c.id}]${c.grounded ? " (GROUNDED)" : " (in-record, ungrounded)"}: ${c.claim_text}`).join("\n")
    : "(no claims in this section - so any factual assertion the edit ADDS is unsupported by the record)";
  return [
    "SECTION CLAIMS (the record the prose may rest on):",
    claimLines,
    "",
    "ORIGINAL prose (pre-edit - the baseline; compare against this to find what the edit changed):",
    original,
    "",
    "EDITED prose (post-edit - report only the factual changes the edit introduced relative to the original):",
    edited,
  ].join("\n");
}

// Deterministic escalation floor: did the edit introduce a seed soft->hard shift on this sentence?
function seedEscalation(original: string, sentence: string): string | null {
  for (const p of ESCALATION_PATTERNS) {
    // hard phrasing present in the edited sentence, soft phrasing present in the original (and the hard NOT in original)
    if (p.hard.test(sentence) && p.soft.test(original) && !p.hard.test(original)) return p.label;
  }
  return null;
}

async function callModel(system: string, user: string): Promise<ModelChange[]> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system,
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: "report_integrity" },
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const j = await resp.json();
  const block = (j.content ?? []).find((b: Record<string, unknown>) => b.type === "tool_use");
  if (!block) throw new Error("model returned no tool_use");
  const changes = (block.input as { changes?: ModelChange[] })?.changes;
  if (!Array.isArray(changes)) throw new Error("tool_use missing changes[]");
  return changes;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const overlayId = typeof body?.overlay_id === "string" ? body.overlay_id.trim() : "";
  const dossierId = typeof body?.dossier_instance_id === "string" ? body.dossier_instance_id.trim() : "";
  const force = body?.force === true;
  if (!UUID_RE.test(overlayId) && !UUID_RE.test(dossierId)) {
    return json({ error: "overlay_id or dossier_instance_id (a full UUID) is required" }, 400);
  }

  const supabase = createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));
  const passRunId = crypto.randomUUID();

  // Scope: one overlay, or all editable overlays of a dossier.
  let q = supabase.from("synthesis_overlay")
    .select("id, section_id, dossier_instance_id, overlay_kind, original_content_md, edited_content_md, integrity_checked_at")
    .in("overlay_kind", EDIT_KINDS).is("superseded_by", null);
  q = UUID_RE.test(overlayId) ? q.eq("id", overlayId) : q.eq("dossier_instance_id", dossierId);
  const ov = await q;
  if (ov.error) return json({ error: `overlay load: ${ov.error.message}` }, 500);
  const overlays = (ov.data ?? []).filter((o) => force || !o.integrity_checked_at);

  const results: Array<Record<string, unknown>> = [];
  for (const o of overlays) {
    try {
      // Section claims = the grounding scope for this overlay's prose.
      const cl = await supabase.from("synthesis_claim").select("id, claim_text").eq("section_id", o.section_id);
      if (cl.error) throw new Error(`claims: ${cl.error.message}`);
      const claimRows = (cl.data ?? []) as Array<{ id: string; claim_text: string }>;
      const claimIds = new Set(claimRows.map((c) => c.id));
      // grounded flag per claim
      const grounded = new Set<string>();
      if (claimRows.length) {
        const ed = await supabase.from("element_dependency")
          .select("dependent_synthesis_claim_id")
          .eq("edge_kind", "claim_on_fact").in("dependent_synthesis_claim_id", [...claimIds]);
        for (const e of (ed.data ?? []) as Array<{ dependent_synthesis_claim_id: string }>) grounded.add(e.dependent_synthesis_claim_id);
      }
      const claims: Claim[] = claimRows.map((c) => ({ id: c.id, claim_text: c.claim_text, grounded: grounded.has(c.id) }));

      const original = o.original_content_md ?? "";
      const edited = o.edited_content_md ?? "";
      const changes = await callModel(systemPrompt(), userPrompt(claims, original, edited));

      // Idempotent re-run: clear this overlay's prior flags before writing the new set.
      await supabase.from("integrity_flag").delete().eq("overlay_id", o.id);

      // BELOW-THE-MODEL ADJUDICATION. Decide each flag here, from validated facts + deterministic gates.
      const flags: Array<Record<string, unknown>> = [];
      let modelVoice = 0;
      for (const s of changes) {
        if (s.classification === "model_voice") { modelVoice++; continue; }  // editorial change: the "no problem" disposition, no flag row

        const restId = s.rests_on_claim_id && claimIds.has(s.rests_on_claim_id) ? s.rests_on_claim_id : null;
        const restGrounded = restId ? grounded.has(restId) : false;
        // Grounded support = rests on a real claim, the claim is grounded, and it does not assert beyond it.
        const supported = restId !== null && restGrounded && !s.asserts_beyond;

        // Grounded factual change: no flag. This is where a legitimately-hard, GROUNDED word passes untouched
        // (ISO/DIS 14060 genuinely prohibits; the Verra finding stands) - the attributed/rule-setting exemption.
        if (supported) continue;

        // (1) ESCALATION (highest-priority ungrounded sub-type): a soft->hard drift unsupported by a grounded
        //     claim - model hardening flag OR deterministic seed match. Checked BEFORE curation_required so a
        //     recognised hardening is classed as escalation, not absorbed into the substance-change bucket.
        const seed = seedEscalation(original, s.sentence);
        if (s.hardening || seed !== null) {
          flags.push(mkFlag(o, passRunId, s, "ungrounded_claim", true, seed ?? s.hardening_pattern ?? "model-identified hardening", restId, 10,
            s.gap || "The edit hardened softer source language beyond what any grounded claim supports."));
          continue;
        }
        // (2) ASSERT-BOUNDARY substance change (a changed figure, reversed position, swapped entity - NOT a
        //     linguistic hardening) -> curation_required (highest severity, non-overridable).
        if (s.assert_boundary_change) {
          flags.push(mkFlag(o, passRunId, s, "curation_required", false, null, restId, 1,
            s.gap || "The edit changes what a claim asserts about a named entity/event/finding/position."));
          continue;
        }
        // (3) plain ungrounded_claim.
        flags.push(mkFlag(o, passRunId, s, "ungrounded_claim", false, null, restId, 50,
          s.gap || "No grounded claim supports this assertion."));
      }

      // Write flags + stamp the overlay rollup (I own resolution_status per Connie's rule).
      if (flags.length) {
        const ins = await supabase.from("integrity_flag").insert(flags);
        if (ins.error) throw new Error(`flag insert: ${ins.error.message}`);
      }
      const hasCurationReq = flags.some((f) => f.flag_type === "curation_required");
      await supabase.from("synthesis_overlay").update({
        integrity_checked_at: new Date().toISOString(),
        integrity_flag_count: flags.length,
        resolution_status: hasCurationReq ? "curation_required" : null,
      }).eq("id", o.id);

      results.push({
        overlay_id: o.id, section_id: o.section_id,
        changes: changes.length, model_voice: modelVoice,
        flags_written: flags.length,
        escalation: flags.filter((f) => f.escalation).length,
        curation_required: flags.filter((f) => f.flag_type === "curation_required").length,
        ungrounded: flags.filter((f) => f.flag_type === "ungrounded_claim").length,
      });
    } catch (e) {
      results.push({ overlay_id: o.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Share-gate rollup for the dossier (Aegis ruling 2).
  const dId = UUID_RE.test(dossierId) ? dossierId : (overlays[0]?.dossier_instance_id ?? null);
  let gate: unknown = null;
  if (dId) {
    const g = await supabase.rpc("dossier_integrity_gate", { p_dossier_instance_id: dId });
    gate = g.error ? { error: g.error.message } : (Array.isArray(g.data) ? g.data[0] : g.data);
  }

  return json({ ok: true, pass_run_id: passRunId, overlays_checked: results.length, results, gate }, 200);
});

// deno-lint-ignore no-explicit-any
function mkFlag(o: any, passRunId: string, s: ModelChange, flagType: string, escalation: boolean,
  pattern: string | null, restId: string | null, priority: number, gap: string): Record<string, unknown> {
  return {
    overlay_id: o.id,
    dossier_instance_id: o.dossier_instance_id,
    section_id: o.section_id,
    sentence: s.sentence,
    sentence_index: s.sentence_index,
    flag_type: flagType,
    escalation,
    escalation_pattern: pattern,
    rests_on_claim_ids: restId ? [restId] : null,
    gap,
    priority,
    pass_run_id: passRunId,
  };
}
