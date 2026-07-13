// Caller authentication for the grounding-worker.
//
// Deploys with verify_jwt=false (see supabase/config.toml): the Supabase platform does NOT guard this
// endpoint, so the worker guards itself. The pg_cron drainer presents a shared secret in the `apikey`
// header; we compare it, in constant time, to WORKER_INVOKE_KEY (the SAME project secret the
// theo-dispatch-worker drainer uses). Fail closed: missing env or missing/wrong header rejects.

const HEADER = "apikey";

export async function isAuthorizedCaller(req: Request): Promise<boolean> {
  const expected = Deno.env.get("WORKER_INVOKE_KEY");
  if (!expected) return false;
  const presented = req.headers.get(HEADER);
  if (!presented) return false;
  return await constantTimeEqual(presented, expected);
}

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
