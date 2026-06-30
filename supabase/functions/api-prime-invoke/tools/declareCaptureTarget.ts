// declare_capture_target — the Prime declares which synthesis/session THIS capture run
// writes into (a90e1410 instance 3; Connie carrier 6d3fab47). Intent is the only
// disambiguator and it lives with the Prime; this makes it explicit and substrate-recorded.
// After declaring, the capture write tools (write_synthesis_section / write_claims /
// commit_synthesis) accept ONLY that session — a mis-target is rejected (it names the
// declared target), which is what would have stopped the SC1 arc-clobber.

import type { Tool, ToolContext } from "./types.ts";
import { resolveCaptureSession } from "../lib/resolveCaptureSession.ts";
import { setCaptureTarget } from "../lib/captureTarget.ts";

function fail(msg: string): string {
  return `declare_capture_target error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const declareCaptureTargetTool: Tool = {
  definition: {
    name: "declare_capture_target",
    description:
      "Declare which synthesis/session THIS capture run writes into, for the rest of this session. Call it once before capturing — right after enqueue_dispatch creates your synthesis (this is auto-set on enqueue, but declare explicitly when adopting an EXISTING synthesis, e.g. a competitive read that homes in an arc synthesis). After you declare, write_synthesis_section / write_claims / commit_synthesis may ONLY target that session; a write to any other synthesis is rejected and names your declared target. This makes your write intent explicit and substrate-recorded and prevents a mis-targeted write from clobbering a sibling synthesis. Pass a theo_session_id (or a synthesis_id, which resolves to its session). Re-call to switch targets deliberately.",
    input_schema: {
      type: "object",
      properties: {
        theo_session_id: { type: "string", description: "The session (or synthesis id) this run writes into — full UUID or hex prefix." },
        note: { type: "string", description: "Optional: what this run is capturing (recorded so a wrong declaration is debuggable)." },
      },
      required: ["theo_session_id"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => `declare_capture_target: ${String((input as { theo_session_id?: unknown })?.theo_session_id ?? "").slice(0, 12)}`,

  run: async (input, ctx: ToolContext) => {
    const raw = typeof (input as { theo_session_id?: unknown })?.theo_session_id === "string"
      ? (input as { theo_session_id: string }).theo_session_id.trim() : "";
    const note = typeof (input as { note?: unknown })?.note === "string" ? (input as { note: string }).note : undefined;
    if (!ctx.sessionId) return fail("no prime session in context — cannot declare a capture target.");
    const resolved = await resolveCaptureSession(ctx.supabase, raw);
    if ("err" in resolved) return fail(resolved.err);
    const set = await setCaptureTarget(ctx.supabase, ctx.sessionId, resolved.sessionId, ctx.lineageName, { note });
    if ("err" in set) return fail(set.err);
    return JSON.stringify({
      declared: true,
      theo_session_id: resolved.sessionId,
      prime_session: ctx.sessionId,
      "[SYSTEM]": `Capture target LOCKED to theo_session ${resolved.sessionId.slice(0, 8)} for this session. write_synthesis_section / write_claims / commit_synthesis will now accept only this session; any other target is rejected. Re-call to switch targets.${resolved.note ? " (" + resolved.note + ")" : ""}`,
    });
  },
};
