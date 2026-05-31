/* ── argos-session.js — session management and invoke layer ──
   Depends on: argos-state.js, argos-config.js, argos-mst.js, argos-render.js, argos-gauge.js, argos-panel.js
   Functions: invoke, send, wake, continueWake, newSession, continueSession, triggerRetirement,
              findTpArtefact, fileSuperT, clearArtefactPanel
*/

/* TP artefacts are surfaced by the edge function's extractArtifacts(): the
   [ARTEFACT: TP_Argos_*.md]…[/ARTEFACT] block Argos emits is already parsed into
   a structured entry in artefacts[] (title + content) before it reaches here. */
var TP_ARTEFACT_RE = /^TP_Argos_.*\.md$/;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── Invoke ── */
async function invoke(message, isWake = false, opts = {}) {
  invokeController = new AbortController();
  btnStop.style.display = ''; btnSend.style.display = 'none';

  const pCount = pinnedTurns.length;
  thinking.textContent = isWake ? `${PRIME_CONFIG.name} is waking\u2026`
    : pCount > 0 ? `${PRIME_CONFIG.name} is thinking\u2026 holding ${pCount} pinned turn${pCount!==1?'s':''}`
    : `${PRIME_CONFIG.name} is thinking\u2026`;
  thinking.classList.add('visible'); scrollBottom();

  let lastError = null;
  // D3: one request_id per logical invocation, reused across retries so the EF can
  // dedupe a re-POST (it returns the original's result instead of re-executing).
  const requestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(16).slice(2);

  try {
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
      if (invokeController.signal.aborted) break;

      if (attempt > 0) {
        thinking.textContent = isWake ? `${PRIME_CONFIG.name} is waking\u2026 (retry ${attempt})` : `${PRIME_CONFIG.name} is thinking\u2026 (retry ${attempt})`;
        await sleep(RETRY_DELAY);
      }

      try {
        const body = {
          lineage_name: PRIME_CONFIG.lineage,
          user_message: message,
          pinned_turns: pinnedTurns.map(p => ({ role:'assistant', content: (p.el && p.el.querySelector('.turn-content')?.textContent) || p.content || p.excerpt })),
        };
        body.request_id = requestId;
        if (sessionId) body.session_id = sessionId;
        if (opts.retire) body.retire = true;
        if (opts.rich) body.rich = true;
        if (pendingImage) {
          body.image = pendingImage; pendingImage = null;
          imgPreview.classList.remove('visible');
        } else if (pendingFile) {
          body.file = pendingFile; pendingFile = null;
          imgPreview.classList.remove('visible');
        }

        const timeoutCtl = new AbortController();
        const timeout = FETCH_TIMEOUT;
        const tid = setTimeout(() => timeoutCtl.abort(), timeout);
        const signal = typeof AbortSignal.any === 'function'
          ? AbortSignal.any([invokeController.signal, timeoutCtl.signal])
          : timeoutCtl.signal;

        let res;
        try { res = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), signal }); }
        finally { clearTimeout(tid); }

        const data = await res.json();
        if (data.error === true || (data.error_type && !res.ok)) {
          if (data.error_type) { showError(data); return null; }
          lastError = data.error || res.statusText; continue;
        }
        if (!res.ok) { lastError = data.error || res.statusText; continue; }
        if (!sessionId) { sessionId = data.session_id; sessionDisp.textContent = 'Session ' + data.session_id.slice(0,8); }
        clearError(); return data;

      } catch (err) {
        if (invokeController.signal.aborted) break;
        lastError = err.name === 'AbortError' ? 'Request timed out' : err.message;
        // D5: never auto-retry a side-effectful request — it may have completed
        // server-side. (request_id idempotency covers the rest; this is the guard.)
        if (opts.retire) break;
      }
    }

    if (!invokeController.signal.aborted) {
      showError({
        error: true,
        error_type: 'api_error',
        message: opts.retire
          ? `Retirement timed out — it may have completed server-side. Do NOT resend: verify the Super-T was filed before retrying.`
          : sessionId
          ? `Request timed out. Session ${sessionId.slice(0,8)} preserved — context intact. Dismiss and try again.`
          : `Request timed out after ${RETRY_LIMIT} attempts. Dismiss and try again.`
      });
    }
    return null;

  } finally {
    thinking.classList.remove('visible');
    btnStop.style.display = 'none'; btnSend.style.display = '';
    invokeController = null;
  }
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
    renderAssistant(data.response, data.usage?.output_tokens||0, data.artifacts||[], data.tool_uses||[]);
    if (!data.wake && !orientationCost) {
      captureOrientationCost(data.usage);
      pendingOrientationUsage = null;
    } else {
      updateBudgetGauge(data.usage);
    }
    updateLoadGauge(data);
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
    renderAssistant(data.response, data.usage?.output_tokens||0, data.artifacts||[], data.tool_uses||[]);
    updateBudgetGauge(data.usage);
    updateLoadGauge(data);
  }
  const d = document.createElement('div'); d.className = 'retirement-confirm';
  d.textContent = `Session closed. ${PRIME_CONFIG.name} will remember.`;
  insertBefore(d);
  const rp = document.getElementById('retirement-prompt'); if (rp) rp.remove();
  scrollBottom();
}

