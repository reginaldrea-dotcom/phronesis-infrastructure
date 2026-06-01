/* ── connie-gauge.js ── Load gauge (primary) + token budget readout (secondary) ── */
/*
  Primary indicator: weighted session load score, computed by the interface from
  tool calls within each API response. The load gauge is an ADVISORY backstop (40 pts);
  the real capacity guard is the token meter, set to the session budget
  (PRIME_CONFIG.sessionBudget, ~500K). Real model window is ~1M — neither is a hard
  limit at normal session lengths. Both are now also fed back to the Prime (EF inject)
  as evidence for its own retirement judgement, NOT as a trigger.

  Score is computed here. It is not reported by Constantinople and not held in
  session memory. Score resets to zero at session start
  (see connie-session.js newSession/continueSession).

  Calibration note: load threshold is 40 (amber 28) as of 1 Jun 2026 — raised from 16
  on Reg's authority after evidence showed even a 21-turn session uses ~5% of the 1M
  window, so the old gauge fired far too early. Conversation scores 0 (tool activity
  only). The gauge is advisory; retirement is the Prime's judgement, sharpened by the
  fed-back meter, not made by it.

  DDL routing reminder: when routing DDL to Constantinople, include the current load
  score in the request body. (Self-reference for Constantinople — informational only.)
*/

var LOAD_THRESHOLD       = 40;   // advisory backstop (raised from 16, 1 Jun 2026)
var LOAD_AMBER           = 28;   // advisory "consider checkpointing soon"
var LOAD_TOKEN_THRESHOLD = (typeof PRIME_CONFIG !== 'undefined' && PRIME_CONFIG.sessionBudget) || 500000;  // single source: PRIME_CONFIG.sessionBudget (500K). Real model window ~1M — this is a working budget, not the capacity limit.
var ARTIFACT_TABLES_RE   = /\b(wheel_posts|conference_responses|prime_messages)\b/i;
var SUPER_T_RE           = /\bsuper_t_chains\b/i;

/* ── Drive tool classifier ────────────────────────────────────────────────────
   Constantinople will, once the edge function is extended with MCP servers,
   call Drive tools whose exact names come from the Drive MCP server (currently
   unknown — Step 5 says: "Check actual Drive tool names from data.tool_uses in
   the edge function response — use whatever names appear there, not assumed
   names."). Until then, the classifier matches by keyword heuristic so it
   activates the moment Drive tool_use blocks appear, and so the patterns are
   easy to tighten with one edit once real names are observed.
*/
function classifyDriveTool(toolName) {
  if (!toolName) return null;
  const n = String(toolName).toLowerCase();
  const isDrive = /(?:^|[_-])drive|gdrive|google[_-]?drive/.test(n);
  if (!isDrive) return null;
  if (/delete|trash|remove/.test(n))                                      return 'delete';
  if (/create|rename|move|update|upload|copy|new[_-]?file|new[_-]?folder/.test(n)) return 'write';
  if (/search|list|get|read|find|fetch|metadata|files?\b|folder\b/.test(n)) return 'read';
  return null;
}

/* ── Token-budget helpers (secondary readout) ── */

function getInputTokens(usage) {
  if (!usage) return 0;
  if (usage.total_input_tokens != null) return usage.total_input_tokens;
  const uncached    = usage.input_tokens          ?? 0;
  const cacheCreate = usage.cache_creation_tokens ?? 0;
  const cacheRead   = usage.cache_read_tokens     ?? 0;
  if (uncached + cacheCreate + cacheRead > 0) return uncached + cacheCreate + cacheRead;
  return Math.max(0, (usage.total_tokens || 0) - (usage.output_tokens || 0));
}

function captureOrientationCost(usage) {
  orientationCost      = (usage && usage.context_tokens != null) ? usage.context_tokens : getInputTokens(usage);
  currentContextTokens = orientationCost;
  renderTokenReadout();
}

function updateBudgetGauge(usage) {
  if (usage) {
    // Prefer the EF's true context figure (final-call input); the older summed
    // estimate (getInputTokens) overstates ~2x and is only a fallback now.
    const t = (usage.context_tokens != null) ? usage.context_tokens : getInputTokens(usage);
    if (t > currentContextTokens) currentContextTokens = t;
  }
  renderTokenReadout();
  evaluateThresholds();
}

