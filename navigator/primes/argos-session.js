/* ── argos-session.js — session management and invoke layer ──
   Depends on: argos-state.js, argos-config.js, argos-mst.js, argos-render.js, argos-gauge.js, argos-panel.js
   Functions: invoke, send, wake, continueWake, newSession, continueSession, triggerRetirement
   Retire-via-button filing (findTpArtefact / clearArtefactPanel / fileSuperT) lives in the
   shared prime-retire.js module; confirmSuperTFiling lives there too (was argos-render.js).
*/

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
        body.gauge = { load: loadScore, band: currentLoadBand(), budget: PRIME_CONFIG.sessionBudget };
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
        if (!sessionId) { sessionId = data.session_id; sessionDisp.textContent = 'Session ' + data.session_id.slice(0,8); persistSession(); }
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
    renderCaptureState(data);   // a90e1410 inst 3 — surface the row-derived capture state (shared core)
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
  // Verified-close gate lives in the SHARED core (prime-retire.js renderRetirementOutcome) so
  // connie/argos inherit the fix, not a per-Prime false close (Eames ruling, baton 36be494a). It
  // renders closed + "will remember" ONLY on a chain-verified landing; otherwise keeps the session open.
  renderRetirementOutcome(data);
  inputEl.disabled = false; btnSend.disabled = false;   // re-enable either way (retry if not filed)
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
  retirementShown = false; retirementPending = false; turnSequence = 0; sessionClosed = false;
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
  retirementShown = false; retirementPending = false; turnSequence = 0; sessionClosed = false;
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

/* ── Browser durability: persist the session id so a reopened tab resumes the SAME
   thread (server context endures via the EF; the visible tail is redrawn from
   prime_conversations through the EF's load_history read). The persistent thread ends
   only on formal retirement — this is the .ai-style "reopen the same thread" behaviour. ── */
function sessionStoreKey() { return 'phronesis_session_' + PRIME_CONFIG.lineage; }
function persistSession() { try { if (sessionId) localStorage.setItem(sessionStoreKey(), sessionId); } catch (e) {} }
function clearPersistedSession() { try { localStorage.removeItem(sessionStoreKey()); } catch (e) {} }

/* Boot entry (replaces the bare wake() call): resume a stored session if one survives,
   else wake fresh. */
async function resumeOrWake() {
  let stored = null;
  try { stored = localStorage.getItem(sessionStoreKey()); } catch (e) {}
  if (stored) await resumeSession(stored);
  else wake();
}

async function resumeSession(sid) {
  if (isWaking) return; isWaking = true; btnSend.disabled = true;
  sessionDisp.textContent = 'Resuming…';
  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineage_name: PRIME_CONFIG.lineage, session_id: sid, load_history: true }),
    });
    const data = await res.json();
    if (res.ok && Array.isArray(data.turns) && data.turns.length) {
      sessionId = sid; sessionClosed = false; lastWakeTimestamp = Date.now();
      renderSessionDivider('Session resumed \xb7 ' + timeStr());
      data.turns.forEach(replayTurn);
      sessionDisp.textContent = 'Session ' + sid.slice(0, 8) + ' \xb7 resumed';
    } else {
      // Stored session is gone/empty — start clean.
      clearPersistedSession(); sessionId = null;
      isWaking = false; btnSend.disabled = false; wake(); return;
    }
  } catch (e) {
    // Network hiccup: server context is intact, so keep the id and let the user continue.
    sessionId = sid;
    sessionDisp.textContent = 'Session ' + sid.slice(0, 8) + ' \xb7 resumed (tail unavailable)';
  }
  isWaking = false; btnSend.disabled = false; scrollBottom();
}

function replayTurn(t) {
  if (!t) return;
  let c = t.content;
  if (c && typeof c === 'object') c = c.text || c.content || JSON.stringify(c);
  if (!c) return;
  if (t.role === 'user') { renderUser(c); return; }
  // Footer from the authoritative server record (metadata.tool_log / output_tokens), not a transient
  // payload. This previously passed 0/[] so every reopened turn read "0 tokens · tools: none" even
  // when tools ran — a silent, inverted false-negative on the verification signal.
  const md = t.metadata || {};
  const toolUses = Array.isArray(md.tool_log) ? md.tool_log.map(e => ({ name: e && e.tool })) : [];
  renderAssistant(c, Number(md.output_tokens) || 0, [], toolUses);
}
