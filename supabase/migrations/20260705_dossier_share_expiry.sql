-- Mandatory expiry on dossier shares (Aegis ruling 60cfe0e9, condition 1: "all externally shared tokens
-- must have an explicit expires_at ... enforce at mint_dossier_share() level ... reject or default if none").
-- Chosen: DEFAULT a missing expiry to 30 days (Aegis's recommended default) so NO share is ever unbounded,
-- and REJECT a past/immediate expiry (dead-on-arrival footgun). Explicit expiries still honoured (e.g. the
-- Aislinn link's 60 days). Existing rows are untouched — this governs new mints only. Constantinople's lane.

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
  v_token   text;
  v_expires timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM theo_session WHERE id = p_theo_session_id) THEN
    RAISE EXCEPTION 'no theo_session with id %', p_theo_session_id;
  END IF;
  -- Mandatory expiry: never unbounded. Default 30 days when none supplied; reject a non-future expiry.
  v_expires := COALESCE(p_expires_at, now() + interval '30 days');
  IF v_expires <= now() THEN
    RAISE EXCEPTION 'dossier share expires_at must be in the future (got %)', p_expires_at;
  END IF;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO dossier_share (token, theo_session_id, label, expires_at, suppress_notice)
  VALUES (v_token, p_theo_session_id, p_label, v_expires, p_suppress_notice);
  RETURN v_token;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mint_dossier_share(uuid, text, timestamptz, boolean) TO service_role, authenticated;
