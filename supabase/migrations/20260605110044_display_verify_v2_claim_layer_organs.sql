-- Conf 089858ad D5 ratified (MR 1ad5b49e). v2 DDL wave: claim/citation layer.
-- Filed by constantinople, 5 Jun 2026. Specimen-informed: synthesis b6a9774b.
-- Repo copy filed by hephaestus 5 Jun 2026 (Argos clone-readiness invariant);
-- already applied live, this is the versioned source of record.

-- 1. Questions become rows: the navigation spine and the gap's home.
CREATE TABLE research_question (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theo_session_id uuid NOT NULL REFERENCES theo_session(id) ON DELETE CASCADE,
  question_index integer NOT NULL,
  question_text text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','answered','gap','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (theo_session_id, question_index)
);

-- 2. Claims become rows: load-bearing sourced claims, not every sentence.
--    claim_status per ratified enum; scope + divergence lifecycle are
--    specimen-driven (b6a9774b: within-engine vs cross-engine convergence;
--    resolved vs open divergences carrying a resolution narrative).
CREATE TABLE synthesis_claim (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  synthesis_id uuid NOT NULL REFERENCES synthesis(id) ON DELETE CASCADE,
  section_id uuid REFERENCES synthesis_section(id) ON DELETE SET NULL,
  question_id uuid REFERENCES research_question(id),
  claim_text text NOT NULL,
  claim_status text NOT NULL
    CHECK (claim_status IN ('convergent','divergent','single_source','synthesis_inference','gap')),
  scope text,
  divergence_status text CHECK (divergence_status IN ('open','resolved')),
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN synthesis_claim.scope IS
  'Convergence texture, specimen-driven: e.g. multi-source-within-engine, cross-engine-complementary, cross-engine-corroborated. Free text in v1; tighten to enum when usage settles.';

-- 3. Claim-to-source junction: citation-grade provenance, drives descend-to-raw.
CREATE TABLE claim_source (
  claim_id uuid NOT NULL REFERENCES synthesis_claim(id) ON DELETE CASCADE,
  dispatch_id uuid NOT NULL REFERENCES engine_dispatch(id),
  stance text NOT NULL CHECK (stance IN ('supports','diverges')),
  PRIMARY KEY (claim_id, dispatch_id)
);

-- 4. The truth layer as a relation (Reg, D2 level 5; Argos resolution enum, D3).
--    source_date is load-bearing: claim-date vs source-date checking caught two
--    real errors in the first exercised session.
CREATE TABLE claim_citation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES synthesis_claim(id) ON DELETE CASCADE,
  dispatch_id uuid REFERENCES engine_dispatch(id),
  url text,
  title text,
  source_date date,
  resolution text NOT NULL DEFAULT 'unchecked'
    CHECK (resolution IN ('unchecked','resolved','dead','mismatched')),
  resolved_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Coverage signal: derived, worker-extracted, re-derivable, never authoritative.
ALTER TABLE engine_dispatch ADD COLUMN source_count integer;
COMMENT ON COLUMN engine_dispatch.source_count IS
  'DERIVED at write time by worker from citations inside response_raw. Re-derivable; response_raw remains authoritative.';

-- 6. Typed sections (Theo D5: comparison output home, smallest-thing route).
ALTER TABLE synthesis_section ADD COLUMN section_type text NOT NULL DEFAULT 'synthesis'
  CHECK (section_type IN ('synthesis','comparison'));

-- Indexes for the render path.
CREATE INDEX idx_synthesis_claim_synthesis ON synthesis_claim(synthesis_id);
CREATE INDEX idx_synthesis_claim_question ON synthesis_claim(question_id);
CREATE INDEX idx_claim_citation_claim ON claim_citation(claim_id);
CREATE INDEX idx_research_question_session ON research_question(theo_session_id);

-- RLS posture: match the synthesis family — enabled, deny-all until the
-- exposure decision is made deliberately (claim layer will face outward one day).
ALTER TABLE research_question ENABLE ROW LEVEL SECURITY;
ALTER TABLE synthesis_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_citation ENABLE ROW LEVEL SECURITY;
