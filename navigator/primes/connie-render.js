/* ── connie-render.js — render helpers ── */

/* ── Helpers ── */
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function timeStr() { return new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }
function scrollBottom() { conv.scrollTop = conv.scrollHeight; }
function insertBefore(el) { conv.insertBefore(el, thinking); }

function renderSessionDivider(label) {
  const d = document.createElement('div'); d.className = 'session-divider';
  d.innerHTML = `<span>${esc(label || 'Session opened \xb7 ' + timeStr())}</span>`;
  insertBefore(d);
}

function renderWake(text) {
  const label = text ? 'Wake \xb7 Orientation complete' : 'Wake \xb7 Orientation incomplete — check substrate';
  const d = document.createElement('div'); d.className = 'turn-wake';
  d.innerHTML = `<div class="turn-label">${esc(label)}</div><div class="turn-content">${esc(text || 'No orientation data returned.')}</div>`;
  insertBefore(d); return d;
}

function renderUser(text) {
  const d = document.createElement('div'); d.className = 'turn-user';
  d.innerHTML = `<div class="turn-label">Reg <span class="turn-time">${timeStr()}</span></div><div class="turn-content">${esc(text)}</div>`;
  insertBefore(d);
}

/* Show which tools actually ran this turn — makes a fabricated "I checked X" with
   no real tool call visible at a glance (Homer confabulation report, 30 May 2026). */
function formatToolUses(toolUses) {
  if (!Array.isArray(toolUses) || toolUses.length === 0) return 'tools: none';
  const counts = {};
  toolUses.forEach(t => { const n = (t && t.name) ? t.name : 'unknown'; counts[n] = (counts[n] || 0) + 1; });
  return 'tools: ' + Object.entries(counts).map(([n, c]) => c > 1 ? `${n} ×${c}` : n).join(', ');
}

function renderAssistant(text, tokens, arts, toolUses) {
  const seq = ++turnSequence; const excerpt = text.trim().slice(0,200);
  const d = document.createElement('div'); d.className = 'turn-assistant'; d.dataset.seq = seq;
  let artsHtml = '';
  if (arts && arts.length > 0) artsHtml = arts.map(a => `<div class="artefact-ref">&#128206; ${esc(a.title)} — in artefact panel</div>`).join('');
  d.innerHTML =
    `<button class="pin-btn" title="Pin turn">⎅</button>` +
    `<div class="turn-label">${esc(PRIME_CONFIG.name)} <span style="font-weight:400;margin-left:8px;font-size:11px;opacity:0.7">${timeStr()}</span></div>` +
    `<div class="turn-content">${esc(text)}</div>` + artsHtml +
    `<div class="turn-tokens">${(tokens||0).toLocaleString()} tokens <span style="opacity:0.8">· ${esc(formatToolUses(toolUses))}</span></div>`;
  d.querySelector('.pin-btn').addEventListener('click', () => togglePin(d, seq, excerpt));
  insertBefore(d);
  if (arts && arts.length > 0) { arts.forEach(a => addArtefact(a)); openPanel(); }
  return d;
}

function renderRetirementPrompt() {
  if (document.getElementById('retirement-prompt')) return;
  const d = document.createElement('div'); d.className = 'retirement-prompt'; d.id = 'retirement-prompt';
  d.innerHTML = `<div class="retirement-dot"></div><div class="retirement-text">Ready to retire when you are.</div>`;
  insertBefore(d); scrollBottom();
}

function confirmRetirement(rich) {
  if (retirementPending) return; retirementPending = true;
  const d = document.createElement('div'); d.className = 'retirement-prompt'; d.id = 'retirement-confirm-prompt';
  d.innerHTML =
    `<div class="retirement-dot"></div>` +
    `<div class="retirement-text">Retire ${esc(PRIME_CONFIG.name)} and write the Super-T?</div>` +
    `<button class="btn btn-send" id="btn-confirm-retire" style="margin-left:12px;padding:4px 14px;font-size:12px">Confirm</button>` +
    `<button class="error-dismiss" id="btn-cancel-retire" style="margin-left:6px">Cancel</button>`;
  insertBefore(d); scrollBottom();
  document.getElementById('btn-confirm-retire').addEventListener('click', () => { d.remove(); retirementPending = false; triggerRetirement(rich); });
  document.getElementById('btn-cancel-retire').addEventListener('click',  () => { d.remove(); retirementPending = false; });
}

/* ── Inspect modal ── */
function openInspectModal(title, content, footerConfig) {
  const ex = document.getElementById('inspect-modal-overlay'); if (ex) ex.remove();
  const overlay = document.createElement('div');
  overlay.id = 'inspect-modal-overlay'; overlay.className = 'inspect-modal-overlay';
  const footerHtml = footerConfig.map((btn,i) =>
    `<button class="${esc(btn.className||'btn-artefact')}" data-fi="${i}">${esc(btn.label)}</button>`).join('');
  overlay.innerHTML =
    `<div class="inspect-modal">` +
    `<div class="inspect-modal-header"><span class="inspect-modal-title">${esc(title)}</span><button class="inspect-modal-close">×</button></div>` +
    `<div class="inspect-modal-body"><pre class="inspect-modal-content">${esc(content)}</pre></div>` +
    `<div class="inspect-modal-footer">${footerHtml}</div></div>`;
  overlay.querySelector('.inspect-modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  footerConfig.forEach((btn,i) => overlay.querySelector(`[data-fi="${i}"]`).addEventListener('click', () => btn.action(overlay)));
  document.body.appendChild(overlay);
}

/* ── Error states ── */
function showError(data) {
  clearError(); errorState.className = 'error-state visible'; btnSend.disabled = true;
  if (data.error_type === 'rate_limit_exceeded') {
    errorState.classList.add('rate-limit');
    let secs = data.retry_after_seconds || 30;
    errorState.innerHTML = `<div>${esc(data.message)}</div><div class="error-countdown" id="err-cd">Ready in ${secs}s</div>`;
    countdownInterval = setInterval(() => {
      secs--; const el = document.getElementById('err-cd');
      if (el) el.textContent = secs > 0 ? `Ready in ${secs}s` : 'Ready';
      if (secs <= 0) { clearError(); btnSend.disabled = false; }
    }, 1000);
  } else if (data.error_type === 'context_exceeded') {
    errorState.classList.add('ctx-exceeded');
    errorState.innerHTML = `<div>${esc(data.message)}</div><button class="btn btn-new-session error-dismiss" onclick="newSession()">New Session</button>`;
  } else {
    errorState.classList.add('api-error');
    const rid = data.request_id ? `<div class="error-countdown">${esc(data.request_id)}</div>` : '';
    errorState.innerHTML = `<div>${esc(data.message||data.error||'Something went wrong.')}</div>${rid}<button class="error-dismiss" onclick="clearError();document.getElementById('btn-send').disabled=false;">Dismiss</button>`;
  }
}

function clearError() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  errorState.className = 'error-state'; errorState.innerHTML = '';
}
