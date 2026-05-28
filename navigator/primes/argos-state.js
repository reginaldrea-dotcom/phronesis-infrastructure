/* ── argos-state.js ── Session state variables and DOM refs ── */
/* State */
var sessionId            = null;
var orientationCost      = 0;
var currentContextTokens = 0;
/* Load score — weighted session load, computed by interface from SQL in tool calls.
   Not reported by Argos, not held in session memory. Resets to 0 at session start. */
var loadScore            = 0;
var loadTerminal         = false;
var pinnedTurns          = [];
var artefacts            = [];
var pendingImage         = null;
var pendingFile          = null;
var retirementShown      = false;
var retirementPending    = false;
var cachedWakeContent    = null;
var cachedWakeUsage         = null;
var pendingOrientationUsage = null;
var lastWakeTimestamp    = null;
var isWaking             = false;
var turnSequence         = 0;
var countdownInterval    = null;
var invokeController     = null;
/* DOM refs — assigned in argos-init.js */
var conv;
var thinking;
var inputEl;
var btnSend;
var btnNew;
var btnContinue;
var tokenFill;
var tokenLabel;
var loadFill;
var loadScoreEl;
var loadLabel;
var sessionDisp;
var errorState;
var fileInput;
var imgPreview;
var previewImg;
var previewName;
var panelEl;
var panelToggle;
var panelBadge;
var pannedSection;
var pinnedList;
var artefactsSection;
var artefactsList;
var panelEmpty;
var btnStop;