function renderTokenReadout() {
  if (!orientationCost) {
    tokenFill.style.width  = '0%';
    tokenLabel.textContent = 'Waking…';
    tokenLabel.className   = 'token-bar-label';
    return;
  }
  const usedPct      = Math.min(100, (currentContextTokens / LOAD_TOKEN_THRESHOLD) * 100);
  const remainingPct = Math.max(0, 100 - usedPct);
  tokenFill.style.width = remainingPct + '%';
  let colour;
  if      (remainingPct > 50) colour = 'var(--bar-green)';
  else if (remainingPct > 30) colour = 'var(--bar-amber)';
  else                        colour = 'var(--bar-red)';
  tokenFill.style.background = colour;
  const remainingK = Math.max(0, Math.round((LOAD_TOKEN_THRESHOLD - currentContextTokens) / 1000));
  const ceilingK   = Math.round(LOAD_TOKEN_THRESHOLD / 1000);
  tokenLabel.textContent = `~${remainingK}K of ${ceilingK}K remaining`;
  tokenLabel.className   = 'token-bar-label';
}

/* ── Load-score gauge (primary) ── */

/* Extract SQL strings from any tool-use-like field on the API response.
   The shape varies — we look at common carriers and pull any string that
   contains SQL keywords. False positives are acceptable; the classifier
   is keyword-based and tolerant. */
function extractSqlStatements(data) {
  const stmts = [];
  const SQL_HINT = /\b(select|insert|update|delete|with)\b/i;
  const consider = v => {
    if (typeof v === 'string' && SQL_HINT.test(v)) stmts.push(v);
  };
  const visit = obj => {
    if (!obj || typeof obj !== 'object') return;
    const input = obj.input || obj.arguments || obj.parameters;
    if (typeof input === 'string') { consider(input); return; }
    if (input && typeof input === 'object') {
      if (typeof input.sql       === 'string') { consider(input.sql);       return; }
      if (typeof input.query     === 'string') { consider(input.query);     return; }
      if (typeof input.statement === 'string') { consider(input.statement); return; }
      Object.values(input).forEach(v => { if (typeof v === 'string') consider(v); });
    }
  };
  const carriers = [data?.tool_uses, data?.tool_calls, data?.tools, data?.tool_results];
  for (const c of carriers) if (Array.isArray(c)) c.forEach(visit);
  const blocks = data?.content || data?.raw_response?.content || data?.message?.content;
  if (Array.isArray(blocks)) blocks.forEach(b => { if (b && b.type === 'tool_use') visit(b); });
  return stmts;
}

