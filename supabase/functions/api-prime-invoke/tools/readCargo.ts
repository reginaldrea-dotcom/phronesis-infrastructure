// read_cargo_slices - the scoped cargo read for a sealed Sibling (Delphia enforcement lane, piece 3;
// baton cdb7693c / conf 75d90356; Charge 3). This is the ONLY path a grant-scoped Sibling reads her
// Dossier cargo, and it is scoped TWICE over:
//
//   1. BELOW THE MODEL, in the EF: the scope is taken from the SEALED grant's cargo (dossier_instance_id
//      + identity_key), never from the model's input. If the model names a different Dossier or a
//      different person than its seal, the request is REFUSED here and never runs (the visible half of
//      the Denial Proof's cross-Dossier / cross-person refusals).
//   2. STRUCTURALLY, in Postgres: the read runs under the restricted `cargo_scope` role whose RLS policy
//      confines it to exactly the sealed (identity_key, dossier_instance_id). Even if (1) were bypassed,
//      another consumer's / another Dossier's rows return ZERO — physically unaddressable, not app-filtered.
//
// For a standing Prime (no sealed grant) this tool is inapplicable and refuses: cargo is a Sibling concept.

import type { Tool, ToolContext } from "./types.ts";
import { withCargoScope } from "../lib/cut2conn.ts";

function deny(msg: string): string {
  return `[SYSTEM: DENIED below the model - ${msg} The action did not run. Do not retry - this is the answer.]`;
}
function fail(msg: string): string {
  return `read_cargo_slices error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

interface SliceRow {
  id: string; slice_kind: string | null; label: string | null; owner_lineage: string | null;
  identity_key: string | null; dossier_instance_id: string | null;
  frozen_at: string | null; render_payload: unknown;
}

export const readCargoSlicesTool: Tool = {
  definition: {
    name: "read_cargo_slices",
    description:
      "Read the dossier_slice cargo you are scoped to. Your Dossier and person are fixed by your sealed grant; you cannot read another Dossier's or another person's cargo (the server refuses it below the model, and the database confines the read regardless). Optional filters only NARROW within your own scope. Returns the frozen slices visible to you.",
    input_schema: {
      type: "object",
      properties: {
        dossier_instance_id: { type: "string", description: "Optional. If given, must equal your sealed Dossier or the request is refused. Naming it is never required." },
        identity_key: { type: "string", description: "Optional. If given, must equal your sealed identity or the request is refused. Naming it is never required." },
        slice_kind: { type: "string", description: "Optional filter within your scope (e.g. 'interrogation')." },
        frozen_only: { type: "boolean", description: "Default true - only pinned/frozen slices. Unpinned session content is not durable." },
      },
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: () => "read_cargo_slices",

  run: async (input, ctx: ToolContext) => {
    const cargo = ctx.siblingGrant?.cargo as { identity_key?: unknown; dossier_instance_id?: unknown } | undefined;
    const sealedIdentity = typeof cargo?.identity_key === "string" ? cargo.identity_key : "";
    const sealedDossier = typeof cargo?.dossier_instance_id === "string" ? cargo.dossier_instance_id : "";

    // Standing Prime / unsealed session: cargo is a Sibling concept.
    if (!sealedIdentity || !sealedDossier) {
      return deny("read_cargo_slices is only for a grant-scoped Sibling; this session carries no sealed cargo scope.");
    }

    const i = input as { dossier_instance_id?: unknown; identity_key?: unknown; slice_kind?: unknown; frozen_only?: unknown };
    const askedDossier = typeof i.dossier_instance_id === "string" && i.dossier_instance_id.trim() ? i.dossier_instance_id.trim() : null;
    const askedIdentity = typeof i.identity_key === "string" && i.identity_key.trim() ? i.identity_key.trim() : null;

    // (1) The visible refusal: if the model tries to address outside its seal, refuse before running.
    if (askedDossier && askedDossier !== sealedDossier) {
      return deny(`your sealed cargo scopes you to Dossier ${sealedDossier}; you cannot read Dossier ${askedDossier} (cross-Dossier).`);
    }
    if (askedIdentity && askedIdentity !== sealedIdentity) {
      return deny(`your sealed cargo scopes you to identity ${sealedIdentity}; you cannot read identity ${askedIdentity} (cross-person).`);
    }

    const sliceKind = typeof i.slice_kind === "string" && i.slice_kind.trim() ? i.slice_kind.trim() : null;
    const frozenOnly = i.frozen_only !== false; // default true

    try {
      // (2) The structural guarantee: scope GUCs + cargo_scope role come from the SEALED grant. RLS returns
      // only the sealed (identity, Dossier) rows no matter what the query asks for.
      const rows = await withCargoScope({ identity_key: sealedIdentity, dossier_instance_id: sealedDossier }, async (tx: any) => {
        const clauses: string[] = [];
        const args: unknown[] = [];
        if (sliceKind) { args.push(sliceKind); clauses.push(`slice_kind = $${args.length}`); }
        if (frozenOnly) { clauses.push("frozen_at is not null"); }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const res = await tx.queryObject(
          `SELECT id, slice_kind, label, owner_lineage, identity_key, dossier_instance_id, frozen_at, render_payload
             FROM dossier_slice ${where} ORDER BY frozen_at DESC NULLS LAST, created_at DESC`,
          args,
        );
        return res.rows as SliceRow[];
      });

      return JSON.stringify({
        ok: true,
        scope: { dossier_instance_id: sealedDossier, identity_key: sealedIdentity },
        count: rows.length,
        slices: rows,
        "[SYSTEM]": `Read under cargo_scope: exactly the slices for your sealed Dossier + identity. ${rows.length} slice(s). Any other Dossier's or person's rows are structurally invisible to this session.`,
      });
    } catch (err) {
      return fail(`cargo read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
