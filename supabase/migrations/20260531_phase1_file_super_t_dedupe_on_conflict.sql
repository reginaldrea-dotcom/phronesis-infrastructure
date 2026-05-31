-- Phase 1 FIX 2 (Conf 1b638657) — file_super_t replays the existing retirement on a
-- UNIQUE(instance_id, session_id) violation instead of throwing 23505. The write is
-- wrapped in an inner block so a conflict rolls back the artifact insert too (no orphan
-- TP). Inert until Connie's UNIQUE(instance_id, session_id) constraint exists; the raw
-- 4-arg (session_id NULL) path stays uncaught by design (D9 posture). Applied via
-- apply_migration (31 May 2026); supersedes 20260531_phase1_file_super_t_session_id.sql.
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
  v_existing     public.super_t_chains%rowtype;
  v_pred_id      uuid;
begin
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
  exception when unique_violation then
    select * into v_existing
    from public.super_t_chains
    where instance_id = p_instance_id and session_id = p_session_id
    order by sequence_number desc
    limit 1;

    select id into v_pred_id
    from public.super_t_chains
    where successor_id = v_existing.id;

    return jsonb_build_object(
      'artifact_id',     v_existing.tp_artifact_id,
      'chain_id',        v_existing.id,
      'sequence_number', v_existing.sequence_number,
      'predecessor_id',  v_pred_id
    );
  end;
end;
$$;
