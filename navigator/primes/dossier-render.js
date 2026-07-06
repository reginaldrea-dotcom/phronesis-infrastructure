/* dossier-render.js — universal Dossier page render (Eames brief c639a489 + addendum; arch 3f322400 §8).
 *
 * A Dossier is UNIVERSAL research on a subject: PII-free, broadly shareable, NO "prepared for X", NO
 * confidentiality notice (those belong only to personal Slices). Distinct object from the session render
 * (theo.html/theo-render.js) — its own module by design (the two are meant to diverge). PHASE 1 (this file):
 * the page SHELL — header, two-column body, the three rail panels, "Executive Summary" + chapter prose.
 * PHASE 2 (data-bound, held for Angelia grounding + Leg-3 + the claim->ground_fact linkage): the Ground
 * Facts panel CONTENT, tier-gated render states, and descend-to-evidence — marked TODO(phase2) below, and
 * the point at which the shared claim/citation/tier components get extracted from theo-render.js.
 *
 * URL: dossier.html?session=<uuid>  (a Dossier is rendered over a research session; the subject is the
 * research topic, which MUST be PII-free — see the header note).
 */
(function () {
  var root = document.getElementById('dossier-root');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function qs(name) { return new URLSearchParams(location.search).get(name); }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  /* Minimal GFM-subset prose renderer (headings, bold/italic/code, links, lists). Kept small and local for
     the Phase-1 shell; consolidates with theo-render.js's md() into a shared module in Phase 2. */
  function mdInline(s) {
    return s
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, function (_, t, u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>'; })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function md(text) {
    var lines = String(text == null ? '' : text).split('\n'), out = [], i = 0, para = [];
    function flush() { if (para.length) { out.push('<p>' + mdInline(esc(para.join(' '))) + '</p>'); para = []; } }
    while (i < lines.length) {
      var line = lines[i], t = line.trim();
      var h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flush(); var lvl = Math.min(h[1].length + 1, 4); out.push('<h' + lvl + '>' + mdInline(esc(h[2])) + '</h' + lvl + '>'); i++; continue; }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        flush(); var ordered = /^\s*\d+\./.test(line), items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')); i++; }
        out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.map(function (it) { return '<li>' + mdInline(esc(it)) + '</li>'; }).join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
        continue;
      }
      if (!t) { flush(); i++; continue; }
      para.push(t); i++;
    }
    flush();
    return out.join('');
  }

  function fetchDossier(sessionId) {
    return fetch(RENDER_CONFIG.renderDataUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': RENDER_CONFIG.supabaseKey, 'Authorization': 'Bearer ' + RENDER_CONFIG.supabaseKey },
      body: JSON.stringify({ session_id: sessionId }),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
      return r.json();
    });
  }

  /* ── header (universal, PII-free) ──────────────────────────────
     Subject = the research topic. NOTE: a universal Dossier's subject MUST be PII-free — it is a topic,
     not a person. The session's display_title/refined_prompt is used as the subject here; a Dossier built
     from a personally-framed session ("X's interview prep") would leak PII, so the subject should be a
     research topic. Subject sourcing / PII-scrub is a content concern (Theo) flagged, not hard-enforced here. */
  function subjectOf(d) {
    var s = d.session || {};
    if (s.display_title && String(s.display_title).trim()) return String(s.display_title).trim();
    var rp = (s.refined_prompt || s.original_brief || '').trim();
    if (rp) { var first = (rp.split(/(?<=[.?!])\s/)[0] || rp).trim(); return first.length > 90 ? first.slice(0, 90).trim() + '…' : first; }
    return 'Research subject';
  }
  function renderHeader(d) {
    var nQ = (d.questions || []).length;
    var nSources = (d.engines || []).reduce(function (a, e) { return a + (e.source_count || 0); }, 0);
    var updated = fmtDate((d.session || {}).delivered_at || (d.session || {}).created_at);
    var meta = nQ + ' question' + (nQ === 1 ? '' : 's') +
      '<span class="dot">·</span>' + nSources + ' source' + (nSources === 1 ? '' : 's') +
      (updated ? '<span class="dot">·</span>updated ' + esc(updated) : '');
    return '<div class="dossier-header">' +
      '<div class="dossier-kicker">Dossier</div>' +
      '<h1 class="dossier-title">' + esc(subjectOf(d)) + '</h1>' +
      '<div class="dossier-descriptor">Universal research briefing on the subject above.</div>' +
      '<div class="dossier-meta">' + meta + '</div>' +
    '</div>';
  }

  /* ── left rail: three panels ───────────────────────────────── */
  function renderGroundFactsPanel(/* d */) {
    // TODO(phase2): populate from ground_fact (via the derivation views + the dossier EF carrying
    // ground_fact rows + source_document_id for the §7 Grade-0 "view frozen capture" leaf). Quiet when empty.
    return '<div class="rail-panel"><div class="rail-panel-label">Ground facts</div>' +
      '<div class="rail-empty">Anchored sources appear here as the subject is grounded (tier, contestability, and a link to the frozen capture).</div>' +
    '</div>';
  }
  function renderAdjustPanel(/* d */) {
    // Dormant/inert for qualitative dossiers; the live zoom for quantitative (AESSEAL).
    return '<div class="rail-panel dormant"><div class="rail-panel-label">Adjust estimates</div>' +
      '<div class="rail-empty">Inactive for this dossier (qualitative). Live for quantitative dossiers.</div>' +
    '</div>';
  }
  function renderAssetsPanel(/* d */) {
    // PERSONAL overlay — slices + print/download + "prepared for X". PII lives here. Rendered ONLY in a
    // permissioned personal view; ABSENT from the universal default. Stubbed behind the permission flag
    // until Aegis's access model lands (default: not a personal view -> omitted entirely).
    if (typeof window === 'undefined' || !window.DOSSIER_PERSONAL_VIEW) return '';
    return '<div class="rail-panel"><div class="rail-panel-label">Assets (personal)</div>' +
      '<div class="rail-empty">Slices, print/download, and recipient framing render here in the permissioned personal view. [permission gate stub]</div>' +
    '</div>';
  }

  /* ── main column: Executive Summary + chapters ─────────────── */
  function pickExecSummary(d) {
    var secs = d.sections || [];
    var pick = secs.filter(function (s) { return /summary|executive|answer|overview/i.test((s.section_type || '') + ' ' + (s.title || '')); })[0];
    if (pick) return pick.content_md;
    if (secs.length) return secs[0].content_md;
    var m = d.synthesis && d.synthesis.layer_1_synthesis_md;
    if (m) return m.split(/\n{2,}/).slice(0, 2).join('\n\n');
    return '';
  }
  function renderMain(d) {
    var summarySrc = pickExecSummary(d);
    var html = '<div class="dossier-main">';
    html += '<div class="dossier-section exec-summary"><h2>Executive Summary</h2>' +
      '<div class="dossier-prose">' + (summarySrc ? md(summarySrc) : '<p><em>Executive summary pending.</em></p>') + '</div></div>';

    // Chapters = the synthesis sections (excluding the one used as the exec summary). Descend-to-evidence
    // from a claim is TODO(phase2): claim -> chapter -> ground_fact -> §7 Grade-0 frozen capture leaf.
    var secs = (d.sections || []);
    var usedTitle = (secs.filter(function (s) { return /summary|executive|answer|overview/i.test((s.section_type || '') + ' ' + (s.title || '')); })[0] || {}).id;
    var chapters = secs.filter(function (s) { return s.id !== usedTitle; });
    chapters.forEach(function (s) {
      html += '<div class="dossier-section">' +
        (s.title ? '<h3>' + esc(s.title) + '</h3>' : '') +
        '<div class="dossier-prose">' + md(s.content_md) + '</div>' +
      '</div>';
    });
    return html + '</div>';
  }

  function render(d) {
    var html = '<div class="dossier-shell">';
    html += renderHeader(d);
    html += '<div class="dossier-body">';
    html += '<div class="dossier-rail">' + renderGroundFactsPanel(d) + renderAdjustPanel(d) + renderAssetsPanel(d) + '</div>';
    html += renderMain(d);
    html += '</div></div>';
    root.innerHTML = html;
  }

  var sid = qs('session');
  if (!sid) { root.innerHTML = '<div class="render-status">No dossier specified — append <code>?session=&lt;uuid&gt;</code>.</div>'; return; }
  fetchDossier(sid).then(render).catch(function (e) {
    root.innerHTML = '<div class="render-error">Could not load this dossier: ' + esc(e.message) + '</div>';
  });
})();
