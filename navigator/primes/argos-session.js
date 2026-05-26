/* ── argos-session.js — session management and invoke layer ──
   Depends on: argos-state.js, argos-config.js, argos-render.js, argos-gauge.js, argos-panel.js
   Functions: invoke, send, wake, continueWake, newSession, continueSession, triggerRetirement
*/

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── Invoke ── */
async function invoke(message, isWake = false, opts = {}) {
  const pCount = pinnedTurns.length;
  thinking.textContent = isWake ? `${PRIME_CONFIG.name} is waking\u2026`
    : pCount > 0 ? `${PRIME_CONFIG.name} is thinking\u2026 holding ${pCount} pinned turn${pCount!==1?'s':''}`
    : `${PRIME_CONFIG.name} is thinking\u2026`;
  thinking.classList.add('visible'); scrollBottom();
  let lastError = null;

  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    if (attempt > 0) {
      thinking.textContent = isWake ? `${PRIME_CONFIG.name} is waking\u2026 (retry ${attempt})` : `${PRIME_CONFIG.name} is thinking\u2026 (retry ${attempt})`;
      await sleep(RETRY_DELAY);
    }
    try {
      const body = {
        lineage_name: PRIME_CONFIG.lineage,
        user_message: message,
        pinned_turns: pinnedTurns.map(p => ({ role:'assistant', content: p.el.querySelector('.turn-content')?.textContent || p.excerpt })),
      };
      if ()   body.session_id = ;
      if (opts.retire) body.retire      = true;
      if (opts.rich)   body.rich        = true;
      if (pendingImage) {
        body.image = pendingImage; pendingImage = null;
        imgPreview.classList.remove('visible');
      } else if (pendingFile) {
        body.file = pendingFile; pendingFile = null;
        imgPreview.classList.remove('visible');
      }

      const ctl = new AbortController();
      const timeout = isWake ? 60000 : FETCH_TIMEOUT;
      const tid = setTimeout(() => ctl.abort(), timeout);
      let res;
      try { res = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), signal: ctl.signal }); }
      finally { clearTimeout(tid); }

      const data = await res.json();
      if (data.error === true || (data.error_type && !res.ok)) {
        if (data.error_type) { showError(data); thinking.classList.remove('visible'); return null; }
        lastError = data.error || res.statusText; continue;
      }
      if (!res.ok) { lastError = data.error || res.statusText; continue; }

      if (!sessionId) { sessionId = data.session_id; sessionDisp.textContent = 'Session ' + data.session_id.slice(0,8); }
      clearError(); return data;

    } catch (err) { lastError = err.name === 'AbortError' ? 'Request timed out' : err.message; }
  }

 
 showError({
  error: true,
  error_type: 'api_error',
  message: sessionId
    ? `Request timed out. Session ${sessionId.slice(0,8)} preserved — context intact. Dismiss and try again.`
    : `Request timed out after ${RETRY_LIMIT} attempts. Dismiss and try again.`
});
  thinking.classList.remove('visible'); return null;
}

/* ── Send ── */
async function send() {
  const msg = inputEl.value.trim(); if (!msg || btnSend.disabled) return;
  const lower = msg.toLowerCase();
  if (lower === 'bfn' || lower === 'bfn-r' || lower === 'bfn/r') { inputEl.value = ''; confirmRetirement(lower !== 'bfn'); return; }
  inputEl.value = ''; clearError(); btnSend.disabled = true; renderUser(msg);
  const data = await invoke(msg, false);
  thinking.classList.remove('visible'); btnSend.disabled = false;
  if (data) {
    renderAssistant(data.response, data.usage?.output_tokens||0, data.artifacts||[]);
    updateBudgetGauge(data.usage);
  }
  scrollBottom();
}

