-- ============================================================================
-- dossier_integrity_gate: exclude flags on SUPERSEDED overlays (Heph, 22 Jul 2026).
-- ----------------------------------------------------------------------------
-- Read-time superseded discipline, part of the canonical-text model (ruling d5865af3 /
-- 5249fe53; Napoleon e3bec770). When a section is re-based, the stale overlay is marked
-- superseded_by the new one - but its integrity_flag rows still exist. The gate must NOT
-- count flags whose overlay is superseded: those flags reference text that is no longer
-- canonical, and counting them would keep external share blocked forever after a re-base.
-- Surfaced live on the S5 re-base (overlay a2dd41d1 -> d89facf7): the old overlay's 2
-- flags would have persisted; joining synthesis_overlay and filtering superseded_by IS
-- NULL drops them correctly. The flags remain as history; they simply stop counting.
-- Complements the write-time enforcement in Connie's canonical-model schema work.
-- ============================================================================

create or replace function public.dossier_integrity_gate(p_dossier_instance_id uuid)
  returns table(total_flags int, unresolved int, escalations int, curation_required int, blocks_external_share boolean)
  language sql stable security definer set search_path to 'public','pg_temp'
as $$
  select
    count(*)::int as total_flags,
    count(*) filter (
      where f.resolution_status is null
         or (f.resolution_status = 'resolved_routed_to_curation' and f.routed_curation_log_id is null)
    )::int as unresolved,
    count(*) filter (where f.escalation)::int as escalations,
    count(*) filter (where f.flag_type = 'curation_required')::int as curation_required,
    (count(*) filter (
      where f.resolution_status is null
         or (f.resolution_status = 'resolved_routed_to_curation' and f.routed_curation_log_id is null)
    ) > 0) as blocks_external_share
  from public.integrity_flag f
  join public.synthesis_overlay o on o.id = f.overlay_id
  where f.dossier_instance_id = p_dossier_instance_id
    and o.superseded_by is null;
$$;
