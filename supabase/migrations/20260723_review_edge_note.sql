-- Evidence review surface (Eames SP 57480e66 / build order 6d3d1c68). The review trio
-- (review_state, reviewed_by, reviewed_at) already exists on element_dependency; the only gap is
-- somewhere to record a REJECT's reason. review_note is that home — nullable, additive, no contention.
-- review_state stays unconstrained text (values in use: pending/not_required, adding accepted/rejected).
alter table element_dependency add column if not exists review_note text;
comment on column element_dependency.review_note is
  'Reviewer''s reason on a rejected edge (Eames 57480e66). The verdict lives in review_state=rejected; this is the why. Null for accepted/pending.';
