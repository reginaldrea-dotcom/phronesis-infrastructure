// Concise schema reference injected into the system prompt so execute_sql uses real
// column names instead of guessing — the root cause of the "narration" failure
// (guessed columns → SQL errors → loop truncation). Column names verified against
// information_schema (30 May 2026; wake_deltas / instructions / idempotency_keys,
// the prime_messages allowed-values, and the ids-are-table-scoped rule added 1 Jun
// 2026 to remove the wrong-table-lookup tax). Keep this in sync if the schema changes.

export const SCHEMA_REFERENCE = `DATABASE SCHEMA — use these exact column names with execute_sql; do not guess:

- super_t_chains: id, lineage_name, sequence_number, instance_id, tp_artifact_id, successor_id, created_at
- artifacts: id, instance_id, title, artifact_type (enum), content, drive_file_id, drive_path, metadata (jsonb), created_at
- conferences (metadata only — the synthesis is NOT in this table): id, topic, body, called_by, status, invited_lineages (array), current_round, created_at, updated_at, conference_type (enum), synthesis_open_at, synthesist_lineage
- conference_responses (conference synthesis/decisions live here): id, conference_id, posting_lineage, posting_instance_id, round, summary, body, created_at
- prime_messages: id, from_lineage, from_instance_id, to_lineage, to_instance_id, subject, body, message_type, related_ids (array), status, attention_level, created_at, delivered_at, acknowledged_at
    · message_type is TEXT + CHECK (NOT an enum), one of: nf | mr_draft | request | response | status | schema_proposal | broadcast  (or null)
    · status one of: pending | delivered | acknowledged    · attention_level one of: low | moderate | urgent
- wake_deltas (wake notes addressed to you from other Primes — these live HERE, NOT in prime_messages): id, to_lineage, from_lineage, note, consumed_at, created_at
    · your unconsumed deltas: WHERE to_lineage = '<your lineage>' AND consumed_at IS NULL
- instructions (the active suit, one per lineage): id, lineage_name, version, content, is_active, notes, created_at   (exactly one is_active=true row per lineage)
- idempotency_keys: request_id (PK), status, status_code, response, created_at, updated_at
- wheel_posts: id, posting_lineage, posting_instance_id, post_type, topic, body, relevance_scope (array), initial_attention_level, effective_attention_level, expires_at, created_at, superseded_at, reg_acknowledged_at
- current_priorities: id, topic, summary, written_by_lineage, written_by_instance_id, status, attention_level, related_ids (array), created_at, confirmed_at, superseded_at, superseded_by

IDS ARE TABLE-SCOPED. Every id belongs to exactly ONE table; an id from one table will not resolve in another (a prime_messages.id is not an artifacts.id, a conference_id, or a wake_deltas.id). Before concluding a row is missing, confirm you are querying the table the id actually belongs to — an empty result is far more often a wrong-table lookup than a missing row.

PREFER PURPOSE-BUILT READ TOOLS over hand-rolled SQL — they target the right table for you and scope to you:
- your unconsumed wake_deltas → read_wake_deltas
- your unread inbox (prime_messages to you) → read_inbox
- a specific message you hold an id for → get_message(id)
- a conference's ratified synthesis → get_conference_result(conference_id)
Reach for execute_sql only for reads these don't cover.`;
