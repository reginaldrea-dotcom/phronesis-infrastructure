// Resolve the worker's own instance_id from the `instances` table.
// Auto-register on first run (same pattern as the cc instance, but worker-owned).
// Required because claim_theo_session() writes locked_by_instance_id, which has
// FK -> instances(id) — the worker must be a real instances row.

import type { SupabaseClient } from "./supabase.ts";
import { WORKER_INSTANCE_NAME } from "./config.ts";

export async function resolveWorkerInstanceId(supabase: SupabaseClient): Promise<string> {
  // Try to read first.
  {
    const { data, error } = await supabase
      .from("instances")
      .select("id")
      .eq("name", WORKER_INSTANCE_NAME)
      .maybeSingle();
    if (error) throw new Error(`instances read failed: ${error.message}`);
    if (data?.id) return data.id as string;
  }

  // Not present — register.
  {
    const { data, error } = await supabase
      .from("instances")
      .insert({
        name: WORKER_INSTANCE_NAME,
        display_name: "Theo Dispatch Worker",
        instance_type: "external",
      })
      .select("id")
      .single();
    if (error) {
      // Concurrent registration race — re-read.
      const retry = await supabase
        .from("instances")
        .select("id")
        .eq("name", WORKER_INSTANCE_NAME)
        .single();
      if (retry.error) throw new Error(`instances register failed: ${error.message}`);
      return retry.data.id as string;
    }
    return data.id as string;
  }
}
