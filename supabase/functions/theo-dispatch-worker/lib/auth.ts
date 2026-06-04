// Caller authentication for the worker.
//
// theo-dispatch-worker deploys with verify_jwt=false (see supabase/config.toml):
// the Supabase platform does NOT guard this endpoint, so the worker must guard
// itself. Without this check, disabling the platform gate would leave a
// money-spending endpoint open to the public internet — a spend-DoS vector.
//
// The pg_cron drainer presents a shared secret in the `apikey` header (the new
// Supabase secret-key model: secret keys go in `apikey`, never as a Bearer JWT).
// We compare it, in constant time, to WORKER_INVOKE_KEY from env.
//
// Fail closed: a missing env secret, or a missing/wrong header, rejects.

const HEADER = "apikey";

export async function isAuthorizedCaller(req: Request): Promise<boolean> {
  const expected = Deno.env.get("WORKER_INVOKE_KEY");
  if (!expected) return false;               // no secret configured -> reject all
  const presented = req.headers.get(HEADER);
  if (!presented) return false;
  return await constantTimeEqual(presented, expected);
}

// Hash both sides to fixed 32-byte digests before comparing, so neither the
// length nor the content of the secret leaks through comparison timing.
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

async function sha256(s: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}
