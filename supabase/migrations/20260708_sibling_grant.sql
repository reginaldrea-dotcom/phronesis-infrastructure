-- sibling_grant — the SPAWNER-SEALED, per-invocation grant for an ephemeral Sibling (Delphia).
-- Conference 75d90356 (Delphia) / baton cdb7693c, build-item-one, enforcement lane (Heph).
--
-- The load-bearing property the whole safety case rests on (Napoleon's synthesis): the grant is SET BY THE
-- SPAWNER IN THE EF AND SEALED — never model-visible, never model-editable, never widenable mid-session.
-- This table is that seal's home. api-prime-invoke reads it BELOW THE MODEL (by session + lineage) and
-- threads permit + cargo into the tool-execution context; the execution-layer grant check in the ~3 shared
-- privileged tools (raw-web dispatch / tier assignment / free-write) reads THIS, not the request body. It is
-- the durable, TOOL_GRANTS_ENFORCE-independent belt (b): even if the tool-visibility layer (a) regressed,
-- an un-permitted capability is refused here.
--
-- Distinct from tool_grants (per-standing-lineage, visibility layer) — sibling_grant binds PER-INVOCATION
-- (per session), because Delphia is ephemeral and spawned WITH her grant, not a standing lineage.
--
-- NOTE: this is the ENFORCEMENT descriptor (permit + a POINTER to the cargo scope). The cargo tables
-- themselves (identity-keyed dossier_slice, entitlement/approved-list) are Connie's 2a lane; the `cargo`
-- jsonb here only NAMES the scope {dossier_id, identity} that the scoped-DB-identity (item 2) SET ROLEs into.

create table if not exists public.sibling_grant (
  id            uuid primary key default gen_random_uuid(),
  session_id    text        not null,                 -- the api-prime-invoke chat session this grant seals
  lineage_name  text        not null,                 -- the sibling lineage (e.g. 'delphia')
  permit        text[]      not null default '{}',    -- capability classes GRANTED. Absent capability = DENIED.
  cargo         jsonb       not null default '{}'::jsonb, -- { dossier_id, identity } — the scope for item-2 SET ROLE
  spawner       text        not null,                 -- who sealed it (spawning lineage/actor) — audit
  sealed_at     timestamptz not null default now(),
  revoked_at    timestamptz,
  unique (session_id, lineage_name)
);

comment on table public.sibling_grant is
  'Spawner-sealed per-invocation grant (permit + cargo scope) for ephemeral Siblings (Delphia). Read below the model by api-prime-invoke; NEVER set from the request body. The execution-layer grant check reads this. Conf 75d90356 / baton cdb7693c.';
comment on column public.sibling_grant.permit is
  'Capability classes this sibling HOLDS (a true subset of the road). The execution-layer check DENIES any privileged capability not listed here — deny-by-default.';
comment on column public.sibling_grant.cargo is
  '{ dossier_id, identity }: the cargo scope. Not the data itself — the key the scoped-DB-identity (SET ROLE) constrains reads/writes to.';

-- RLS deny-all (house pattern): the browser/anon can never read or write the seal; only the service-role EF
-- and SECURITY DEFINER RPCs touch it. Enabling RLS with zero policies = deny to anon, bypass for service-role.
alter table public.sibling_grant enable row level security;

-- seal_sibling_grant — the SPAWNER's write. SECURITY DEFINER, called service-side by the spawner (the Clarev
-- door / a spawn action), NEVER exposed as a model tool — that is what makes the grant unwidenable by the
-- reasoner it governs. Upsert on (session_id, lineage): a re-spawn re-seals (spawner action, not the model).
create or replace function public.seal_sibling_grant(
  p_session_id text,
  p_lineage_name text,
  p_permit text[],
  p_cargo jsonb,
  p_spawner text
) returns public.sibling_grant
  language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_row public.sibling_grant;
begin
  if p_session_id  is null or btrim(p_session_id)  = '' then raise exception 'seal_sibling_grant: p_session_id is required'; end if;
  if p_lineage_name is null or btrim(p_lineage_name) = '' then raise exception 'seal_sibling_grant: p_lineage_name is required'; end if;
  if p_spawner     is null or btrim(p_spawner)     = '' then raise exception 'seal_sibling_grant: p_spawner is required'; end if;

  insert into public.sibling_grant (session_id, lineage_name, permit, cargo, spawner)
  values (btrim(p_session_id), btrim(p_lineage_name), coalesce(p_permit, '{}'), coalesce(p_cargo, '{}'::jsonb), btrim(p_spawner))
  on conflict (session_id, lineage_name) do update
    set permit = excluded.permit, cargo = excluded.cargo, spawner = excluded.spawner,
        sealed_at = now(), revoked_at = null
  returning * into v_row;
  return v_row;
end $$;

comment on function public.seal_sibling_grant is
  'Spawner-side seal of a per-invocation sibling grant (permit + cargo). SECURITY DEFINER, service-only, never a model tool — the reasoner it governs cannot call it, so it cannot widen its own permit. Conf 75d90356 / baton cdb7693c.';
