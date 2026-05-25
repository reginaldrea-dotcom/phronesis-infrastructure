/* ── argos-gauge.js ── Working budget gauge (Napoleon D2.4) ── */
/*
   orientationCost  = input tokens consumed at wake (system prompt + Super-T + preloads)
   Working budget   = sessionBudget - orientationCost
   Gauge shows remaining working budget. Starts full after wake, depletes with conversation.
   Green > 50%, amber 30–50%, red < 30%.
*/

function getInputTokens(usage) {
  if (!usage) return 0;
  // Use total_input_tokens if available (uncached + cache_creation + cache_read)
  if (usage.total_input_tokens != null) return usage.total_input_tokens;
  // Sum components if returned separately
  const uncached    = usage.input_tokens          ?? 0;
  const cacheCreate = usage.cache_creation_tokens ?? 0;
  const cacheRead   = usage.cache_read_tokens     ?? 0;
  if (uncached + cacheCreate + cacheRead > 0) return uncached + cacheCreate + cacheRead;
  // Last resort
  return Math.max(0, (usage.total_tokens || 0) - (usage.output_tokens || 0));
}

function captureOrientationCost(usage) {
  orientationCost      = getInputTokens(usage);
  currentContextTokens = orientationCost;
  renderBudgetGauge();
}

function updateBudgetGauge(usage) {
  if (usage) currentContextTokens += (usage.output_tokens || 0);
  renderBudgetGauge();
}

function renderBudgetGauge() {
  if (!orientationCost) {
    tokenFill.style.width = '0%';
    tokenLabel.textContent = 'Waking\u2026';
    tokenLabel.className   = 'token-bar-label';
    return;
  }

  const workingBudget    = Math.max(1, PRIME_CONFIG.sessionBudget - orientationCost);
  const conversationUsed = Math.max(0, currentContextTokens - orientationCost);
  const remainingTokens  = Math.max(0, workingBudget - conversationUsed);
  const remainingPct     = Math.min(100, (remainingTokens / workingBudget) * 100);

  tokenFill.style.width = remainingPct + '%';

  let colour, labelClass;
  if (remainingPct > 50)      { colour = 'var(--bar-green)'; labelClass = ''; }
  else if (remainingPct > 30) { colour = 'var(--bar-amber)'; labelClass = 'amber'; }
  else                        { colour = 'var(--bar-red)';   labelClass = 'red'; }
  tokenFill.style.background = colour;

  const remainK = Math.round(remainingTokens / 1000);
  const budgetK = Math.round(workingBudget / 1000);
  tokenLabel.textContent = `~${remainK}K of ${budgetK}K working budget`;
  tokenLabel.className   = 'token-bar-label' + (labelClass ? ' ' + labelClass : '');

  if (remainingPct <= 30 && !retirementShown) {
    retirementShown = true;
    renderRetirementPrompt();
  }
}

function resetGauge() {
  orientationCost      = 0;
  currentContextTokens = 0;
  tokenFill.style.width      = '0%';
  tokenFill.style.background = 'var(--bar-green)';
  tokenLabel.textContent     = 'Waking\u2026';
  tokenLabel.className       = 'token-bar-label';
}
