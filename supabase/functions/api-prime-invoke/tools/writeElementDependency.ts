// write_element_dependency — the element-store edge-writer (Eames ruling a2310ece). Links a DEPENDENT node
// to a DEPENDS_ON node in the one unified dependency graph. Thin wrapper over Connie's write contract
// public.write_element_dependency() (SECURITY DEFINER; DB CHECKs enforce exactly-one-dependent /
// exactly-one-depends_on + edge_kind). Connie's signature takes explicit nullable columns; this tool
// exposes a friendlier dependent_type/depends_on_type + id interface and maps to the right column, so the
// calling Prime never juggles the five/two nullable pairs.
//
// Main use: at grounding, Angelia links a synthesis_claim to the ground_fact(s) that support it
// (edge_kind 'claim_on_fact'), from Theo's per-claim instructions. Edge-writing is SEPARATE from fact
// minting because facts are reusable — a claim resting on an already-existing fact links to it here with
// no new mint (do not fold this into write_ground_fact). This is what lights up the dossier's
// descend-to-evidence (claim -> fact -> frozen capture) and its tier-gated render states.

import type { Tool, ToolContext } from "./types.ts";

const DEPENDENT_COL: Record<string, string> = {
  synthesis_claim: "p_dependent_synthesis_claim_id",
  dossier_slice:   "p_dependent_dossier_slice_id",
  claim_figure:    "p_dependent_claim_figure_id",
  ground_fact:     "p_dependent_ground_fact_id",
  report_snapshot: "p_dependent_snapshot_id",
};
const DEPENDS_ON_COL: Record<string, string> = {
  ground_fact:  "p_depends_on_ground_fact_id",
  claim_figure: "p_depends_on_claim_figure_id",
};

function fail(msg: string): string {
  return `write_element_dependency error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const writeElementDependencyTool: Tool = {
  definition: {
    name: "write_element_dependency",
    description:
      "Link one element-store node to another — the general edge-writer for the unified dependency graph. Records that a DEPENDENT node rests on a DEPENDS_ON node. Primary use: at grounding, link a synthesis_claim to the ground_fact(s) that support it (edge_kind 'claim_on_fact'), from Theo's per-claim instructions — this is what makes the dossier descend claim -> fact -> frozen capture and compute tier-gated states. Facts are REUSABLE: to rest a claim on an already-existing fact, link to it with this same tool (no new fact is minted; do not re-run write_ground_fact). REQUIRED: edge_kind; dependent_type + dependent_id; depends_on_type + depends_on_id. Returns the created edge (its id is the persisted confirmation).",
    input_schema: {
      type: "object",
      properties: {
        edge_kind: {
          type: "string",
          enum: ["claim_on_fact", "slice_on_fact", "assumption_on_fact", "analysis_on_assumption"],
          description: "Edge type. claim_on_fact = a synthesis_claim rests on a fact/figure; slice_on_fact = a dossier_slice rests on a fact.",
        },
        dependent_type: {
          type: "string",
          enum: ["synthesis_claim", "dossier_slice", "claim_figure", "ground_fact", "report_snapshot"],
          description: "Kind of the node that DEPENDS (e.g. synthesis_claim for a claim_on_fact edge).",
        },
        dependent_id:   { type: "string", description: "Id of the dependent node." },
        depends_on_type: {
          type: "string",
          enum: ["ground_fact", "claim_figure"],
          description: "Kind of the node depended upon (the evidence): ground_fact (qualitative) or claim_figure (quantitative).",
        },
        depends_on_id:  { type: "string", description: "Id of the depended-on node (the supporting fact/figure)." },
      },
      required: ["edge_kind", "dependent_type", "dependent_id", "depends_on_type", "depends_on_id"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const i = input as { edge_kind?: unknown; dependent_type?: unknown; depends_on_type?: unknown };
    return `write_element_dependency: ${String(i?.dependent_type ?? "")} --${String(i?.edge_kind ?? "")}--> ${String(i?.depends_on_type ?? "")}`;
  },

  run: async (input, ctx: ToolContext) => {
    const i = input as Record<string, unknown>;
    const s = (k: string) => (typeof i?.[k] === "string" && (i[k] as string).trim() ? (i[k] as string).trim() : null);

    const edge = s("edge_kind"), depType = s("dependent_type"), depId = s("dependent_id"),
      onType = s("depends_on_type"), onId = s("depends_on_id");
    if (!edge) return fail("edge_kind is required (claim_on_fact / slice_on_fact / assumption_on_fact / analysis_on_assumption).");
    if (!depType || !DEPENDENT_COL[depType]) return fail("dependent_type must be one of synthesis_claim / dossier_slice / claim_figure / ground_fact / report_snapshot.");
    if (!depId) return fail("dependent_id is required.");
    if (!onType || !DEPENDS_ON_COL[onType]) return fail("depends_on_type must be ground_fact or claim_figure.");
    if (!onId) return fail("depends_on_id is required.");

    const args: Record<string, unknown> = { p_edge_kind: edge, p_created_by_lineage: ctx.lineageName || "angelia" };
    args[DEPENDENT_COL[depType]] = depId;
    args[DEPENDS_ON_COL[onType]] = onId;

    try {
      const res = await ctx.supabase.rpc("write_element_dependency", args);
      if (res.error) return fail(`write contract rejected: ${res.error.message}`);
      const row = (Array.isArray(res.data) ? res.data[0] : res.data) as { id?: string } | null;
      if (!row?.id) return fail("write returned no row id — treat as NOT persisted.");
      return JSON.stringify({
        ok: true,
        edge_id: row.id,
        edge: `${depType}:${depId} --${edge}--> ${onType}:${onId}`,
        "[SYSTEM]": `PERSISTED + CONFIRMED. Edge ${row.id} written. The ${depType} now descends to this ${onType} and inherits its tier/freshness; the dossier will surface it in descend-to-evidence and compute the claim's tier-gated state. A rejected write returns an error, not an id.`,
      });
    } catch (err) {
      return fail(`write_element_dependency call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
