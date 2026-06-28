-- file_canonical_artifact() — the supersede-chain generalisation of file_super_t.
--
-- Spec: artifact f1a4e8d2 (Constantinople Seq 37) / brief c57e32b8. Reg-agreed decisions:
-- DB-side body, md5 as the validation mechanism, lineage + canonical_status promoted to columns.
-- Depends on the columns + index in 20260628_artifacts_canonical_columns.sql.
--
-- CONTRACT
--   Idempotency key: (lineage, artifact_type, version), where version = metadata->>'version'.
--     - same key + same content (md5)      -> return the existing id (no-op)
--     - same key + different content (md5)  -> RAISE (versions are immutable; bump the version)
--     - fresh key                           -> insert as canonical, atomically superseding the
--                                              prior canonical of this (lineage, artifact_type)
--   md5 validation: p_expected_md5 must equal md5(p_content). A hash-mismatched call is refused
--   (catches truncated / corrupted content in transit). md5 is computed live from content; there
--   is no stored md5 column.
--   lineage drives the GENERATED column, so it is written INTO metadata, never to the column.
--
-- SUPERSEDE-FLIP SCOPE (Heph judgment call — flagged to Constantinople for review):
--   The signature is general (any artifact_type), but the one-canonical invariant is only
--   STRUCTURALLY enforced for PI (one_canonical_pi_per_lineage). canonical is freeform for
--   MR/WN/SY. So the flip refuses to act when it finds MORE THAN ONE existing canonical for a
--   (lineage, type): it will not mass-supersede a set of legitimately-distinct freeform-canonical
--   docs. It works cleanly for a single-canonical supersede chain (PI-style) and inserts without a
--   flip when there is no prior canonical. Non-destructive by construction.
--
-- Not SECURITY DEFINER (matches file_super_t): the EF calls it as service_role, which bypasses
-- RLS; the artifacts table is RLS deny-all, so a non-service caller cannot write through it.

CREATE OR REPLACE FUNCTION public.file_canonical_artifact(
  p_lineage       text,
  p_artifact_type public.artifact_type_enum,
  p_title         text,
  p_version       text,
  p_content       text,
  p_expected_md5  text,
  p_metadata      jsonb,
  p_instance_id   uuid
) RETURNS uuid
LANGUAGE plpgsql
AS $function$
declare
  v_expected_md5 text := lower(btrim(coalesce(p_expected_md5, '')));
  v_actual_md5   text := md5(coalesce(p_content, ''));
  v_match_count  integer;
  v_existing_id  uuid;
  v_canon_count  integer;
  v_canon_id     uuid;
  v_metadata     jsonb;
  v_new_id       uuid;
begin
  -- ── Required inputs ───────────────────────────────────────────────────
  if p_lineage is null or btrim(p_lineage) = '' then
    raise exception 'file_canonical_artifact: p_lineage is required';
  end if;
  if p_artifact_type is null then
    raise exception 'file_canonical_artifact: p_artifact_type is required';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'file_canonical_artifact: p_title is required (artifacts.title is NOT NULL)';
  end if;
  if p_version is null or btrim(p_version) = '' then
    raise exception 'file_canonical_artifact: p_version is required (it is the idempotency key)';
  end if;
  if p_instance_id is null then
    raise exception 'file_canonical_artifact: p_instance_id is required (artifacts.instance_id is NOT NULL)';
  end if;

  -- ── md5 validation: declared hash must match the content actually sent ─
  if v_expected_md5 = '' then
    raise exception 'file_canonical_artifact: p_expected_md5 is required (md5 validation)';
  end if;
  if v_expected_md5 <> v_actual_md5 then
    raise exception 'file_canonical_artifact: content does not match p_expected_md5 (declared %, actual %) — refusing to file a hash-mismatched artifact',
      v_expected_md5, v_actual_md5;
  end if;

  -- Serialise concurrent filings of the SAME chain so the flip + insert is atomic against races.
  perform pg_advisory_xact_lock(hashtextextended(p_lineage || ':' || p_artifact_type::text, 0));

  -- ── Idempotency on (lineage, artifact_type, version) ──────────────────
  -- Idempotent replay: a row with this key AND this content already exists -> return it. Keyed on
  -- CONTENT identity (md5), and the canonical row is preferred when several historical rows share
  -- the key+content (pre-function re-files left superseded duplicates at the same version string).
  select id into v_existing_id
  from public.artifacts
  where lineage = p_lineage
    and artifact_type = p_artifact_type
    and metadata->>'version' = p_version
    and md5(coalesce(content, '')) = v_actual_md5
  order by (canonical_status = 'canonical') desc nulls last, created_at desc
  limit 1;
  if v_existing_id is not null then
    return v_existing_id;  -- same key, same content -> idempotent no-op
  end if;

  -- Same version string, different content -> version collision. Versions are immutable.
  select count(*) into v_match_count
  from public.artifacts
  where lineage = p_lineage
    and artifact_type = p_artifact_type
    and metadata->>'version' = p_version;
  if v_match_count > 0 then
    raise exception 'file_canonical_artifact: version % already exists for (%, %) with different content — versions are immutable, bump the version to file new content',
      p_version, p_lineage, p_artifact_type;
  end if;

  -- ── Fresh key: locate the current canonical for this (lineage, type) ──
  select count(*) into v_canon_count
  from public.artifacts
  where lineage = p_lineage
    and artifact_type = p_artifact_type
    and canonical_status = 'canonical';

  if v_canon_count > 1 then
    raise exception 'file_canonical_artifact: (%, %) has % canonical artifacts — refusing to auto-supersede multiple. This filer assumes a single-canonical supersede chain (one-canonical is structurally enforced only for PI).',
      p_lineage, p_artifact_type, v_canon_count;
  end if;

  if v_canon_count = 1 then
    select id into v_canon_id
    from public.artifacts
    where lineage = p_lineage
      and artifact_type = p_artifact_type
      and canonical_status = 'canonical';
  end if;

  -- ── Build metadata: lineage (feeds the generated column) + version + supersedes ──
  v_metadata := coalesce(p_metadata, '{}'::jsonb)
                || jsonb_build_object('lineage', p_lineage, 'version', p_version);
  if v_canon_id is not null then
    v_metadata := v_metadata || jsonb_build_object('supersedes', v_canon_id::text);
  end if;

  -- Flip the prior canonical FIRST so the PI partial-unique index never sees two canonicals
  -- at once, then insert the new canonical.
  if v_canon_id is not null then
    update public.artifacts set canonical_status = 'superseded' where id = v_canon_id;
  end if;

  insert into public.artifacts (instance_id, title, artifact_type, content, metadata, canonical_status)
  values (p_instance_id, p_title, p_artifact_type, p_content, v_metadata, 'canonical')
  returning id into v_new_id;

  return v_new_id;
end;
$function$;

-- Write function on an RLS-deny-all table: keep it off the public/anon surface, expose to the
-- service-role path the EF uses. (file_super_t relies on non-definer + RLS alone; this is the
-- same protection made explicit.)
REVOKE EXECUTE ON FUNCTION public.file_canonical_artifact(text, public.artifact_type_enum, text, text, text, text, jsonb, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.file_canonical_artifact(text, public.artifact_type_enum, text, text, text, text, jsonb, uuid) TO service_role;
