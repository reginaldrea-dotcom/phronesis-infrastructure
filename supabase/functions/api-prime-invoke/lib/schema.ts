// Concise schema reference injected into the system prompt so execute_sql uses real
// column names instead of guessing — the root cause of the "narration" failure
// (guessed columns → SQL errors → loop truncation). Column names verified against
// information_schema (30 May 2026). Keep this in sync if the schema changes.

export const SCHEMA_REFERENCE = `DATABASE SCHEMA — use these exact column names with execute_sql; do not guess:

- super_t_chains: id, lineage_name, sequence_number, instance_id, tp_artifact_id, successor_id, created_at
- artifacts: id, instance_id, title, artifact_type (enum), content, drive_file_id, drive_path, metadata (jsonb), created_at
- conferences (metadata only — the synthesis is NOT in this table): id, topic, body, called_by, status, invited_lineages (array), current_round, created_at, updated_at, conference_type (enum), synthesis_open_at, synthesist_lineage
- conference_responses (conference synthesis/decisions live here): id, conference_id, posting_lineage, posting_instance_id, round, summary, body, created_at
- prime_messages: id, from_lineage, from_instance_id, to_lineage, to_instance_id, subject, body, message_type, related_ids (array), status, attention_level, created_at, delivered_at, acknowledged_at
- wheel_posts: id, posting_lineage, posting_instance_id, post_type, topic, body, relevance_scope (array), initial_attention_level, effective_attention_level, expires_at, created_at, superseded_at, reg_acknowledged_at
- current_priorities: id, topic, summary, written_by_lineage, written_by_instance_id, status, attention_level, related_ids (array), created_at, confirmed_at, superseded_at, superseded_by

To read a conference's ratified synthesis, prefer the get_conference_result tool over composing SQL by hand.`;
