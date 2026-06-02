// wake_deltas insert helper.
// Honours the (ref_id IS NULL) = (ref_type IS NULL) pairing CHECK.
// Phase-1 dispatch deltas always carry ref_type='theo_session' + ref_id=<session id>.

import type { SupabaseClient } from "./supabase.ts";

const FROM_LINEAGE = "theo-dispatch-worker";

export async function fileSessionWakeDelta(
  supabase: SupabaseClient,
  args: {
    to_lineage: string;
    note: string;
    theo_session_id: string;
  },
): Promise<void> {
  const { error } = await supabase.from("wake_deltas").insert({
    to_lineage: args.to_lineage,
    from_lineage: FROM_LINEAGE,
    note: args.note,
    ref_type: "theo_session",
    ref_id: args.theo_session_id,
  });
  if (error) throw new Error(`wake_delta insert failed: ${error.message}`);
}
