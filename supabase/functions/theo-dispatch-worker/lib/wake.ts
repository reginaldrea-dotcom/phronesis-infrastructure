// wake_deltas insert helper.
// Honours the (ref_id IS NULL) = (ref_type IS NULL) pairing CHECK.
// Phase-1 dispatch deltas always carry ref_type='theo_session' + ref_id=<session id>.

import type { SupabaseClient } from "./supabase.ts";

const FROM_LINEAGE = "theo-dispatch-worker";

// Resolve the lineage that OWNS a session, so the completion delta reaches the
// Prime that started the run rather than always Theo (baton 143072ab #5). There is
// no owner-lineage column on theo_session, but enqueue_dispatch files a start-of-job
// wake_delta whose from_lineage IS the initiating Prime (e.g. 'angelia'). We read
// that marker. The shared autonomous-research app_user can't disambiguate Angelia
// from Theo, so the start delta — not app_user — is the source of truth.
// Fallback 'theophrastus' preserves prior behaviour for any session with no marker.
export async function resolveOwnerLineage(
  supabase: SupabaseClient,
  theoSessionId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("wake_deltas")
    .select("from_lineage, created_at")
    .eq("ref_type", "theo_session")
    .eq("ref_id", theoSessionId)
    .neq("from_lineage", FROM_LINEAGE)   // exclude the worker's own deltas
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data?.from_lineage) return "theophrastus";
  return data.from_lineage as string;
}

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
