// RLS-bypassing Supabase client. This project is on the new key format (sb_secret_), under which the
// legacy SUPABASE_SERVICE_ROLE_KEY is NOT RLS-bypassing. The credential is THEO_DISPATCH_SECRET_KEY: a
// non-reserved secret set to the project's sb_secret_ key (shared project-wide; already used by
// theo-dispatch-worker). Needed to scan grounding_queue + element_dependency (deny-all RLS) and write
// wake_deltas.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { env } from "./env.ts";

export type SupabaseClient = ReturnType<typeof createClient>;

export function makeClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));
}
