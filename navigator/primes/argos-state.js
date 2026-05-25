/* ── argos-state.js ── Mutable session state and DOM refs ── */

/* Session state */
let sessionId            = null;
let orientationCost      = 0;     // input tokens consumed by wake (fixed overhead)
let currentContextTokens = 0;     // input tokens of most recent request (grows with conversation)
let pinnedTurns          = [];
let artefacts            = [];
let pendingImage         = null;
let pendingFile          = null;
let retirementShown      = false;
let retirementPending    = false;
let cachedWakeContent    = null;
let lastWakeTimestamp    = null;
let isWaking             = false;
let turnSequence         = 0;
let countdownInterval    = null;

/* DOM refs — populated after DOMContentLoaded */
let conv, thinking, inputEl, btnSend, btnNew, btnContinue;
let tokenFill, tokenLabel, sessionDisp, errorState;
let fileInput, imgPreview, previewImg, previewName;
let panelEl, panelToggle, panelBadge;
let pannedSection, pinnedList, artefactsSection, artefactsList, panelEmpty;

function initDomRefs() {
  conv             = document.getElementById('conversation');
  thinking         = document.getElementById('thinking');
  inputEl          = document.getElementById('input');
  btnSend          = document.getElementById('btn-send');
  btnNew           = document.getElementById('btn-new-session');
  btnContinue      = document.getElementById('btn-continue');
  tokenFill        = document.getElementById('token-bar-fill');
  tokenLabel       = document.getElementById('token-bar-label');
  sessionDisp      = document.getElementById('session-display');
  errorState       = document.getElementById('error-state');
  fileInput        = document.getElementById('file-input');
  imgPreview       = document.getElementById('image-preview');
  previewImg       = document.getElementById('preview-img');
  previewName      = document.getElementById('preview-name');
  panelEl          = document.getElementById('artefact-panel');
  panelToggle      = document.getElementById('panel-toggle');
  panelBadge       = document.getElementById('panel-badge');
  pannedSection    = document.getElementById('panel-pinned-section');
  pinnedList       = document.getElementById('panel-pinned-list');
  artefactsSection = document.getElementById('panel-artefacts-section');
  artefactsList    = document.getElementById('panel-artefacts-list');
  panelEmpty       = document.getElementById('panel-empty');
}

/* Shared DOM helpers */
function esc(s)       { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function timeStr()    { return new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }
function todayStr()   { return new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}); }
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }
function scrollBottom(){ conv.scrollTop = conv.scrollHeight; }
function insertBefore(el) { conv.insertBefore(el, thinking); }
