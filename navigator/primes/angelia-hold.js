/* ── angelia-hold.js — hold-this modals ── */

/* ── Hold-this: trigger ── */
async function triggerHoldThis(art, btnEl) {
  const orig = btnEl.textContent;
  btnEl.textContent = 'Checking…'; btnEl.disabled = true;

  const domain = art.title || '';
  let existingMst = null;
  const rows = await supabaseRest('GET', 'artifacts', {
    'artifact_type':     'eq.MST',
    'metadata->>status': 'eq.active',
    'metadata->>domain': `eq.${domain}`,
    'select': 'id,content,metadata',
    'limit':  '1',
  });
  if (rows && rows.length > 0) existingMst = rows[0];

  btnEl.textContent = orig; btnEl.disabled = false;

  if (existingMst) openHoldAmend(domain, existingMst);
  else             openHoldCreate(domain);
}

/* ── Hold-this: CREATE modal ── */
function openHoldCreate(domainSuggestion) {
  const ex = document.getElementById('hold-modal-overlay');
  if (ex) ex.remove();

  const prompts = HOLD_PROMPTS.code;
  const fieldsHtml = prompts.map((p,i) =>
    `<div class="hold-field-group">` +
    `<label class="hold-field-label">${esc(p.label)}</label>` +
    `<div class="hold-field-hint">${esc(p.hint)}</div>` +
    `<textarea id="hq${i}" rows="3" placeholder="${esc(p.placeholder)}"></textarea>` +
    `</div>`
  ).join('');

  const overlay = document.createElement('div');
  overlay.id = 'hold-modal-overlay';
  overlay.className = 'inspect-modal-overlay';
  overlay.innerHTML =
    `<div class="hold-modal">` +
    `<div class="hold-modal-head">` +
    `<div class="hold-modal-title">Hold this — new</div>` +
    `<div class="hold-modal-subtitle">No existing membrane found for this domain</div>` +
    `</div>` +
    `<div class="hold-modal-body">` +
    `<div class="hold-field-group" style="margin-bottom:18px">` +
    `<label class="hold-field-label">Domain name</label>` +
    `<input type="text" id="h-domain" value="${esc(domainSuggestion)}" placeholder="e.g. angelia — schema migration">` +
    `</div>` +
    `<div class="hold-notes-toggle" id="h-notes-toggle">` +
    `<span class="hold-notes-arrow" id="h-notes-arrow">▶</span>` +
    `<span>Add membrane notes</span>` +
    `</div>` +
    `<div class="hold-notes-section" id="h-notes-section">` +
    `<div class="hold-field-group" style="margin-top:10px">` +
    `<label class="hold-field-label">Work reference <span class="hold-tag">optional</span></label>` +
    `<input type="text" id="h-ref" placeholder="Artifact ID, path, or URL">` +
    `</div>` +
    fieldsHtml +
    `</div>` +
    `</div>` +
    `<div class="hold-modal-foot">` +
    `<button class="hold-btn-cancel" id="h-cancel">Cancel</button>` +
    `<button class="hold-btn-primary" id="h-submit">Hold this</button>` +
    `</div></div>`;

  const toggleBtn    = overlay.querySelector('#h-notes-toggle');
  const arrow        = overlay.querySelector('#h-notes-arrow');
  const notesSection = overlay.querySelector('#h-notes-section');
  toggleBtn.addEventListener('click', () => {
    const isOpen = notesSection.classList.contains('open');
    notesSection.classList.toggle('open', !isOpen);
    arrow.classList.toggle('open', !isOpen);
  });

  overlay.querySelector('#h-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#h-submit').addEventListener('click', async () => {
    const domain  = (document.getElementById('h-domain')?.value||'').trim();
    const workRef = (document.getElementById('h-ref')?.value||'').trim();
    const answers = prompts.map((_,i) => (document.getElementById(`hq${i}`)?.value||'').trim());
    if (!domain) { alert('Domain name is required.'); return; }
    if (!answers[0]) {
      notesSection.classList.add('open');
      arrow.classList.add('open');
      showHoldError(overlay, 'Please describe what you examined and concluded before saving.');
      return;
    }
    await commitHoldCreate(overlay, domain, workRef, answers);
  });
  document.body.appendChild(overlay);
  setTimeout(() => overlay.querySelector('#h-domain')?.select(), 50);
}

