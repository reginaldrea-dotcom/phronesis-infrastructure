// Service-role Supabase client. RLS-bypassing — required for synthesis_section
// writes (deny-all RLS) and engine_dispatch updates. Matches api-prime-invoke's
// service-role-only pattern.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { env } from "./env.ts";

export type SupabaseClient = ReturnType<typeof createClient>;

export function makeClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
}