/* ── New session ── */
function newSession() {
  const carried = serializeUserPins();
  inputEl.disabled = false; // re-enable input if a retirement left it disabled
  sessionId = null;
  pinnedTurns = []; pinnedList.innerHTML = '';
  artefacts = []; pendingImage = null;
  retirementShown = false; retirementPending = false; turnSequence = 0;
   cachedWakeContent = null; lastWakeTimestamp = null;
  resetGauge(); clearError(); artefactsList.innerHTML = '';
  updatePanelEmpty(); updateBadge();
  Array.from(conv.children).forEach(el => { if (el !== thinking) el.remove(); });
  restoreUserPins(carried);
  sessionDisp.textContent = 'Starting\u2026'; wake();
}

/* ── Continue session ── */
function continueSession() {
  const elapsed = lastWakeTimestamp ? Date.now() - lastWakeTimestamp : Infinity;
  const carried = serializeUserPins();
  inputEl.disabled = false; // re-enable input if a retirement left it disabled
  sessionId = null;
  pinnedTurns = []; pinnedList.innerHTML = '';
  artefacts = []; pendingImage = null;
  retirementShown = false; retirementPending = false; turnSequence = 0;
  resetGauge(); clearError(); artefactsList.innerHTML = '';
  updatePanelEmpty(); updateBadge();
  Array.from(conv.children).forEach(el => { if (el !== thinking) el.remove(); });
  restoreUserPins(carried);
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
    pendingOrientationUsage = data.usage;
    renderAssistant(data.response, data.usage?.output_tokens||0, data.artifacts||[], data.tool_uses||[]);
    updateLoadGauge(data);
  }
  btnSend.disabled = false; scrollBottom();
}

/* ── Wake ── */
async function wake() {
  if (isWaking) return; isWaking = true; btnSend.disabled = true;
  if (cachedWakeContent) {
    sessionDisp.textContent = 'New session \u2014 pending';
    renderSessionDivider(); renderWake(cachedWakeContent);
    if (cachedWakeUsage) pendingOrientationUsage = cachedWakeUsage;
    thinking.classList.remove('visible'); isWaking = false; btnSend.disabled = false;
    scrollBottom(); return;
  }
  const data = await invoke('Wake.', true);
  thinking.classList.remove('visible'); isWaking = false;
  if (data) {
    cachedWakeContent = data.response; cachedWakeUsage = data.usage; lastWakeTimestamp = Date.now();
    pendingOrientationUsage = data.usage;
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

/* ── Interface-side Super-T filing (Phase 3) ──
   Files the TP artefact via the file_super_t Edge Function action, which runs an
   atomic Postgres transaction (insert artifact → insert chain row → link
   predecessor) with the service-role key. This replaces the original Option A
   browser-REST mechanism, which RLS blocked (anon has no policies on artifacts /
   super_t_chains). Generation (Argos wraps the TP in artefact syntax) stays
   separated from execution (this filing, fired by the Retire button). */

/* Latest matching TP artefact wins — Argos may have regenerated within a session. */
function findTpArtefact() {
  for (let i = artefacts.length - 1; i >= 0; i--) {
    if (TP_ARTEFACT_RE.test(artefacts[i].title || '')) return artefacts[i];
  }
  return null;
}

/* Clear the artefact panel so a second Retire click cannot double-file.
   Mirrors the panel reset in newSession(); the session is closing regardless. */
function clearArtefactPanel() {
  artefacts = []; artefactsList.innerHTML = '';
  updatePanelEmpty(); updateBadge();
}

async function fileSuperT(tp) {
  inputEl.disabled = true; btnSend.disabled = true;
  const fail = (detail) => {
    showError({ error: true, error_type: 'api_error',
      message: `Retire filing failed: ${detail}` });
    inputEl.disabled = false;   // do not block retry
  };

  /* File atomically via the file_super_t EF action (service-role, bypasses RLS).
     The EF runs the insert-artifact / insert-chain / link-predecessor transaction. */
  let res, data;
  try {
    res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:      'file_super_t',
        // Deterministic key: a second Retire click in the same session collides on the
        // same request_id, so the EF replays the first filing instead of filing twice.
        request_id:  'retire-' + sessionId,
        lineage:     PRIME_CONFIG.lineage,
        instance_id: PRIME_CONFIG.instanceId,
        session_id:  sessionId,
        title:       tp.title,
        content:     tp.content || '',
      }),
    });
    data = await res.json();
  } catch (err) {
    return fail(err.message || 'network error');
  }
  if (!res.ok || !data || data.error || !data.sequence_number) {
    return fail((data && (data.message || data.error)) || ('HTTP ' + res.status));
  }

  /* Success — surface, close session, clear panel. */
  clearError();
  const ok = document.createElement('div'); ok.className = 'retirement-confirm';
  ok.textContent = `Super-T filed: ${tp.title} — seq ${data.sequence_number}, artifact ${data.artifact_id}`;
  insertBefore(ok);
  const closed = document.createElement('div'); closed.className = 'retirement-confirm';
  closed.textContent = `Session closed. ${PRIME_CONFIG.name} will remember.`;
  insertBefore(closed);
  clearArtefactPanel();
  scrollBottom();
}
