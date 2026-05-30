import type { Action } from "./types.ts";
import type { HoldThisPayload } from "../lib/types.ts";
import { corsHeaders, errResponse } from "../lib/http.ts";

export const holdThisAction: Action = {
  name: "hold_this",
  handle: async ({ supabase, body }) => {
    const ht = body.hold_this_payload as HoldThisPayload | undefined;
    if (!ht?.mode) return errResponse("Invalid hold_this_payload", 400);

    if (ht.mode === "create") {
      if (!ht.title || !ht.content) return errResponse("hold_this create requires title and content", 400);
      const { data, error } = await supabase
        .from("artifacts")
        .insert({
          instance_id: ht.instance_id ?? null,
          title: ht.title,
          artifact_type: "MST",
          content: ht.content,
          metadata: ht.metadata ?? {},
        })
        .select("id")
        .single();
      if (error) {
        console.error("hold_this create error:", error);
        return errResponse(error.message);
      }
      return new Response(
        JSON.stringify({ id: (data as any).id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (ht.mode === "amend") {
      if (!ht.id || !ht.content) return errResponse("hold_this amend requires id and content", 400);
      const { error } = await supabase
        .from("artifacts")
        .update({ content: ht.content, metadata: ht.metadata ?? {} })
        .eq("id", ht.id);
      if (error) {
        console.error("hold_this amend error:", error);
        return errResponse(error.message);
      }
      return new Response(
        JSON.stringify({ id: ht.id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return errResponse(`Unknown hold_this mode: ${ht.mode}`, 400);
  },
};
