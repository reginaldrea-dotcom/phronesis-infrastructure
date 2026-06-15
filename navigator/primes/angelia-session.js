/* ── angelia-session.js — session management and invoke layer ──
   Depends on: angelia-state.js, angelia-config.js, angelia-render.js, angelia-gauge.js, angelia-panel.js
   Functions: invoke, send, wake, continueWake, newSession, continueSession, triggerRetirement,
              noteDriveDestructive (stub — see below).
*/

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── Invoke ── */
async function invoke(message, isWake = false, opts = {}) {
  invokeController = new AbortController();
  btnStop.style.display = ''; btnSend.style.display = 'none';

  const pCount = pinnedTurns.length;
  thinking.textContent = isWake ? `${PRIME_CONFIG.name} is waking…`
    : pCount > 0 ? `${PRIME_CONFIG.name} is thinking… holding ${pCount} pinned turn${pCount!==1?'s':''}`
    : `${PRIME_CONFIG.name} is thinking…`;
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
        thinking.textContent = isWake ? `${PRIME_CONFIG.name} is waking… (retry ${attempt})` : `${PRIME_CONFIG.name} is thinking… (retry ${attempt})`;
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
    noteDriveDestructive(data);
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
    noteDriveDestructive(data);
  }
  const d = document.createElement('div'); d.className = 'retirement-confirm';
  d.textContent = `Session closed. ${PRIME_CONFIG.name} will remember.`;
  insertBefore(d);
  sessionClosed = true;   // clean retirement — disarm the accidental-close guard
  clearPersistedSession();   // retirement is the only thing that ends the persistent thread
  inputEl.disabled = false; btnSend.disabled = false;   // allow a final goodbye after close
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
  sessionDisp.textContent = 'Starting…'; wake();
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
  if (elapsed > FOUR_HOURS || !cachedWakeContent) { sessionDisp.textContent = 'Starting…'; wake(); }
  else continueWake();
}

/* ── Continue wake ── */
async function continueWake() {
  if (isWaking) return; isWaking = true; btnSend.disabled = true;
  sessionDisp.textContent = 'Continuing…';
  renderSessionDivider('Session continued \xb7 ' + timeStr());
  const wakeEl = renderWake(cachedWakeContent);
  if (wakeEl && cachedWakeContent) {
    pinnedTurns = pinnedTurns.filter(p => p.seq !== 'wake');
    const oldPin = document.getElementById('pin-wake'); if (oldPin) oldPin.remove();
    togglePin(wakeEl, 'wake', cachedWakeContent.slice(0,80));
  }
  const data = await invoke('Continue — check inbox for any new messages since the last session.', false);
  thinking.classList.remove('visible'); isWaking = false;
  if (data) {
    lastWakeTimestamp = Date.now();
    pendingOrientationUsage = data.usage;
    renderAssistant(data.response, data.usage?.output_tokens||0, data.artifacts||[], data.tool_uses||[]);
    updateLoadGauge(data);
    noteDriveDestructive(data);
  }
  btnSend.disabled = false; scrollBottom();
}

/* ── Wake ──
   Constantinople's wake is intended to run a single combined query: Super-T plus
   any unconsumed wake_deltas joined. The query itself lives in Constantinople's
   standing instructions (EF), not here. The wake exchange is excluded from
   activity scoring — updateLoadGauge is intentionally NOT called on the wake
   response. */
async function wake() {
  if (isWaking) return; isWaking = true; btnSend.disabled = true;
  if (cachedWakeContent) {
    sessionDisp.textContent = 'New session — pending';
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
      clearPersistedSession(); sessionId = null;
      isWaking = false; btnSend.disabled = false; wake(); return;
    }
  } catch (e) {
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

/* ── Drive confirmation gate — STUB ──────────────────────────────────────────
   Brief Step 5: rename, move, and delete Drive operations require Reg's explicit
   confirmation BEFORE the tool call executes; execution is blocked until Reg
   confirms.

   Under the current edge-function architecture (api-prime-invoke v99), tool calls
   execute inside the function's tool-result loop with no pause-point — the
   front-end only sees tool_uses[] after the exchange completes. There is no
   way today for the interface to interrupt a Drive write mid-loop.

   When MCP wiring lands and the edge function supports two-phase confirmation,
   the call site for this function moves: invoke this BEFORE the destructive
   tool call runs, await a confirm/cancel decision from Reg, and pass the
   decision back into the loop. The classification (rename/move/delete) and the
   confirmation copy stay as below.

   Today: noteDriveDestructive runs AFTER the exchange and surfaces a post-hoc
   notice (informational only — the tool call has already occurred). This also
   doubles as the drive_assets-integrity reminder per Step 5.

   Drive tool_use blocks won't appear in data.tool_uses until the EF is extended
   with the Drive MCP server, so under normal operation today this function is a
   no-op. */
function noteDriveDestructive(data) {
  const toolUses = Array.isArray(data?.tool_uses) ? data.tool_uses : [];
  for (const t of toolUses) {
    if (!t || !t.name) continue;
    const name = String(t.name).toLowerCase();
    const kind = classifyDriveTool(t.name);
    let label = null;
    if (kind === 'delete')        label = 'DELETE';
    else if (/rename/.test(name)) label = 'RENAME';
    else if (/move/.test(name))   label = 'MOVE';
    if (!label) continue;

    const inputStr = (() => {
      try { return JSON.stringify(t.input || {}); }
      catch { return '[unserialisable]'; }
    })();

    const notice = document.createElement('div');
    notice.className = 'drive-gate-notice';
    notice.innerHTML =
      `<div class="drive-gate-label">Drive ${esc(label)} — confirmation gate (stub)</div>` +
      `<div class="drive-gate-body">` +
        `Tool: <code>${esc(t.name)}</code><br>` +
        `Input: <code>${esc(inputStr.slice(0, 240))}${inputStr.length > 240 ? '…' : ''}</code><br>` +
        `Reminder: drive_assets record and artifact metadata may need updating in Supabase.` +
      `</div>`;
    insertBefore(notice);
  }
  scrollBottom();
}
