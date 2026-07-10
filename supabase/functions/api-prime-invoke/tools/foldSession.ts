// fold_session - THE FOLD (Delphia enforcement lane, piece 5; baton cdb7693c / conf 75d90356). When an
// interrogation session ends, unpinned content must not persist. This hard-drops every dossier_slice for
// the sealed Dossier's session that was left unfrozen (created but never pinned). Pinned/frozen snapshots
// are immutable and untouched.
//
// The session is resolved from the SEALED Dossier, never the model - a fold cannot be aimed at another
// Dossier's session. For a standing Prime (no sealed cargo) there is nothing to fold; the tool refuses.

import type { Tool, ToolContext } from "./types.ts";

function deny(msg: string): string {
  return `[SYSTEM: DENIED below the model - ${msg} The action did not run. Do not retry - this is the answer.]`;
}
function fail(msg: string): string {
  return `fold_session error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const foldSessionTool: Tool = {
  definition: {
    name: "fold_session",
    description:
      "Close this interrogation: hard-drop everything you did not pin. Any slice created but not pinned/frozen for your Dossier's session is permanently removed; pinned slices are immutable and kept. Your Dossier is fixed by your sealed grant. Returns the number of unpinned slices dropped.",
    input_schema: { type: "object", properties: {} },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: () => "fold_session",

  run: async (_input, ctx: ToolContext) => {
    const cargo = ctx.siblingGrant?.cargo as { dossier_instance_id?: unknown } | undefined;
    const dossierInstanceId = typeof cargo?.dossier_instance_id === "string" ? cargo.dossier_instance_id : "";
    if (!dossierInstanceId) {
      return deny("fold_session needs a sealed cargo (Dossier); this session carries none.");
    }

    try {
      const di = await ctx.supabase.from("dossier_instance").select("theo_session_id").eq("id", dossierInstanceId).maybeSingle();
      if (di.error) return fail(`dossier_instance lookup failed: ${di.error.message}`);
      const theoSessionId = (di.data as { theo_session_id?: string } | null)?.theo_session_id;
      if (!theoSessionId) return fail(`sealed dossier_instance ${dossierInstanceId} has no theo_session_id.`);

      const res = await ctx.supabase.rpc("fold_session_slices", { p_theo_session_id: theoSessionId });
      if (res.error) return fail(`fold rejected: ${res.error.message}`);
      const dropped = typeof res.data === "number" ? res.data : (Array.isArray(res.data) ? res.data[0] : res.data);

      return JSON.stringify({
        ok: true,
        dropped: dropped ?? 0,
        "[SYSTEM]": `FOLDED. ${dropped ?? 0} unpinned slice(s) hard-dropped for this Dossier's session. Pinned snapshots remain. Unpinned session content does not persist.`,
      });
    } catch (err) {
      return fail(`fold_session call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
