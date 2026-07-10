// pin_dossier_slice - WRITE-ON-PIN (Delphia enforcement lane, piece 5; baton cdb7693c / conf 75d90356).
// The pin is the FIRST durable write: before it, session content is ephemeral and no dossier_slice row
// exists. Pinning creates the row and freezes it atomically (Connie's freeze_dossier_slice finalizer),
// stamping the identity_key at pin - the consent gate.
//
// The Dossier and identity come from the SEALED grant's cargo, NEVER from the model. The model may name
// only what the slice IS (slice_kind, label). This is what keeps a pin from writing into another Dossier
// or under another person's identity. For a standing Prime (no sealed cargo) there is no consent identity,
// so the tool refuses.

import type { Tool, ToolContext } from "./types.ts";

function deny(msg: string): string {
  return `[SYSTEM: DENIED below the model - ${msg} The action did not run. Do not retry - this is the answer.]`;
}
function fail(msg: string): string {
  return `pin_dossier_slice error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const pinDossierSliceTool: Tool = {
  definition: {
    name: "pin_dossier_slice",
    description:
      "Pin (durably save) a slice of this interrogation into the Dossier. This is the FIRST durable write - nothing is saved until you pin, and the pin stamps the reader's identity as the consent gate. The Dossier and identity are fixed by your sealed grant; you name only the slice's kind and label. Returns the frozen slice. Unpinned content is dropped at session end.",
    input_schema: {
      type: "object",
      properties: {
        slice_kind: { type: "string", description: "What kind of slice (e.g. 'interrogation', 'answer'). Defaults to 'interrogation'." },
        label: { type: "string", description: "A short human label for the pinned slice." },
      },
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => `pin_dossier_slice: ${String((input as { label?: unknown })?.label ?? "").slice(0, 40)}`,

  run: async (input, ctx: ToolContext) => {
    const cargo = ctx.siblingGrant?.cargo as { identity_key?: unknown; dossier_instance_id?: unknown } | undefined;
    const identityKey = typeof cargo?.identity_key === "string" ? cargo.identity_key : "";
    const dossierInstanceId = typeof cargo?.dossier_instance_id === "string" ? cargo.dossier_instance_id : "";
    if (!identityKey || !dossierInstanceId) {
      return deny("pin_dossier_slice needs a sealed cargo (Dossier + consenting identity); this session carries none.");
    }

    const i = input as { slice_kind?: unknown; label?: unknown };
    const sliceKind = typeof i.slice_kind === "string" && i.slice_kind.trim() ? i.slice_kind.trim() : "interrogation";
    const label = typeof i.label === "string" && i.label.trim() ? i.label.trim() : null;

    try {
      // The Dossier's theo_session (dossier_slice.theo_session_id FKs to it) - resolved from the sealed
      // Dossier, not the model, so a pin cannot be aimed at a different session.
      const di = await ctx.supabase.from("dossier_instance").select("theo_session_id").eq("id", dossierInstanceId).maybeSingle();
      if (di.error) return fail(`dossier_instance lookup failed: ${di.error.message}`);
      const theoSessionId = (di.data as { theo_session_id?: string } | null)?.theo_session_id;
      if (!theoSessionId) return fail(`sealed dossier_instance ${dossierInstanceId} has no theo_session_id.`);

      const res = await ctx.supabase.rpc("pin_dossier_slice", {
        p_theo_session_id: theoSessionId,
        p_dossier_instance_id: dossierInstanceId,
        p_identity_key: identityKey,
        p_slice_kind: sliceKind,
        p_label: label,
        p_owner_lineage: ctx.lineageName || "delphia",
      });
      if (res.error) return fail(`pin (create+freeze) rejected: ${res.error.message}`);
      const row = (Array.isArray(res.data) ? res.data[0] : res.data) as { id?: string; frozen_at?: string } | null;
      if (!row?.id) return fail("pin returned no row id - treat as NOT persisted.");

      return JSON.stringify({
        ok: true,
        slice_id: row.id,
        frozen_at: row.frozen_at,
        scope: { dossier_instance_id: dossierInstanceId, identity_key: identityKey },
        "[SYSTEM]": `PINNED + FROZEN. Slice ${row.id} is now the first durable write for this content, stamped to the sealed identity. It is immutable; a re-pin would create a new slice. Anything you did NOT pin is dropped at session fold.`,
      });
    } catch (err) {
      return fail(`pin_dossier_slice call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
