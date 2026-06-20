// MST-delivery M1 ledger writer (conf d36d9609, MR ac84a3d9; baton 3305e3d0, component 4).
//
// Best-effort emit into mst_delivery_event. A metrics write must NEVER break the tool that emits it,
// so every failure is logged and swallowed. See migration 20260620_mst_delivery_ledger.sql for the
// schema and the M1 view that consumes these rows.

import type { ToolContext } from "../tools/types.ts";

export type MstEventKind = "juncture_reached" | "mst_pulled";
export type MstEventSource = "load_mst" | "marker" | "tool" | "artifact";

export async function logMstEvent(
  ctx: ToolContext,
  ev: {
    kind: MstEventKind;
    source: MstEventSource;
    juncture?: string | null;
    mst_id?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const res = await ctx.supabase.from("mst_delivery_event").insert({
      lineage: ctx.lineageName,
      session_id: ctx.sessionId ?? null,
      kind: ev.kind,
      source: ev.source,
      juncture: ev.juncture ?? null,
      mst_id: ev.mst_id ?? null,
      detail: ev.detail ?? {},
    } as any);
    if ((res as any)?.error) console.error("logMstEvent insert error (M1 ledger, d36d9609):", (res as any).error.message);
  } catch (e) {
    console.error("logMstEvent threw (M1 ledger, d36d9609):", e);
  }
}
