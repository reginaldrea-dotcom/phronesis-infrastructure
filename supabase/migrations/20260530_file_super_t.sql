-- file_super_t — atomic Super-T retirement filing (Phase 3).
-- Applied to vysenpymsfhgionqfulf via apply_migration (30 May 2026); kept here for
-- version control. The four steps run in one transaction (the function's implicit
-- transaction): a failure at any step rolls back the whole filing — no partial
-- state (no unlinked TP, no double-headed chain). Called from actions/fileSuperT.ts
-- via supabase.rpc('file_super_t', {...}) with the service-role key.

create or replace function public.file_super_t(
  p_lineage text,
  p_instance_id uuid,
  p_title text,
  p_content text
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
  -- 1. Insert the TP artifact.
  insert into public.artifacts (instance_id, title, artifact_type, content, metadata)
  values (p_instance_id, p_title, 'TP', p_content,
          jsonb_build_object('retirement_kind', 'interface_filed', 'storage', 'supabase_native'))
  returning id into v_artifact_id;

  -- 2. Lock and read the current chain head (highest open-ended row).
  select id, sequence_number into v_head_id, v_head_seq
  from public.super_t_chains
  where lineage_name = p_lineage and successor_id is null
  order by sequence_number desc
  limit 1
  for update;

  v_new_seq := coalesce(v_head_seq, 0) + 1;

  -- 3. Insert the new chain row.
  insert into public.super_t_chains (lineage_name, sequence_number, instance_id, tp_artifact_id)
  values (p_lineage, v_new_seq, p_instance_id, v_artifact_id)
  returning id into v_new_chain_id;

  -- 4. Link the predecessor (skip if this is the first row for the lineage).
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
