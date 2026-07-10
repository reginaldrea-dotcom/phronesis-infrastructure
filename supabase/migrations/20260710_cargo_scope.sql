-- Delphia enforcement lane (baton cdb7693c / conf 75d90356), pieces 3 + 5.
-- Contract verified by Napoleon (msg 128f7426): dossier_slice carries identity_key + dossier_instance_id;
-- Connie's freeze_dossier_slice(p_slice_id, p_identity_key) is the amended pin finalizer.
--
-- PIECE 3 - SCOPED-DB-IDENTITY (Charge 3): a sealed Sibling's cargo reads run under a restricted DB role
-- whose RLS confines it to EXACTLY the sealed (identity_key, dossier_instance_id). The scope comes from
-- tx-local GUCs the EF sets FROM THE SEALED GRANT (never model input), so another consumer's cargo or
-- another Dossier's cargo is PHYSICALLY UNADDRESSABLE (RLS returns zero rows), not merely filtered by app
-- code. This reuses the proven-live B1 direct-connection path (prime_runner login, NOINHERIT; cut2conn.ts).
--
-- PIECE 5 - WRITE-ON-PIN + FOLD: the pin is the FIRST durable write (no dossier_slice row exists for
-- unpinned session content); pin_dossier_slice creates the row and freezes it atomically, stamping
-- identity_key at pin (the consent gate). The fold HARD-DROPS any unpinned (unfrozen) session content.

-- =============================================================================================
-- PIECE 3: cargo_scope role + RLS confinement on dossier_slice
-- =============================================================================================

-- cargo_scope: no login, NOINHERIT, zero own privileges. prime_runner (the B1 direct-connection login,
-- itself NOINHERIT with no privileges) is granted membership so the EF can `SET LOCAL ROLE cargo_scope`
-- on the existing PRIME_CUT2_DB_URL connection. cargo_scope may SELECT dossier_slice, but the RLS policy
-- below narrows every read to the sealed scope.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cargo_scope') then
    create role cargo_scope nologin noinherit;
  end if;
end $$;
grant cargo_scope to prime_runner;
grant select on public.dossier_slice to cargo_scope;

-- Enable RLS on dossier_slice. service_role + postgres BYPASSRLS (verified): EF reads via the service
-- client and the SECURITY DEFINER freeze/pin functions are UNAFFECTED. The front-end does not read this
-- table directly (verified: no navigator reference). anon/authenticated hold broad default grants and do
-- NOT bypass RLS; to change NOTHING about their current (RLS-off) access we add an explicit permissive
-- policy preserving it. (FLAGGED to Connie: anon's blanket grant on dossier_slice predates this lane and
-- looks removable - her call, not tightened here.)
alter table public.dossier_slice enable row level security;

drop policy if exists dossier_slice_legacy_open on public.dossier_slice;
create policy dossier_slice_legacy_open on public.dossier_slice
  for all to anon, authenticated
  using (true) with check (true);

-- THE CONFINEMENT. cargo_scope sees a row ONLY when BOTH tx-local GUCs match it. current_setting(_, true)
-- returns NULL when the GUC is unset, so an un-scoped connection matches nothing - deny-by-default. The
-- identity_key-is-not-null guard keeps legacy/unscoped slices (null identity) invisible to cargo_scope.
drop policy if exists dossier_slice_cargo_scope on public.dossier_slice;
create policy dossier_slice_cargo_scope on public.dossier_slice
  for select to cargo_scope
  using (
    identity_key is not null
    and identity_key = current_setting('app.identity_key', true)
    and dossier_instance_id::text = current_setting('app.dossier_instance_id', true)
  );

comment on policy dossier_slice_cargo_scope on public.dossier_slice is
  'Delphia cargo confinement (baton cdb7693c, piece 3). cargo_scope reads ONLY the sealed (identity_key, dossier_instance_id), set tx-local by the EF from the SEALED grant - never model input. Cross-person + cross-Dossier reads are physically unaddressable.';

-- =============================================================================================
-- PIECE 5: write-on-pin (pin = first durable write) + fold (hard-drop unpinned)
-- =============================================================================================

-- pin_dossier_slice - the pin is the FIRST durable write. Creates the dossier_slice row from session
-- context AND freezes it in one call (reusing Connie's amended freeze_dossier_slice as the finalizer),
-- stamping identity_key at pin. Before pin there is NO dossier_slice row for the content. SECURITY DEFINER
-- so it runs above RLS (the row is created for the sealed identity; the scoped read path enforces access).
create or replace function public.pin_dossier_slice(
  p_theo_session_id     uuid,
  p_dossier_instance_id uuid,
  p_identity_key        text,
  p_slice_kind          text default 'interrogation',
  p_label               text default null,
  p_owner_lineage       text default 'delphia'
) returns public.dossier_slice
  language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_id uuid; v_row public.dossier_slice;
begin
  if p_identity_key is null or btrim(p_identity_key) = '' then
    raise exception 'pin_dossier_slice: identity_key is required at pin (the consent gate)';
  end if;
  if p_dossier_instance_id is null then
    raise exception 'pin_dossier_slice: dossier_instance_id is required';
  end if;
  if p_theo_session_id is null then
    raise exception 'pin_dossier_slice: theo_session_id is required';
  end if;

  insert into public.dossier_slice
    (theo_session_id, dossier_instance_id, slice_kind, label, owner_lineage, identity_key)
  values
    (p_theo_session_id, p_dossier_instance_id, coalesce(p_slice_kind, 'interrogation'),
     p_label, coalesce(p_owner_lineage, 'delphia'), btrim(p_identity_key))
  returning id into v_id;

  -- write-on-pin: the freshly-created row is frozen immediately (created + pinned atomically).
  v_row := public.freeze_dossier_slice(v_id, btrim(p_identity_key));
  return v_row;
end $$;

comment on function public.pin_dossier_slice is
  'Write-on-pin (baton cdb7693c, piece 5): creates a dossier_slice from session context AND freezes it atomically, stamping identity_key at pin. There is no pre-pin durable row. Reuses freeze_dossier_slice as finalizer.';

-- fold_session_slices - THE FOLD. Any dossier_slice for the session left unfrozen (created but never
-- pinned) is HARD-DROPPED: unpinned session content does not persist. Idempotent; returns the count
-- dropped. Frozen (pinned) slices are never touched - snapshots are immutable.
create or replace function public.fold_session_slices(p_theo_session_id uuid)
  returns integer
  language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_dropped integer;
begin
  if p_theo_session_id is null then
    raise exception 'fold_session_slices: theo_session_id is required';
  end if;
  delete from public.dossier_slice
   where theo_session_id = p_theo_session_id and frozen_at is null;
  get diagnostics v_dropped = row_count;
  return v_dropped;
end $$;

comment on function public.fold_session_slices is
  'The fold (baton cdb7693c, piece 5): hard-drops unpinned (unfrozen) dossier_slice rows for a session. Pinned/frozen snapshots are immutable and untouched.';
