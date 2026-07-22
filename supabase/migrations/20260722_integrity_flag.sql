-- ============================================================================
-- integrity_flag - the per-sentence output of the integrity pass (Heph).
-- ----------------------------------------------------------------------------
-- Baton clarev/integrity-pass 66bd5a5b (Napoleon). Built to Aegis ruling 827cdc7e.
-- The integrity pass re-grounds EDITED PROSE against the CLAIMS it rests on and
-- FLAGS any sentence that asserts more than the grounded record supports - the
-- interrogate trace, one layer over. It is FLAG-ONLY (Aegis ruling 1, standing
-- constraint): the pass IDENTIFIES, a human DECIDES. There is no auto-correct mode.
--
-- WHY A PER-SENTENCE TABLE (not just synthesis_overlay.resolution_status):
-- Connie put resolution_status + integrity_flag_count + integrity_checked_at ON
-- synthesis_overlay (the rollup). But Aegis ruling 2 requires the editor to face
-- and decide EACH flagged sentence, so resolution is per-FLAG. This table is the
-- per-sentence detail; synthesis_overlay.integrity_flag_count is its rollup, and
-- dossier_integrity_gate() below is the "N flagged, K unresolved" share-gate that
-- feeds dossier_composition.
--
-- FLAG TYPES (Aegis ruling 3 + confirmation 1) - reuse the interrogate trace
-- distinction, do NOT invent a parallel taxonomy:
--   * model_voice        - editorial narration / framing / opinion; not a claim
--                          about the world. Informational; does not block share.
--   * ungrounded_claim   - prose asserts a fact no section claim supports.
--       -> escalation (named sub-type, HIGHEST priority): source language SOFTENED,
--          output HARDENED, AND the hardening is not supported by a grounded claim.
--          Detected on the original->edited DIFF, gated by grounding - so a
--          legitimately hard, GROUNDED word (SBTi genuinely "prohibits", Verra
--          genuinely "rejected") does NOT flag. That grounding gate IS the
--          attributed/rule-setting exemption.
--   * curation_required  - assert-boundary violation (Aegis confirmation 1, HIGHEST
--          SEVERITY, NON-OVERRIDABLE): the edit changed what a CLAIM ASSERTS about a
--          named entity/event/finding/position. Cannot be resolved as opinion; must
--          route to operator_curation_log or be reverted.
--
-- RESOLUTION (Aegis ruling 2): an UNRESOLVED flag (resolution_status null)
-- HARD-BLOCKS external share; a RESOLVED one does not. resolved_routed_to_curation
-- is NOT resolution until the operator_curation_log act completes (routed != resolved).
-- ============================================================================

create table if not exists public.integrity_flag (
  id                     uuid primary key default gen_random_uuid(),
  overlay_id             uuid not null references public.synthesis_overlay(id) on delete cascade,
  dossier_instance_id    uuid not null,                 -- denormalised for the share-gate count
  section_id             uuid,                          -- copied from the overlay, for locating in the render
  sentence               text not null,                 -- the flagged sentence, VERBATIM from edited_content_md
  sentence_index         int,                           -- ordinal position of the sentence in the edited prose
  flag_type              text not null
                           check (flag_type in ('ungrounded_claim','model_voice','curation_required')),
  escalation             boolean not null default false,-- named sub-type of ungrounded_claim (Aegis ruling 3)
  escalation_pattern     text,                          -- which softened->hardened pattern matched, e.g. 'not endorsed -> prohibited'
  rests_on_claim_ids     uuid[],                        -- the section claim(s) it should rest on; null/empty = ABSENCE (no claim)
  gap                    text not null,                 -- the SPECIFIC gap: what the sentence asserts beyond the record
  priority               int  not null default 100,     -- lower = higher priority; escalation + curation_required rank first
  -- resolution flow (Aegis ruling 2). null = UNRESOLVED = hard-blocks external share.
  resolution_status      text
                           check (resolution_status is null or resolution_status in
                             ('resolved_reworded','resolved_accepted_as_opinion','resolved_routed_to_curation')),
  resolved_by            text,
  resolved_at            timestamptz,
  resolution_note        text,
  routed_curation_log_id uuid references public.operator_curation_log(id),  -- set on resolved_routed_to_curation; the completing act
  pass_run_id            uuid,                           -- groups all flags from one pass invocation (for re-run supersede)
  created_at             timestamptz not null default now(),

  -- INVARIANT (Aegis confirmation 1): a curation_required flag is NOT resolvable as opinion. The closed back-door.
  constraint curation_required_not_opinion
    check (not (flag_type = 'curation_required' and resolution_status = 'resolved_accepted_as_opinion')),
  -- escalation is a sub-type of ungrounded_claim ONLY.
  constraint escalation_only_on_ungrounded
    check (not escalation or flag_type = 'ungrounded_claim'),
  -- routed resolution must name the curation act it routed to.
  constraint routed_names_curation
    check (resolution_status is distinct from 'resolved_routed_to_curation' or routed_curation_log_id is not null)
);

create index if not exists integrity_flag_overlay_idx  on public.integrity_flag (overlay_id);
create index if not exists integrity_flag_dossier_idx  on public.integrity_flag (dossier_instance_id);
create index if not exists integrity_flag_unresolved_idx
  on public.integrity_flag (dossier_instance_id) where resolution_status is null;

comment on table public.integrity_flag is
  'Per-sentence output of the integrity pass (baton 66bd5a5b, Aegis spec 827cdc7e). Flag-only; unresolved hard-blocks share. Heph 22 Jul 2026.';

-- RLS deny-all (house pattern): only the service-role pass EF + SECURITY DEFINER RPCs touch it.
alter table public.integrity_flag enable row level security;

-- ----------------------------------------------------------------------------
-- SHARE-GATE (Aegis ruling 2): "N flagged, K unresolved" for dossier_composition.
-- EFFECTIVE-UNRESOLVED = resolution_status is null
--   OR (routed to curation but the completing act has not landed yet - routing != resolved).
-- blocks_external_share = (effective-unresolved count > 0).
-- ----------------------------------------------------------------------------
create or replace function public.dossier_integrity_gate(p_dossier_instance_id uuid)
  returns table(total_flags int, unresolved int, escalations int, curation_required int, blocks_external_share boolean)
  language sql stable security definer set search_path to 'public','pg_temp'
as $$
  select
    count(*)::int as total_flags,
    count(*) filter (
      where resolution_status is null
         or (resolution_status = 'resolved_routed_to_curation' and routed_curation_log_id is null)
    )::int as unresolved,
    count(*) filter (where escalation)::int as escalations,
    count(*) filter (where flag_type = 'curation_required')::int as curation_required,
    (count(*) filter (
      where resolution_status is null
         or (resolution_status = 'resolved_routed_to_curation' and routed_curation_log_id is null)
    ) > 0) as blocks_external_share
  from public.integrity_flag
  where dossier_instance_id = p_dossier_instance_id;
$$;

comment on function public.dossier_integrity_gate is
  'Share-gate counts for a dossier: total/unresolved/escalations/curation_required + blocks_external_share. Unresolved (incl. routed-not-yet-completed) hard-blocks external share (Aegis 827cdc7e ruling 2).';
