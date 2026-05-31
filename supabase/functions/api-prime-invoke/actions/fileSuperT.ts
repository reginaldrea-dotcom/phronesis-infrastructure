import type { Action } from "./types.ts";
import { corsHeaders, errResponse } from "../lib/http.ts";

// Files a Super-T atomically via the file_super_t Postgres RPC (insert artifact →
// insert chain row → link predecessor, in one transaction). Service-role, so it
// bypasses RLS — the working replacement for the browser-side Option A filing.
export const fileSuperTAction: Action = {
  name: "file_super_t",
  handle: async ({ supabase, body }) => {
    const { content, title, instance_id, lineage, session_id } = body ?? {};
    if (!lineage || !title || !content) {
      return errResponse("file_super_t requires lineage, title, and content", 400);
    }
    const { data, error } = await supabase.rpc("file_super_t", {
      p_lineage: lineage,
      p_instance_id: instance_id ?? null,
      p_title: title,
      p_content: content,
      p_session_id: session_id ?? null,
    });
    if (error) {
      console.error("file_super_t error:", error);
      return errResponse(error.message);
    }
    // data = { artifact_id, chain_id, sequence_number, predecessor_id }
    return new Response(
      JSON.stringify(data),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  },
};