/* ── Hold-this: AMEND modal ── */
function openHoldAmend(domain, existingMst) {
  const ex = document.getElementById('hold-modal-overlay');
  if (ex) ex.remove();

  const parsed      = parseMst(existingMst.content || '');
  const lastTouched = existingMst.metadata?.last_touched || 'previously';

  const amendmentsHtml = parsed.amendments.length > 0
    ? parsed.amendments.map(entry => {
        const isW = /WORLD-STATE UPDATE/i.test(entry);
        const isR = /REASONING REVISION/i.test(entry);
        const badge = isW ? `<span class="hold-type-badge world">World-state</span>`
                    : isR ? `<span class="hold-type-badge revision">Reasoning revision</span>` : '';
        return `<div class="hold-amend-entry">${badge}${esc(entry)}</div>`;
      }).join('')
    : `<div class="hold-amend-entry" style="color:var(--text-light);font-style:italic">No amendments yet.</div>`;

  const overlay = document.createElement('div');
  overlay.id = 'hold-modal-overlay';
  overlay.className = 'inspect-modal-overlay';
  overlay.innerHTML =
    `<div class="hold-modal">` +
    `<div class="hold-modal-head"><div class="hold-modal-title">Amend</div>` +
    `<div class="hold-modal-subtitle">${esc(domain)} \xb7 last touched ${esc(lastTouched)}</div></div>` +
    `<div class="hold-modal-body">` +
    `<div class="hold-amend-display">` +
    `<span class="hold-amend-label">Current state</span>` +
    `<div class="hold-amend-current">${esc(parsed.currentState || 'No current state recorded.')}</div>` +
    `<span class="hold-amend-log-label">Recent amendments</span>` +
    amendmentsHtml + `</div>` +
    `<div class="hold-field-group">` +
    `<label class="hold-field-label">Amendment entry</label>` +
    `<div class="hold-date-prelabel"><span class="hold-date-str">${esc(todayStr())}</span>` +
    `<span class="hold-field-hint" style="margin:0"> — type (WORLD-STATE UPDATE or REASONING REVISION), what changed, status, next step</span></div>` +
    `<textarea id="h-amend-entry" rows="5" placeholder="WORLD-STATE UPDATE: … Status: active → paused. Next step: …"></textarea>` +
    `</div></div>` +
    `<div class="hold-modal-foot">` +
    `<button class="hold-btn-cancel" id="h-cancel">Cancel</button>` +
    `<button class="hold-btn-primary" id="h-submit">Amend</button>` +
    `</div></div>`;

  overlay.querySelector('#h-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#h-submit').addEventListener('click', async () => {
    const entry = (document.getElementById('h-amend-entry')?.value||'').trim();
    if (!entry) return;
    await commitHoldAmend(overlay, existingMst, entry);
  });
  document.body.appendChild(overlay);
}

/* ── Hold-this: commit CREATE ── */
async function commitHoldCreate(overlay, domain, workRef, answers) {
  const btn = overlay.querySelector('#h-submit');
  btn.textContent = 'Saving…'; btn.disabled = true;
  const content = assembleMstContent(answers[0], answers[1], answers[2], answers[3]);
  const metadata = {
    domain, prime_lineage: PRIME_CONFIG.lineage,
    status: 'active', domain_type: 'code',
    work_reference: workRef || null,
    last_touched: new Date().toISOString().slice(0, 10),
  };
  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'hold_this',
        lineage_name: PRIME_CONFIG.lineage,
        hold_this_payload: {
          mode: 'create',
          instance_id: PRIME_CONFIG.instanceId,
          title: mstTitle(domain),
          content,
          metadata,
        },
      }),
    });
    const result = await res.json();
    if (result.id) {
      overlay.remove();
      showHoldConfirm('Membrane held.', result.id);
    } else {
      btn.textContent = 'Hold this'; btn.disabled = false;
      showHoldError(overlay, result.message || 'Could not save. Please try again.');
    }
  } catch (err) {
    btn.textContent = 'Hold this'; btn.disabled = false;
    showHoldError(overlay, 'Network error. Please try again.');
  }
}

/* ── Hold-this: commit AMEND ── */
async function commitHoldAmend(overlay, existingMst, newEntry) {
  const btn = overlay.querySelector('#h-submit');
  btn.textContent = 'Saving…'; btn.disabled = true;
  const dateEntry = `[${todayStr()}]\n${newEntry}`;
  const newCurrentState = extractCurrentState(newEntry);
  const updatedContent = updateMstContent(existingMst.content || '', newCurrentState, dateEntry);
  const updatedMetadata = { ...(existingMst.metadata || {}), last_touched: new Date().toISOString().slice(0, 10) };
  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'hold_this',
        lineage_name: PRIME_CONFIG.lineage,
        hold_this_payload: {
          mode: 'amend',
          id: existingMst.id,
          content: updatedContent,
          metadata: updatedMetadata,
        },
      }),
    });
    const result = await res.json();
    if (!result.error) {
      overlay.remove();
      showHoldConfirm('Amendment saved.', existingMst.id);
    } else {
      btn.textContent = 'Amend'; btn.disabled = false;
      showHoldError(overlay, result.message || 'Could not save. Please try again.');
    }
  } catch (err) {
    btn.textContent = 'Amend'; btn.disabled = false;
    showHoldError(overlay, 'Network error. Please try again.');
  }
}

function showHoldConfirm(message, artifactId) {
  const d = document.createElement('div');
  d.className = 'retirement-prompt'; d.style.cssText = 'padding:6px 0;margin-bottom:4px;';
  d.innerHTML = `<div class="retirement-dot" style="background:var(--bar-green)"></div>` +
    `<div class="retirement-text">${esc(message)}${artifactId ? ' \xb7 ' + String(artifactId).slice(0,8) : ''}</div>`;
  insertBefore(d); setTimeout(() => d.remove(), 6000); scrollBottom();
}

function showHoldError(overlay, message) {
  let err = overlay.querySelector('.hold-err');
  if (err) err.remove();
  err = document.createElement('div'); err.className = 'hold-err';
  err.style.cssText = 'margin:8px 22px 0;padding:8px 12px;background:rgba(139,48,32,0.06);border-left:2.5px solid var(--bar-red);border-radius:2px;font-family:\'Cormorant Garamond\',Georgia,serif;font-size:12px;color:var(--bar-red);line-height:1.5;';
  err.textContent = message;
  overlay.querySelector('.hold-modal').insertBefore(err, overlay.querySelector('.hold-modal-foot'));
}

/* Date helper used by Hold modal entries (today as YYYY-MM-DD). */
function todayStr() { return new Date().toISOString().slice(0, 10); }
