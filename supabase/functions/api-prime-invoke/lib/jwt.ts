// Extract the user id (sub) from a Supabase JWT, for per-user rate limiting.

export function extractUserIdFromJwt(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const payload = JSON.parse(atob(authHeader.slice(7).split(".")[1]));
    const sub = payload.sub;
    return typeof sub === "string" && /^[0-9a-f-]{36}$/.test(sub) ? sub : null;
  } catch { return null; }
}
