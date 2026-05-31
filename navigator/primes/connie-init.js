/* ── connie-init.js — theme application, static DOM init, event binding, boot ──
   Depends on: all prior modules loaded
   Runs on DOMContentLoaded. Calls wake() to boot.
*/

/* ── Apply theme ── */
const r = document.documentElement.style;
r.setProperty('--accent',        PRIME_CONFIG.accent);
r.setProperty('--accent-dim',    PRIME_CONFIG.accentDim);
r.setProperty('--accent-border', PRIME_CONFIG.accentBorder);
/* ── DOM ref assignment ── */
conv            = document.getElementById('conversation');
thinking        = document.getElementById('thinking');
inputEl         = document.getElementById('input');
btnSend = document.getElementById('btn-send');
btnStop = document.getElementById('btn-stop');
btnNew          = document.getElementById('btn-new-session');
btnContinue     = document.getElementById('btn-continue');
tokenFill       = document.getElementById('token-bar-fill');
tokenLabel      = document.getElementById('token-bar-label');
loadFill        = document.getElementById('load-gauge-fill');
loadScoreEl     = document.getElementById('load-gauge-score');
loadLabel       = document.getElementById('load-gauge-label');
sessionDisp     = document.getElementById('session-display');
errorState      = document.getElementById('error-state');
fileInput       = document.getElementById('file-input');
imgPreview      = document.getElementById('image-preview');
previewImg      = document.getElementById('preview-img');
previewName     = document.getElementById('preview-name');
panelEl         = document.getElementById('artefact-panel');
panelToggle     = document.getElementById('panel-toggle');
panelBadge      = document.getElementById('panel-badge');
pannedSection   = document.getElementById('panel-pinned-section');
pinnedList      = document.getElementById('panel-pinned-list');
artefactsSection = document.getElementById('panel-artefacts-section');
artefactsList   = document.getElementById('panel-artefacts-list');
panelEmpty      = document.getElementById('panel-empty');

/* ── Static DOM init ── */
document.getElementById('prime-icon').textContent        = PRIME_CONFIG.initial;
document.getElementById('prime-name').textContent        = PRIME_CONFIG.name;
document.getElementById('prime-role').textContent        = PRIME_CONFIG.role;
document.getElementById('input').placeholder             = PRIME_CONFIG.placeholder;
document.getElementById('nav-link').href                 = PRIME_CONFIG.navigatorUrl;
document.getElementById('instance-display').textContent  = 'Instance ' + PRIME_CONFIG.instanceId.slice(0,8);
document.getElementById('date-display').textContent      =
  new Date().toLocaleDateString('en-GB', {day:'numeric', month:'long', year:'numeric'});

/* ── Image / file handling ── */
document.getElementById('btn-attach').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const b64 = ev.target.result.split(',')[1];
    if (file.type.startsWith('image/')) {
      pendingImage = { data: b64, media_type: file.type };
      pendingFile = null;
      previewImg.src = ev.target.result;
      previewImg.style.display = '';
    } else {
      pendingFile = { data: b64, media_type: file.type, name: file.name };
      pendingImage = null;
      previewImg.src = '';
      previewImg.style.display = 'none';
    }
    previewName.textContent = file.name;
    imgPreview.classList.add('visible');
  };
  reader.readAsDataURL(file); fileInput.value = '';
});

document.getElementById('btn-remove-image').addEventListener('click', () => {
  pendingImage = null; pendingFile = null;
  imgPreview.classList.remove('visible');
  previewImg.src = ''; previewImg.style.display = '';
});

/* ── Button events ── */
btnSend.addEventListener('click', send);
btnStop.addEventListener('click', () => { if (invokeController) invokeController.abort(); });
btnNew.addEventListener('click', newSession);
btnContinue.addEventListener('click', continueSession);

document.getElementById('btn-retire').addEventListener('click', () => {
  const btn = document.getElementById('btn-retire');
  if (btn.dataset.confirming === 'true') {
    btn.textContent = 'Retire'; btn.dataset.confirming = 'false';
    // Retire-via-button (shared prime-retire.js): if a TP_Constantinople_* artefact is in
    // the panel, file it via the file_super_t action; no artefact → bfn retirement, unchanged.
    if (!retireFile()) confirmRetirement(true);
  } else {
    btn.textContent = 'Confirm?'; btn.dataset.confirming = 'true';
    setTimeout(() => { btn.textContent = 'Retire'; btn.dataset.confirming = 'false'; }, 3000);
  }
});

document.getElementById('panel-close').addEventListener('click', closePanel);
panelToggle.addEventListener('click', openPanel);

inputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
inputEl.addEventListener('input', () => { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px'; });

/* ── Boot ── */
wake();
