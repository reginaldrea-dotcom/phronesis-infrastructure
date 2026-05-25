/* ── argos-state.js ── Session state variables and DOM refs ── */

/* State */
let sessionId            = null;
let orientationCost      = 0;    // input tokens consumed by wake (fixed overhead)
let currentContextTokens = 0;    // input tokens of most recent request (grows with conversation)
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

/* DOM refs — assigned after DOMContentLoaded in argos-init.js */
let conv;
let thinking;
let inputEl;
let btnSend;
let btnNew;
let btnContinue;
let tokenFill;
let tokenLabel;
let sessionDisp;
let errorState;
let fileInput;
let imgPreview;
let previewImg;
let previewName;
let panelEl;
let panelToggle;
let panelBadge;
let pannedSection;
let pinnedList;
let artefactsSection;
let artefactsList;
let panelEmpty;