/* ── Retirement ── */
async function triggerRetirement(rich) {
  renderUser(rich ? 'bfn-R' : 'bfn');
  inputEl.disabled = true; btnSend.disabled = true;
  const data = await invoke('', false, { retire: true, rich });
  thinking.classList.remove('visible');
  if (data) {
    renderAssistant(data.response, data.usage?.output_tokens||0, data.artifacts||[]);
    updateBudgetGauge(data.usage);
  }
  const d = document.createElement('div'); d.className = 'retirement-confirm';
  d.textContent = `Session closed. ${PRIME_CONFIG.name} will remember.`;
  insertBefore(d);
  const rp = document.getElementById('retirement-prompt'); if (rp) rp.remove();
  scrollBottom();
}

/* ── New session ── */
function newSession() {
  sessionId = null;
  pinnedTurns = []; pinnedList.innerHTML = '';
  artefacts = []; pendingImage = null;
  retirementShown = false; retirementPending = false; turnSequence = 0;
  resetGauge(); clearError(); artefactsList.innerHTML = '';
  updatePanelEmpty(); updateBadge();
  Array.from(conv.children).forEach(el => { if (el !== thinking) el.remove(); });
  sessionDisp.textContent = 'Starting\u2026'; wake();
}

/* ── Continue session ── */
function continueSession() {
  const elapsed = lastWakeTimestamp ? Date.now() - lastWakeTimestamp : Infinity;
  sessionId = null;
  pinnedTurns = []; pinnedList.innerHTML = '';
  artefacts = []; pendingImage = null;
  retirementShown = false; retirementPending = false; turnSequence = 0;
  resetGauge(); clearError(); artefactsList.innerHTML = '';
  updatePanelEmpty(); updateBadge();
  Array.from(conv.children).forEach(el => { if (el !== thinking) el.remove(); });
  if (elapsed > FOUR_HOURS || !cachedWakeContent) { sessionDisp.textContent = 'Starting\u2026'; wake(); }
  else continueWake();
}

/* ── Continue wake ── */
async function continueWake() {
  if (isWaking) return; isWaking = true; btnSend.disabled = true;
  sessionDisp.textContent = 'Continuing\u2026';
  renderSessionDivider('Session continued \xb7 ' + timeStr());
  const wakeEl = renderWake(cachedWakeContent);
  if (wakeEl && cachedWakeContent) {
    pinnedTurns = pinnedTurns.filter(p => p.seq !== 'wake');
    const oldPin = document.getElementById('pin-wake'); if (oldPin) oldPin.remove();
    togglePin(wakeEl, 'wake', cachedWakeContent.slice(0,80));
  }
  const data = await invoke('Continue \u2014 check inbox for any new messages since the last session.', false);
  thinking.classList.remove('visible'); isWaking = false;
  if (data) {
    lastWakeTimestamp = Date.now();
    captureOrientationCost(data.usage);
    renderAssistant(data.response, data.usage?.output_tokens||0, data.artifacts||[]);
  }
  btnSend.disabled = false; scrollBottom();
}

/* ── Wake ── */
async function wake() {
  if (isWaking) return; isWaking = true; btnSend.disabled = true;
  if (cachedWakeContent) {
    sessionDisp.textContent = 'New session \u2014 pending';
    renderSessionDivider(); renderWake(cachedWakeContent);
    thinking.classList.remove('visible'); isWaking = false; btnSend.disabled = false;
    scrollBottom(); return;
  }
  const data = await invoke('Wake.', true);
  thinking.classList.remove('visible'); isWaking = false;
  if (data) {
    cachedWakeContent = data.response; lastWakeTimestamp = Date.now();
    captureOrientationCost(data.usage);
    renderSessionDivider();
    const wakeEl = renderWake(data.response);
    if (wakeEl && data.response) {
      pinnedTurns = pinnedTurns.filter(p => p.seq !== 'wake');
      const oldPin = document.getElementById('pin-wake'); if (oldPin) oldPin.remove();
      togglePin(wakeEl, 'wake', data.response.slice(0,80));
    }
    if (data.artifacts?.length > 0) data.artifacts.forEach(a => addArtefact(a));
  }
  btnSend.disabled = false; scrollBottom();
}
