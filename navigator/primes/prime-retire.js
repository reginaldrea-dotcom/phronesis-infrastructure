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
   [ARTEFACT: TP_<Name>_…]…[/ARTEFACT] block the Prime emits is parsed into a
   structured entry in artefacts[] (title + content) before it reaches here.
   The match pattern is derived per-Prime from PRIME_CONFIG.name — Argos →
   TP_Argos_…, Constantinople → TP_Constantinople_….

   Identity is the TP_<Name>_ prefix; the trailing ".md" is cosmetic and is NOT
   required, and the match is case-insensitive. The old strict /^TP_Argos_.*\.md$/
   rejected a well-formed TP titled "TP_Argos_2026-06-01_60" (no extension), which
   silently sent the Retire button down the bfn fallback and risked losing a
   retirement. Rejecting a real TP over a naming slip is far worse than occasionally
   matching a TP_-prefixed artefact, so this fails safe toward matching. */
function tpArtefactRe() {
  return new RegExp('^TP_' + PRIME_CONFIG.name + '_.+', 'i');
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
  /* R1 (bug 74711787): success requires a GENUINE new filing AND a real retirement. The EF now returns
     result_type='created' + retired=true only when it filed a fresh Super-T and flipped instance status;
     a no-op (idempotent_hit) or a failed status-flip comes back non-ok. Never report success otherwise. */
  if (!res.ok || !data || data.error || data.result_type !== 'created' || !data.retired || !data.sequence_number) {
    return fail((data && (data.message || data.error)) || ('HTTP ' + res.status));
  }

  /* Success — surface, close session, clear panel. */
  clearError();
  const ok = document.createElement('div'); ok.className = 'retirement-confirm';
  ok.textContent = `Super-T filed: ${tp.title} — seq ${data.sequence_number}, artifact ${data.artifact_id}`;
  insertBefore(ok);
  const closed = document.createElement('div'); closed.className = 'retirement-confirm';
  closed.textContent = `${PRIME_CONFIG.name} retired (status flipped) and session closed. ${PRIME_CONFIG.name} will remember.`;
  insertBefore(closed);
  sessionClosed = true;   // clean retirement — disarm the accidental-close guard
  clearPersistedSession();   // retirement is the only thing that ends the persistent thread
  inputEl.disabled = false; btnSend.disabled = false;   // allow a final goodbye after close
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

/* ── Verified-close gate (SHARED core) — invariant Connie 64e92800 + Eames ruling (baton 36be494a) ──
   This lives in the shared module ON PURPOSE so connie.html and argos.html inherit the FIX, not the
   per-Prime false close. Render "closed" AND the "will remember" continuity promise ONLY on a
   chain-VERIFIED Super-T landing this turn — data.super_t_filed, derived server-side from the chain head
   advancing, never a self-report (not HTTP 200, not a timeout, not the model saying done, not an artefact
   being present). 3-state, fail-safe (no optimistic close path):
     filed            -> closed + will-remember + clear the persistent thread;
     attempted, none  -> session STAYS OPEN, unmistakable, actionable next step (file then re-run Retire);
   (no-TP-at-click is handled pre-flight in confirmRetirement, before the turn runs).
   The per-Prime triggerRetirement delegates here; it must carry NO close logic of its own. */
function renderRetirementOutcome(data) {
  const filed = !!(data && data.super_t_filed);
  const d = document.createElement('div');
  d.className = 'retirement-confirm' + (filed ? '' : ' retire-failed');
  if (filed) {
    const seq = (data && data.super_t_sequence != null) ? ` (seq ${data.super_t_sequence})` : '';
    d.textContent = `Session closed — Super-T filed${seq}, chain advanced. ${PRIME_CONFIG.name} will remember.`;
    insertBefore(d);
    sessionClosed = true;            // clean retirement — disarm the accidental-close guard
    clearPersistedSession();         // the only thing that ends the persistent thread
  } else {
    d.textContent = `⚠ RETIREMENT NOT COMPLETE — no Super-T landed this turn (the chain head did not advance), so the session is STILL OPEN and this is NOT a clean handoff. ${PRIME_CONFIG.name} must file the Super-T (call file_super_t with the full transition) and then re-run Retire. Nothing was closed.`;
    insertBefore(d);
    // FAIL-SAFE: do NOT set sessionClosed, do NOT clearPersistedSession — the thread continues so the
    // filing can be retried. There is no optimistic close path.
  }
  scrollBottom();
}
