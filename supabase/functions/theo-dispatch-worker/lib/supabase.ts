// RLS-bypassing Supabase client — required to scan ALL users' theo_session rows
// (auth.uid() RLS), update engine_dispatch, and write synthesis_section (deny-all RLS).
// This project is on the NEW key format (sb_secret_), under which the legacy
// SUPABASE_SERVICE_ROLE_KEY is NOT RLS-bypassing — using it left the worker seeing
// zero sessions. The credential is therefore THEO_DISPATCH_SECRET_KEY: a non-reserved
// secret set to the project's sb_secret_ key (SUPABASE_* names are auto-managed and
// can't be overridden, so we use a custom name).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { env } from "./env.ts";

export type SupabaseClient = ReturnType<typeof createClient>;

export function makeClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("THEO_DISPATCH_SECRET_KEY"));
}
