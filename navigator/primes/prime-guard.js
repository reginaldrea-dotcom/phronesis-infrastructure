/* ── prime-guard.js — accidental-close guard (shared) ──
   A Prime browser tab has no recovery: closing argos.html / connie.html ends the
   session, and if no Super-T was filed the work is gone (unlike .ai mode, which
   reopens the same thread). This arms the browser's native "Leave site?" confirm
   whenever a live, unretired session exists, so a stray click on the tab's X, a
   Ctrl-W, or an accidental refresh prompts instead of silently discarding.

   `sessionClosed` is set true on a clean retirement (triggerRetirement / the shared
   fileSuperT) so the confirm doesn't misleadingly fire straight after "Session
   closed", and reset false when a new/continued session begins. Global, shared with
   the session module; depends on the global `sessionId` (state). Loaded by both
   interfaces, after the retire module and before session/init. */
var sessionClosed = false;

window.addEventListener('beforeunload', function (e) {
  // Warn only when there's a live session worth protecting.
  if (typeof sessionId !== 'undefined' && sessionId && !sessionClosed) {
    e.preventDefault();
    e.returnValue = '';   // required to trigger the native confirmation dialog
  }
});
