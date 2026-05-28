/* ── argos-gauge.js ── Load gauge (primary) + token budget readout (secondary) ── */
/*
  Primary indicator: weighted session load score, computed by the interface from
  SQL content in tool calls within each API response. Thresholds: 8 pts (primary)
  or 200K tokens consumed (fallback), whichever fires first.

  Score is computed here. It is not reported by Argos and not held in session memory.
  Score resets to zero at session start (see argos-session.js newSession/continueSession).

  Calibration note: the 8-point threshold is conservative, calibrated from a single
  test session (873572eb, 27 May 2026). Recalibrate from production sessions when
  sufficient data exists. Do not adjust without Reg instruction.

  DDL routing reminder: when routing DDL to Constantinople, include the current load
  score in the request body. (No enforcement possible here — code comment only.)
*/

var LOAD_THRESHOLD       = 8;
var LOAD_TOKEN_THRESHOLD = 200000;
var ARTIFACT_TABLES_RE   = /\b(wheel_posts|conference_responses|prime_messages)\b/i;
var SUPER_T_RE           = /\bsuper_t_chains\b/i;

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
  orientationCost      = getInputTokens(usage);
  currentContextTokens = orientationCost;
  renderTokenReadout();
}

function updateBudgetGauge(usage) {
  if (usage) {
    const t = getInputTokens(usage);
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
  const usedPct = Math.min(100, (currentContextTokens / LOAD_TOKEN_THRESHOLD) * 100);
  tokenFill.style.width = usedPct + '%';
  let colour;
  if      (usedPct < 60) colour = 'var(--bar-green)';
  else if (usedPct < 85) colour = 'var(--bar-amber)';
  else                   colour = 'var(--bar-red)';
  tokenFill.style.background = colour;
  const usedK    = Math.round(currentContextTokens / 1000);
  const ceilingK = Math.round(LOAD_TOKEN_THRESHOLD / 1000);
  tokenLabel.textContent = `~${usedK}K of ${ceilingK}K fallback`;
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

/* Classify an exchange by inspecting the SQL it issued.
   Rule order (per Activity Algorithm brief):
     1. Any write touching super_t_chains → Super-T retirement (terminal)
     2. ≥2 write statements                → compound (3pt)
     3. exactly 1 write + ≥1 SELECT        → write with verification (2pt)
     4. INSERT into artifact table, no SELECT → artifact production (1.5pt)
     5. SELECT-only                          → simple read (1pt)
     6. unknown                              → simple read (1pt)
*/
function classifyExchange(data) {
  const stmts = extractSqlStatements(data);
  let writes = 0, selects = 0, artifactInserts = 0, superTWrite = false;

  for (const raw of stmts) {
    const cleaned = stripSqlNoise(raw);
    const parts   = cleaned.split(';').map(p => p.trim()).filter(Boolean);
    for (const p of parts) {
      const isWrite  = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(p);
      const isSelect = /^\s*(SELECT|WITH)\b/i.test(p);
      const isInsert = /^\s*INSERT\b/i.test(p);
      if (isWrite && SUPER_T_RE.test(p))                 superTWrite = true;
      if (isWrite)                                       writes++;
      else if (isSelect)                                 selects++;
      if (isInsert && ARTIFACT_TABLES_RE.test(p))        artifactInserts++;
    }
  }

  if (superTWrite)                          return { kind: 'super_t',        score: 0,   terminal: true };
  if (writes >= 2)                          return { kind: 'compound',       score: 3   };
  if (writes === 1 && selects >= 1)         return { kind: 'write_verified', score: 2   };
  if (artifactInserts >= 1 && selects === 0)return { kind: 'artifact',       score: 1.5 };
  if (selects >= 1 && writes === 0)         return { kind: 'simple_read',    score: 1   };
  return { kind: 'simple_read', score: 1 };
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
    labelText  = 'Red — session threshold reached. File TP from this state.';
    labelClass = 'red';
  } else if (loadScore >= 5) {
    colour     = 'var(--bar-amber)';
    labelText  = 'Amber — complete in-flight work only. No new compound operations.';
    labelClass = 'amber';
  } else {
    colour     = 'var(--bar-green)';
    labelText  = orientationCost ? 'Green — capacity available.' : 'Waking…';
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
    /* Promote display state to red via the score path so threshold messaging stays consistent. */
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
