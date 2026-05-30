// Action contract: a request keyed by body.action, handled deterministically and
// returning a Response directly (no LLM). The entry point dispatches via getAction().

import { createClient } from "jsr:@supabase/supabase-js@2";

export type SupabaseClient = ReturnType<typeof createClient>;

export interface ActionContext {
  supabase: SupabaseClient; // service-role — bypasses RLS
  body: any;
}

export interface Action {
  name: string; // matches body.action
  handle: (ctx: ActionContext) => Promise<Response>;
}
