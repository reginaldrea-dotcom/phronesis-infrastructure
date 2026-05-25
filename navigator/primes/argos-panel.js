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

/* ── Pin ── */
function togglePin(turnEl, seq, excerpt) {
  if (turnEl.classList.contains('pinned')) {
    turnEl.classList.remove('pinned');
    pinnedTurns = pinnedTurns.filter(p => p.seq !== seq);
    const pe = document.getElementById('pin-' + seq); if (pe) pe.remove();
  } else {
    const turnTime = turnEl.querySelector('.turn-label span')?.textContent?.trim() || '';
    turnEl.classList.add('pinned');
    pinnedTurns.push({ seq, excerpt, el: turnEl });
    const pe = document.createElement('div'); pe.className = 'pinned-entry'; pe.id = 'pin-' + seq;
    pe.innerHTML = `<span class="pinned-icon">\u2385</span><span class="pinned-excerpt">${esc(excerpt)}\u2026</span>`;
    pe.addEventListener('click', () => {
      const fullContent = turnEl.querySelector('.turn-content')?.textContent || excerpt;
      const modalTitle  = seq === 'wake'
        ? `Wake orientation \u2014 ${PRIME_CONFIG.name}`
        : `Pinned turn \u2014 ${PRIME_CONFIG.name}${turnTime ? ', '+turnTime : ''}`;
      openInspectModal(modalTitle, fullContent, [
        { label: 'Release pin', className: 'btn-artefact', action: (ov) => { ov.remove(); togglePin(turnEl, seq, excerpt); }},
        { label: 'Close',       className: 'btn-artefact', action: (ov) => ov.remove() },
      ]);
    });
    pinnedList.appendChild(pe); openPanel();
  }
  updateThinking(); updatePanelEmpty(); updateBadge();
}

function updateThinking() {
  const n = pinnedTurns.length;
  const base = isWaking ? `${PRIME_CONFIG.name} is waking\u2026` : `${PRIME_CONFIG.name} is thinking\u2026`;
  thinking.textContent = n > 0 ? `${PRIME_CONFIG.name} is thinking\u2026 holding ${n} pinned turn${n!==1?'s':''}` : base;
}
