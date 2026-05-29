/* ── argos-panel.js — artefact panel and pin ── */

function openPanel()  { panelEl.classList.remove('closed'); panelToggle.classList.remove('visible'); }
function closePanel() { panelEl.classList.add('closed');    panelToggle.classList.add('visible');    updateBadge(); }

function updateBadge() {
  const n = artefacts.length + pinnedTurns.length;
  if (n > 0) { panelBadge.textContent = n; panelBadge.classList.add('visible'); }
  else panelBadge.classList.remove('visible');
}

function updatePanelEmpty() {
  const has = artefacts.length > 0 || pinnedTurns.length > 0;
  panelEmpty.style.display       = has ? 'none' : 'block';
  artefactsSection.style.display = artefacts.length > 0 ? 'block' : 'none';
  pannedSection.style.display    = pinnedTurns.length > 0 ? 'block' : 'none';
}

/* ── Add artefact ── */
function addArtefact(art) {
  const existing = artefacts.filter(a => a.title === art.title).length;
  const version  = existing + 1;
  const entry    = { ...art, version, time: timeStr() };
  artefacts.push(entry);
  const idx = artefacts.length - 1;

  const el = document.createElement('div'); el.className = 'artefact-entry';
  el.innerHTML =
    `<div class="artefact-title">${esc(art.title)}</div>` +
    `<div class="artefact-meta">${esc(art.type||'code')} \xb7 ${entry.time}${version > 1 ? ' \xb7 v'+version : ''}</div>` +
    `<div class="artefact-actions">` +
    `<button class="btn-artefact hold"    data-action="hold"    data-idx="${idx}">Hold this</button>` +
    `<button class="btn-artefact"         data-action="inspect" data-idx="${idx}">Inspect</button>` +
    `<button class="btn-artefact"         data-action="copy"    data-idx="${idx}">Copy</button>` +
    `<button class="btn-artefact"         data-action="dismiss" data-idx="${idx}">Dismiss</button>` +
    `</div>`;

  el.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]'); if (!btn) return;
    const i = parseInt(btn.dataset.idx); const storedArt = artefacts[i];

    if (btn.dataset.action === 'hold') {
      if (!storedArt) return;
      triggerHoldThis(storedArt, btn);

    } else if (btn.dataset.action === 'inspect') {
      if (!storedArt) return;
      const content = storedArt.content || '';
      openInspectModal(storedArt.title, content, [
        { label: 'Open in tab', className: 'btn-artefact', action: () => { const b = new Blob([content],{type:'text/plain'}); window.open(URL.createObjectURL(b),'_blank','noopener'); }},
        { label: 'Copy',        className: 'btn-artefact', action: (ov) => { navigator.clipboard.writeText(content).catch(()=>{}); ov.remove(); }},
        { label: 'Close',       className: 'btn-artefact', action: (ov) => ov.remove() },
      ]);

    } else if (btn.dataset.action === 'copy') {
      navigator.clipboard.writeText(storedArt?.content||'').then(() => {
        btn.textContent = 'Copied \u2713'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }).catch(()=>{});

    } else if (btn.dataset.action === 'dismiss') {
      artefacts.splice(i, 1);
      el.style.cssText = 'opacity:0;max-height:0;overflow:hidden;transition:opacity 0.2s,max-height 0.2s';
      setTimeout(() => el.remove(), 200);
      updatePanelEmpty(); updateBadge();
    }
  });

  artefactsList.appendChild(el);
  updatePanelEmpty(); updateBadge();
}

/* ── Pin ──
   A pin carries its own content (excerpt + full text) so it survives a session
   reset: New Session / Continue clear the conversation DOM, but a pin no longer
   depends on its turn node. See serializeUserPins / restoreUserPins. */
function togglePin(turnEl, seq, excerpt) {
  if (turnEl.classList.contains('pinned')) { releasePin(seq); return; }
  const turnTime = turnEl.querySelector('.turn-label span')?.textContent?.trim() || '';
  const content  = turnEl.querySelector('.turn-content')?.textContent || excerpt;
  turnEl.classList.add('pinned');
  const pin = { seq, excerpt, content, time: turnTime, el: turnEl };
  pinnedTurns.push(pin);
  addPinnedEntry(pin);
  updateThinking(); updatePanelEmpty(); updateBadge();
}

/* Build the panel "Held in context" entry for a pin. Works with a live turn el
   or without one (a pin carried across a reset) \u2014 content comes off the pin. */
function addPinnedEntry(pin) {
  const pe = document.createElement('div'); pe.className = 'pinned-entry'; pe.id = 'pin-' + pin.seq;
  pe.innerHTML = `<span class="pinned-icon">\u2385</span><span class="pinned-excerpt">${esc(pin.excerpt)}\u2026</span>`;
  pe.addEventListener('click', () => {
    const fullContent = (pin.el && pin.el.querySelector('.turn-content')?.textContent) || pin.content || pin.excerpt;
    const modalTitle  = pin.seq === 'wake'
      ? `Wake orientation \u2014 ${PRIME_CONFIG.name}`
      : `Pinned turn \u2014 ${PRIME_CONFIG.name}${pin.time ? ', '+pin.time : ''}`;
    openInspectModal(modalTitle, fullContent, [
      { label: 'Release pin', className: 'btn-artefact', action: (ov) => { ov.remove(); releasePin(pin.seq); }},
      { label: 'Close',       className: 'btn-artefact', action: (ov) => ov.remove() },
    ]);
  });
  pinnedList.appendChild(pe); openPanel();
}

/* Release a pin by seq; unhighlights its turn if one is live in the DOM. */
function releasePin(seq) {
  const pin = pinnedTurns.find(p => p.seq === seq);
  if (pin && pin.el) pin.el.classList.remove('pinned');
  pinnedTurns = pinnedTurns.filter(p => p.seq !== seq);
  const pe = document.getElementById('pin-' + seq); if (pe) pe.remove();
  updateThinking(); updatePanelEmpty(); updateBadge();
}

/* \u2500\u2500 Pin survival across reset (Move 1) \u2500\u2500
   serializeUserPins() snapshots user pins as plain content objects BEFORE the
   conversation DOM is cleared; restoreUserPins() re-renders them into the fresh
   session. The wake-orientation pin is excluded \u2014 wake()/continueWake() re-pin it. */
function serializeUserPins() {
  return pinnedTurns
    .filter(p => p.seq !== 'wake')
    .map(p => ({
      excerpt: p.excerpt,
      content: (p.el && p.el.querySelector('.turn-content')?.textContent) || p.content || p.excerpt,
      time:    p.time || '',
    }));
}

function restoreUserPins(carried) {
  if (!carried || !carried.length) return;
  carried.forEach((c, i) => {
    const pin = { seq: 'carry-' + i, excerpt: c.excerpt, content: c.content, time: c.time, el: null };
    pinnedTurns.push(pin);
    addPinnedEntry(pin);
  });
  updateThinking(); updatePanelEmpty(); updateBadge();
}

function updateThinking() {
  const n = pinnedTurns.length;
  const base = isWaking ? `${PRIME_CONFIG.name} is waking\u2026` : `${PRIME_CONFIG.name} is thinking\u2026`;
  thinking.textContent = n > 0 ? `${PRIME_CONFIG.name} is thinking\u2026 holding ${n} pinned turn${n!==1?'s':''}` : base;
}
