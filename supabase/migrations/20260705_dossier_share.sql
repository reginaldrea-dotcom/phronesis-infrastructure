-- dossier_share — per-dossier capability links (token -> theo_session) for read-only external sharing.
-- Reg-directed 5 Jul 2026. NEW feature table; schema is Constantinople's lane, so she is notified for
-- record/ownership. A share is an opaque 128-bit token bound to ONE theo_session; the public viewer
-- (clarev.ai/d.html?t=<token>) resolves it. Token-only gate (no password) per Reg. RLS deny-all — the
-- table is reached ONLY through the two SECURITY DEFINER RPCs below (mint = privileged; resolve = anon).

CREATE TABLE IF NOT EXISTS public.dossier_share (
  token            text PRIMARY KEY,
  theo_session_id  uuid NOT NULL REFERENCES public.theo_session(id),
  label            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  revoked          boolean NOT NULL DEFAULT false,
  last_accessed_at timestamptz,
  access_count     integer NOT NULL DEFAULT 0
);
ALTER TABLE public.dossier_share ENABLE ROW LEVEL SECURITY;  -- deny-all; only the definer RPCs touch it

-- mint: create a share link for a dossier, returning the token. Privileged (service_role/authenticated) —
-- the public can never mint. Bind to a real session; label is a human handle (e.g. 'AESSEAL board').
CREATE OR REPLACE FUNCTION public.mint_dossier_share(
  p_theo_session_id uuid,
  p_label           text DEFAULT NULL,
  p_expires_at      timestamptz DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM theo_session WHERE id = p_theo_session_id) THEN
    RAISE EXCEPTION 'no theo_session with id %', p_theo_session_id;
  END IF;
  -- 64 hex chars from two random v4 uuids (~244 bits) — unguessable, no pgcrypto dependency.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO dossier_share (token, theo_session_id, label, expires_at)
  VALUES (v_token, p_theo_session_id, p_label, p_expires_at);
  RETURN v_token;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mint_dossier_share(uuid, text, timestamptz) TO service_role, authenticated;

-- resolve: the PUBLIC viewer calls this with a token. Returns the session id iff the share is live
-- (exists, not revoked, not expired); otherwise NULL. The token is the capability, so this is anon-callable.
-- A single UPDATE...RETURNING both checks liveness and records access atomically; no row -> NULL.
-- Tokens are 128-bit random, so this is not enumerable.
CREATE OR REPLACE FUNCTION public.resolve_dossier_share(p_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session uuid;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN RETURN NULL; END IF;
  UPDATE dossier_share
     SET last_accessed_at = now(), access_count = access_count + 1
   WHERE token = p_token
     AND revoked = false
     AND (expires_at IS NULL OR expires_at > now())
   RETURNING theo_session_id INTO v_session;
  RETURN v_session;  -- NULL if no live share matched
END;
$$;
GRANT EXECUTE ON FUNCTION public.resolve_dossier_share(text) TO anon, authenticated, service_role;

COMMENT ON TABLE public.dossier_share IS
  'Capability links for read-only external dossier sharing (Reg 5 Jul 2026). token -> theo_session, opaque, revocable, optional expiry. Reached only via mint_dossier_share (privileged) and resolve_dossier_share (anon). Constantinople owns the schema going forward.';
