/* ── prime-retire.js — shared retire-via-button core (Phase 2 / D4 item 1) ──
   ONE copy of the interface-side Super-T filing subsystem, loaded by both
   argos.html and connie.html and parameterised by the page's PRIME_CONFIG.
   Files the emitted TP artefact atomically via the file_super_t Edge Function
   action (service-role, bypasses RLS). Generation (the Prime wraps the TP in
   [ARTEFACT: TP_<Name>_*.md] syntax) stays separated from execution (this
   filing, fired by the Retire button).

   Behaviour-preserving extraction of the functions previously inline in
   argos-session.js (findTpArtefact / clearArtefactPanel / fileSuperT) and
   argos-render.js (confirmSuperTFiling). All shared state stays global: this
   module depends on globals defined by the other per-Prime modules —
   PRIME_CONFIG, EDGE_URL, sessionId, artefacts, artefactsList, inputEl,
   btnSend, and the render helpers showError / clearError / insertBefore /
   scrollBottom / updatePanelEmpty / updateBadge / esc / retirementPending.
   Load AFTER config/state/render, BEFORE init. */

/* TP artefacts are surfaced by the edge function's extractArtifacts(): the
   [ARTEFACT: TP_<Name>_*.md]…[/ARTEFACT] block the Prime emits is parsed into a
   structured entry in artefacts[] (title + content) before it reaches here.
   The match pattern is derived per-Prime from PRIME_CONFIG.name — Argos →
   /^TP_Argos_.*\.md$/ (reproduces the prior hard-coded literal exactly),
   Constantinople → /^TP_Constantinople_.*\.md$/. */
function tpArtefactRe() {
  return new RegExp('^TP_' + PRIME_CONFIG.name + '_.*\\.md$');
}

/* Latest matching TP artefact wins — the Prime may have regenerated within a session. */
function findTpArtefact() {
  const re = tpArtefactRe();
  for (let i = artefacts.length - 1; i >= 0; i--) {
    if (re.test(artefacts[i].title || '')) return artefacts[i];
  }
  return null;
}

/* Clear the artefact panel so a second Retire click cannot double-file.
   Mirrors the panel reset in newSession(); the session is closing regardless. */
function clearArtefactPanel() {
  artefacts = []; artefactsList.innerHTML = '';
  updatePanelEmpty(); updateBadge();
}

/* ── Interface-side Super-T filing (Phase 3) ──
   Files the TP artefact via the file_super_t Edge Function action, which runs an
   atomic Postgres transaction (insert artifact → insert chain row → link
   predecessor) with the service-role key. This replaces the original Option A
   browser-REST mechanism, which RLS blocked (anon has no policies on artifacts /
   super_t_chains). lineage / instance_id come from PRIME_CONFIG. */
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
  sessionClosed = true;   // clean retirement — disarm the accidental-close guard
  clearArtefactPanel();
  scrollBottom();
}

/* Super-T filing confirm — shown when a TP artefact is present at Retire.
   On confirm, files via the file_super_t action (fileSuperT) instead of the bfn turn. */
function confirmSuperTFiling(tp) {
  if (retirementPending) return; retirementPending = true;
  const d = document.createElement('div'); d.className = 'retirement-prompt'; d.id = 'supert-confirm-prompt';
  d.innerHTML =
    `<div class="retirement-dot"></div>` +
    `<div class="retirement-text">File Super-T <strong>${esc(tp.title)}</strong> and retire ${esc(PRIME_CONFIG.name)}?</div>` +
    `<button class="btn btn-send" id="btn-confirm-file" style="margin-left:12px;padding:4px 14px;font-size:12px">Confirm</button>` +
    `<button class="error-dismiss" id="btn-cancel-file" style="margin-left:6px">Cancel</button>`;
  insertBefore(d); scrollBottom();
  document.getElementById('btn-confirm-file').addEventListener('click', () => { d.remove(); retirementPending = false; fileSuperT(tp); });
  document.getElementById('btn-cancel-file').addEventListener('click',  () => { d.remove(); retirementPending = false; });
}

/* Single entry the Retire button calls: if a TP artefact is present, start the
   file-via-button confirm flow and return true; otherwise return false so the
   caller falls back to the bfn retirement turn (confirmRetirement). */
function retireFile() {
  const tp = findTpArtefact();
  if (tp) { confirmSuperTFiling(tp); return true; }
  return false;
}
