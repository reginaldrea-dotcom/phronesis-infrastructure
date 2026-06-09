// api-prime-invoke | cut2 | B1 (conf 1151109e, MR fdc37ee8; Aegis ruling 247f51d5) | 7 Jun 2026
//
// ⚠ DO NOT DEPLOY — MECHANISM CONDEMNED (Argos finding c7500cae, 7 Jun eve).
// The project's JWT signing has migrated to asymmetric (ECC P-256); the HS256 shared
// secret this file signs with is in "previously used" state and will be revoked. An
// HS256-minted token verifies TODAY (so a smoke test falsely passes) but dies on
// revocation, and shipping it would block clean revocation of the legacy secret. The
// scoped-identity mechanism is being redesigned (Argos lean: a restricted LOGIN role +
// SET ROLE prime_cut2 over a direct connection — secret becomes a scoped role password,
// immune to signing-key migration); Aegis to amend her Part-A ruling. This file is kept
// only as the reference for the parts of the chain that survive (two-client split,
// token-never-enters-Worker, the opacity-gap ledger write). Do not wire Phase 3 against it.
//
// Scoped-identity for script-fired bindings. Aegis-approved mechanism: mint a
// short-lived JWT carrying role:"prime_cut2" + the calling lineage, signed with the
// PROJECT JWT secret, and build a second supabase-js client with it. PostgREST then
// runs every request from that client as prime_cut2 (SET ROLE), so cut2's DB grants +
// RLS apply — never service-role. prime_cut2 is NOLOGIN, which is fine: PostgREST
// switches role by claim, it does not log in.
//
// SECURITY SHAPE (Aegis condition 247f51d5, satisfied a fortiori): the token is minted
// in the PARENT EF only and used only by the parent's cut2 client. It is NEVER passed
// into the sandbox Worker — the Worker has no token at all, read-only or otherwise; it
// can only post `call` messages, which the parent executes with this client. So a script
// cannot mint, read, or manipulate a token or its lineage claim.
//
// The service-role client stays reserved for the model loop and the LEDGER WRITE — the
// opacity gap is structural: the row recording what a script did is written by a client
// the script's bindings never touch.

import { createClient } from "jsr:@supabase/supabase-js@2";
import type { SupabaseClient } from "../tools/types.ts";

const TTL_CEILING_SECONDS = 60; // Aegis Q1 ruling: per-run, ≤60s.

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signHs256(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)));
  return `${signingInput}.${base64url(sig)}`;
}

// Mint a per-run cut2 token for `lineage`. PARENT-EF-ONLY — never call this from a path
// reachable by a script. Throws if the secret is unset (deploy/secret gate, not a runtime
// surprise). PRIME_JWT_SECRET must equal the PROJECT JWT secret or PostgREST rejects the
// token — Reg sets it from the Supabase dashboard (API settings → JWT secret).
export async function mintCut2Token(lineage: string, ttlSeconds = TTL_CEILING_SECONDS): Promise<string> {
  const secret = Deno.env.get("PRIME_JWT_SECRET");
  if (!secret) throw new Error("PRIME_JWT_SECRET not set — cannot mint a prime_cut2 token for script execution");
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(ttlSeconds, 1), TTL_CEILING_SECONDS);
  return await signHs256(
    { role: "prime_cut2", lineage, iat: now, exp: now + ttl },
    secret,
  );
}

// Build the cut2-scoped client from a minted token. The anon/publishable key is the
// apikey; the cut2 token in Authorization carries the role claim PostgREST switches on.
export function cut2Client(token: string): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("PRIME_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
