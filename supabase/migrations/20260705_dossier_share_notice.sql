-- Confidentiality notice for dossier shares (Aegis ruling 60cfe0e9 + addendum 45163f69; Reg 5 Jul 2026).
-- Policy: the public viewer (d.html) shows a confidentiality notice BY DEFAULT — present unless explicitly
-- suppressed, never opt-in. So the flag defaults to "show", and every existing share is backfilled to show.
-- Constantinople's schema lane — notified.

ALTER TABLE public.dossier_share
  ADD COLUMN IF NOT EXISTS suppress_notice boolean NOT NULL DEFAULT false;  -- false = notice shown (default-on)

COMMENT ON COLUMN public.dossier_share.suppress_notice IS
  'Confidentiality notice is DEFAULT-ON on the d.html viewer (Aegis 45163f69). false (default) = notice shown; true = explicitly suppressed (dossier is wholly public-domain and not client-specific).';

-- mint: gains an optional p_suppress_notice (default false = notice shown). Drop the 3-arg form and
-- recreate with the extra defaulted param so a 3-arg call still works.
DROP FUNCTION IF EXISTS public.mint_dossier_share(uuid, text, timestamptz);
CREATE OR REPLACE FUNCTION public.mint_dossier_share(
  p_theo_session_id uuid,
  p_label           text DEFAULT NULL,
  p_expires_at      timestamptz DEFAULT NULL,
  p_suppress_notice boolean DEFAULT false
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
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO dossier_share (token, theo_session_id, label, expires_at, suppress_notice)
  VALUES (v_token, p_theo_session_id, p_label, p_expires_at, p_suppress_notice);
  RETURN v_token;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mint_dossier_share(uuid, text, timestamptz, boolean) TO service_role, authenticated;

-- resolve: now returns jsonb {session_id, suppress_notice} (was a bare uuid) so the viewer can render the
-- notice default-on. NULL when no live share. anon-callable; records access. Return-type change -> drop+create.
DROP FUNCTION IF EXISTS public.resolve_dossier_share(text);
CREATE OR REPLACE FUNCTION public.resolve_dossier_share(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session  uuid;
  v_suppress boolean;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN RETURN NULL; END IF;
  UPDATE dossier_share
     SET last_accessed_at = now(), access_count = access_count + 1
   WHERE token = p_token
     AND revoked = false
     AND (expires_at IS NULL OR expires_at > now())
   RETURNING theo_session_id, suppress_notice INTO v_session, v_suppress;
  IF v_session IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('session_id', v_session, 'suppress_notice', v_suppress);
END;
$$;
GRANT EXECUTE ON FUNCTION public.resolve_dossier_share(text) TO anon, authenticated, service_role;
