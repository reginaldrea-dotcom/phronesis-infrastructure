-- Phase 1 enabler (Conference 1b638657) — thread session_id onto the chain row so
-- Connie can add UNIQUE(instance_id, session_id) (the role-independent double-file
-- guard, held until the D10 role split). Supersedes 20260530_file_super_t.sql.
-- Applied via apply_migration (31 May 2026).
alter table public.super_t_chains add column if not exists session_id uuid;

-- One function, callable with 4 args (legacy / Argos execute_sql → session_id null)
-- or 5 args (the file_super_t action passes session_id). DROP+CREATE because adding
-- a parameter changes the signature.
drop function if exists public.file_super_t(text, uuid, text, text);

create or replace function public.file_super_t(
  p_lineage text,
  p_instance_id uuid,
  p_title text,
  p_content text,
  p_session_id uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_artifact_id  uuid;
  v_head_id      uuid;
  v_head_seq     integer;
  v_new_chain_id uuid;
  v_new_seq      integer;
begin
  insert into public.artifacts (instance_id, title, artifact_type, content, metadata)
  values (p_instance_id, p_title, 'TP', p_content,
          jsonb_build_object('retirement_kind', 'interface_filed', 'storage', 'supabase_native'))
  returning id into v_artifact_id;

  select id, sequence_number into v_head_id, v_head_seq
  from public.super_t_chains
  where lineage_name = p_lineage and successor_id is null
  order by sequence_number desc
  limit 1
  for update;

  v_new_seq := coalesce(v_head_seq, 0) + 1;

  insert into public.super_t_chains (lineage_name, sequence_number, instance_id, tp_artifact_id, session_id)
  values (p_lineage, v_new_seq, p_instance_id, v_artifact_id, p_session_id)
  returning id into v_new_chain_id;

  if v_head_id is not null then
    update public.super_t_chains set successor_id = v_new_chain_id where id = v_head_id;
  end if;

  return jsonb_build_object(
    'artifact_id',     v_artifact_id,
    'chain_id',        v_new_chain_id,
    'sequence_number', v_new_seq,
    'predecessor_id',  v_head_id
  );
end;
$$;
