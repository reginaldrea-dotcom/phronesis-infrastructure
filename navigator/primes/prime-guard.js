/* ── prime-guard.js — unsaved-work guard (shared) ──
   The session now PERSISTS across tab-close: resumeOrWake() (session module) restores the
   same thread on reopen — context server-side, tail redrawn — until formal retirement. So a
   stray close is no longer destructive to the conversation, and we no longer warn on every
   live session (that would just be a nag).

   What a close CAN still lose is genuinely-unsaved work: text typed but not yet sent, or a
   request in flight. Warn only then, so the prompt is meaningful. (Note: browsers also require
   a prior interaction with the page before they will show this native dialog at all.)

   `sessionClosed` is set true on a clean retirement (triggerRetirement / the shared fileSuperT)
   and reset false when a new/continued/resumed session begins. Depends on the globals
   inputEl / invokeController / isWaking (state + session). Loaded by both interfaces. */
var sessionClosed = false;

window.addEventListener('beforeunload', function (e) {
  var hasUnsent = typeof inputEl !== 'undefined' && inputEl && inputEl.value.trim().length > 0;
  var inFlight  = (typeof invokeController !== 'undefined' && invokeController) ||
                  (typeof isWaking !== 'undefined' && isWaking);
  if ((hasUnsent || inFlight) && !sessionClosed) {
    e.preventDefault();
    e.returnValue = '';   // required to trigger the native confirmation dialog
  }
});
