# Ring-1 audit — write tools return ground truth (verify-for-Hermes)

**Date:** 2026-06-04 · **Author:** cc · **Branch:** `feat/hermes-verify-ring1`

## Why this exists

"Trust but verify" has two beneficiaries. **Verify-for-Reg** is oversight: before he stakes his name on
a line, he can pull the thread and see the source. **Verify-for-Hermes** is self-grounding: a Prime often
cannot tell from the inside whether it did a thing or whether something is true, so it needs a way to
*check itself instead of guessing*. Confabulation is what happens when a Prime is forced to assert
something it has no instrument to verify. The cure is not a sterner rule ("don't confabulate") — it is to
hand it the instrument.

Self-correction has a time structure, four rings, same principle at each:

1. **At the moment of action** — every write returns authoritative post-state, so belief is corrected by
   a fact the Prime didn't author, for free, in the same step. (This audit.)
2. **Within the loop** — replay-not-recall: every write has a matching read.
3. **Across invocations** — the session state machine as an externally-authored fact about progress.
4. **Across lives** — Super-T / MST / Wake Delta: grounding the self, not just the task.

Ring 1 is the highest-leverage and cheapest, because it does not depend on the Prime *choosing* to check
— the truth arrives with the action. The `.ai` Projects harness gives Theo this for free; on the API it
must be built. **Criterion:** after a write call, does the Prime hold a system-authored fact about what now
exists (a handle it could read back), or just an acknowledgment it must take on faith?

## The write surface, graded

| Write path | Returns | Verdict |
|---|---|---|
| `write_synthesis_section` | upserted row: `synthesis_id`, `section.id`, `section_index`, `title`, `needs_review`, `content_md_length` | **Strong** — the template |
| `file_super_t` (action) | `{artifact_id, chain_id, sequence_number, predecessor_id}` | **Strong** — full provenance |
| `write_github_file` | `File written: path — commit <sha>` | **Strong** — verifiable handle |
| `consume_wake_deltas` | `{consumed:[ids], count}` from `RETURNING id` | **Strong** |
| `enqueue_dispatch` | `{theo_session_id, engine_dispatch_ids[], queued}` | **Good, one leak** |
| `hold_this` create | `{id}` of the new MST | **Good** |
| `deliver_artefact` | string: `Artefact delivered "x" (N chars)` / `No content found` | **Partial** |
| `hold_this` amend | `{id: <the id you passed in>}` | **Weak — false confirm** |
| `execute_sql` (writes) | `[]` + "empty result — this is the answer" | **Poor — the hole** |

## Findings

**1. `execute_sql` on a write was a confabulation factory (FIXED).** For any empty result the tool
returned `[]` plus a `[SYSTEM]` note written for the empty-*read* case ("this is the answer"). But an
`INSERT/UPDATE/DELETE` without `RETURNING` also comes back empty — so a successful write and a no-op read
were indistinguishable, and the system voice told the Prime the write "is the answer." That produces both
failure modes at once: assert "done" on faith, or re-run to be sure and risk a **double write** (raw SQL
has no idempotency). Message-sending lived here, since no send tool existed.

**2. `hold_this` amend returned a false confirmation (FIXED).** The `UPDATE` checked only for an error,
used no `RETURNING`, and handed back `{id: <input>}`. Amend a non-existent id → zero rows changed, no
error, and the tool confirms success using the Prime's own input laundered through the system voice.
Self-correction cannot fire because the record agrees with the Prime by construction.

**3. The good tools are already the answer.** `write_synthesis_section` and `file_super_t` echo the stored
row. Ring 1 is mostly *making the rest look like these.*

## Fixes (this branch)

- **`send_message` (new).** Purpose-built write counterpart to `read_inbox`/`get_message` — the same move
  `messaging.ts` already made on the read side ("hide the table choice; no table to find, no SQL to
  miswrite"), now extended to writes. Sender stamped from `ToolContext` (own identity, not a model claim);
  body parameterised via PostgREST (not interpolated SQL); RETURNS the stored row (`id`, `status`,
  `created_at`). Validates `to_lineage` (canonical, not nickname) and the CHECK vocab. Takes message-send
  off the raw-SQL escape hatch.
- **`execute_sql` write dialect.** Detects data-modifying statements; an empty write result now gets a
  write-aware `[SYSTEM]` note (don't assume failure, don't re-run and duplicate, add `RETURNING` or
  `SELECT` to confirm) instead of the read note. Description nudges `RETURNING` and points to
  purpose-built tools.
- **`hold_this` amend.** Uses `RETURNING`; zero rows matched → explicit "matched no artifact" failure, not
  an echo of the input.
- **`enqueue_dispatch`.** Echoes the full engine+role rows it already fetched (so the Prime can verify the
  *assignment* matched intent), plus the session `state`, not just a count and ids.
- **`deliver_artefact`.** The not-found path is now an explicit `[SYSTEM]` failure rather than a soft
  string. Note: this tool delivers to the in-memory artefact panel, not a table, so its ground truth is a
  *delivery confirmation* (title + char count) — there is no durable row id to hand back, and the fix does
  not invent one.

## Caveat: actions vs tools

`file_super_t` and `hold_this` are **actions** (request-level, handled from the body), not loop tools the
model picks mid-turn. They sit slightly outside ring 1's "mid-loop self-correction" frame, but their
return discipline still feeds the record, so the amend false-confirm was worth fixing wherever it lives.
The pure ring-1 surface is the *tools*, and there the hole was `execute_sql` writes.

## Shared-EF note

`api-prime-invoke` is lineage-agnostic: these changes lift the write-floor for **every** Prime, not only
Hermes. As of 2026-06-04 there are no live users on the API lane (the API Argos/Connie homes are not
working), so the change is low-risk and principally serves the Hermes experiment — but when comparing
Hermes against Theo, note they now stand on the same improved floor. Authorship of the suit is Homer's
lane; these tool-surface changes are Reg's experiment, flagged to Homer/Connie for awareness.