/* Strip comments and string literals so keywords inside them don't fool the classifier. */
function stripSqlNoise(s) {
  return s
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

/* Classify an exchange by inspecting tool calls and the SQL they issued.

   Rule order (Activity Algorithm + Connie extensions, highest weight wins for
   mixed exchanges):

     RULE 0  apply_migration tool present       → compound (3pt). DDL is always
                                                  high-stakes substrate work.
     RULE 1  Any SQL write touching super_t_chains → Super-T retirement (terminal)
     RULE 2  ≥2 SQL writes  OR  ≥2 Drive writes  OR  any Drive delete → compound (3pt)
     RULE 3  exactly 1 SQL write + ≥1 SELECT   OR  exactly 1 Drive write
                                                  → write with verification (2pt)
     RULE 4  SQL INSERT into artifact table, no SELECT → artifact production (1.5pt)
     RULE 5  SELECT-only  OR  Drive read       → simple read (1pt)
     RULE 6  a non-SQL tool ran (read_wake_deltas, deliver_artefact, github, …) → light work (1pt)
     RULE 7  no tool ran at all (pure conversation) → NO LOAD (0pt). Talk is not substrate
             work; only real tool/SQL activity moves the gauge. Conversational context
             growth is caught by the token gauge, not here. (Reg, 1 Jun 2026 — the gauge
             was firing too early and reading as anxiety because every exchange scored ≥1.)
*/
function classifyExchange(data) {
  const toolUses = Array.isArray(data?.tool_uses) ? data.tool_uses : [];

  // Rule 0: apply_migration → 3pt regardless of statement count.
  const hasApplyMigration = toolUses.some(t => t && t.name === 'apply_migration');

  // SQL accounting
  const stmts = extractSqlStatements(data);
  let writes = 0, selects = 0, artifactInserts = 0, superTWrite = false;
  for (const raw of stmts) {
    const cleaned = stripSqlNoise(raw);
    const parts   = cleaned.split(';').map(p => p.trim()).filter(Boolean);
    for (const p of parts) {
      const isWrite  = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(p);
      const isSelect = /^\s*(SELECT|WITH)\b/i.test(p);
      const isInsert = /^\s*INSERT\b/i.test(p);
      if (isWrite && SUPER_T_RE.test(p))           superTWrite = true;
      if (isWrite)                                  writes++;
      else if (isSelect)                            selects++;
      if (isInsert && ARTIFACT_TABLES_RE.test(p))   artifactInserts++;
    }
  }

  // Drive accounting (dormant until edge function declares Drive MCP)
  let driveReads = 0, driveWrites = 0, driveDeletes = 0;
  for (const t of toolUses) {
    const kind = classifyDriveTool(t && t.name);
    if      (kind === 'read')   driveReads++;
    else if (kind === 'write')  driveWrites++;
    else if (kind === 'delete') driveDeletes++;
  }

  // Terminal: Super-T write
  if (superTWrite) return { kind: 'super_t', score: 0, terminal: true };

  // Compute candidate scores per matching rule, pick the highest.
  const candidates = [];
  if (hasApplyMigration)                         candidates.push({ kind: 'apply_migration',  score: 3   });
  if (writes >= 2)                               candidates.push({ kind: 'compound',          score: 3   });
  if (driveDeletes >= 1)                         candidates.push({ kind: 'drive_delete',      score: 3   });
  if (driveWrites >= 2)                          candidates.push({ kind: 'drive_compound',    score: 3   });
  if (writes === 1 && selects >= 1)              candidates.push({ kind: 'write_verified',    score: 2   });
  if (driveWrites === 1)                         candidates.push({ kind: 'drive_write',       score: 2   });
  if (artifactInserts >= 1 && selects === 0)     candidates.push({ kind: 'artifact',          score: 1.5 });
  if (selects >= 1 && writes === 0)              candidates.push({ kind: 'simple_read',       score: 1   });
  if (driveReads >= 1)                           candidates.push({ kind: 'drive_read',        score: 1   });

  if (candidates.length === 0) return toolUses.length > 0 ? { kind: 'tool_light', score: 1 } : { kind: 'none', score: 0 };
  return candidates.reduce((max, c) => c.score > max.score ? c : max);
}

/* Update load score after an exchange completes. Score updates AFTER the exchange,
   never mid-exchange — caller invokes this once per completed API response. */
function updateLoadGauge(data) {
  if (!data || loadTerminal) { renderLoadGauge(); return; }
  const c = classifyExchange(data);
  if (c.terminal) {
    loadTerminal = true;
  } else {
    loadScore += c.score;
  }
  renderLoadGauge();
}

/* Current advisory band — sent to the EF so the model sees the same colour Reg does. */
function currentLoadBand() {
  if (loadTerminal) return 'closed';
  if (loadScore >= LOAD_THRESHOLD) return 'red';
  if (loadScore >= LOAD_AMBER) return 'amber';
  return 'green';
}

function renderLoadGauge() {
  if (!loadFill) return;
  const display = Math.min(loadScore, LOAD_THRESHOLD);
  const pct     = (display / LOAD_THRESHOLD) * 100;
  loadFill.style.width = pct + '%';

  const scoreStr = (loadScore % 1 === 0) ? loadScore.toFixed(0) : loadScore.toFixed(1);
  loadScoreEl.textContent = `${scoreStr} / ${LOAD_THRESHOLD}`;

  let colour, labelText, labelClass;
  if (loadTerminal) {
    colour     = 'var(--bar-red)';
    labelText  = 'Super-T written — session closed.';
    labelClass = 'terminal';
  } else if (loadScore >= LOAD_THRESHOLD) {
    colour     = 'var(--bar-red)';
    labelText  = 'Red — long session. A clean checkpoint is overdue — your call, at a natural break.';
    labelClass = 'red';
  } else if (loadScore >= LOAD_AMBER) {
    colour     = 'var(--bar-amber)';
    labelText  = 'Amber — consider checkpointing soon, at a clean break. Advisory, not a stop.';
    labelClass = 'amber';
  } else {
    colour     = 'var(--bar-green)';
    labelText  = orientationCost ? 'Green — ample room.' : 'Waking…';
    labelClass = '';
  }
  loadFill.style.background = colour;
  loadLabel.textContent     = labelText;
  loadLabel.className       = 'load-gauge-label' + (labelClass ? ' ' + labelClass : '');
}

/* Fallback threshold: also fire amber/red when token usage crosses 200K, regardless of score. */
function evaluateThresholds() {
  if (loadTerminal) return;
  if (currentContextTokens >= LOAD_TOKEN_THRESHOLD && loadScore < LOAD_THRESHOLD) {
    loadScore = Math.max(loadScore, LOAD_THRESHOLD);
    renderLoadGauge();
  }
}

function resetGauge() {
  orientationCost      = 0;
  currentContextTokens = 0;
  loadScore            = 0;
  loadTerminal         = false;
  if (tokenFill) {
    tokenFill.style.width      = '0%';
    tokenFill.style.background = 'var(--bar-green)';
    tokenLabel.textContent     = 'Waking…';
    tokenLabel.className       = 'token-bar-label';
  }
  if (loadFill) {
    loadFill.style.width      = '0%';
    loadFill.style.background = 'var(--bar-green)';
    loadScoreEl.textContent   = '0 / ' + LOAD_THRESHOLD;
    loadLabel.textContent     = 'Waking…';
    loadLabel.className       = 'load-gauge-label';
  }
}
