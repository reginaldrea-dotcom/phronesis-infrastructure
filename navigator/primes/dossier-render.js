/* dossier-render.js — universal Dossier page render (Eames brief c639a489 + addendum; arch 3f322400 §8).
 *
 * A Dossier is UNIVERSAL research on a subject: PII-free, broadly shareable, NO "prepared for X", NO
 * confidentiality notice (those belong only to personal Slices). Distinct object from the session render
 * (theo.html/theo-render.js) — its own module by design (the two are meant to diverge). The main column is
 * a 4-LAYER progressive-disclosure descent over one spine (synthesis_section), per Eames 0515073a:
 * L0 Executive Summary (call-out stack) -> L1 Full Synthesis (full sections) -> L2 Evidence (per-claim
 * descent, data-bound) -> L3 Engine workings (the theo.html render, deepest). L0<->L1 mirror is structural
 * (callout_md / content_md per section, section_index order). DATA-BOUND, pending Angelia's grounding:
 * the Ground Facts panel content, per-section confidence (from element_dependency tiers), and the L2
 * per-claim descent leaf — placeholders until the claim_on_fact edges + per-section fact-tier path land.
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
     Subject = the ORIGINAL SEARCH BRIEF (Reg's rule: Dossiers are named by the brief that initiated them).
     The brief is the research topic, which must be PII-free (topic, not person) — a content concern at
     authoring, since a personally-framed brief would carry PII into a universal page. Take a concise slice
     of the brief for the title; fall back to display_title / refined_prompt only if there is no brief. */
  function subjectOf(d) {
    var s = d.session || {};
    var concise = function (t) { t = (t || '').trim(); if (!t) return ''; var f = (t.split(/(?<=[.?!])\s/)[0] || t).trim(); return f.length > 120 ? f.slice(0, 120).trim() + '…' : f; };
    return concise(s.original_brief) || (s.display_title && String(s.display_title).trim()) || concise(s.refined_prompt) || 'Research subject';
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

  /* ── main column: the 4-layer descent over one spine (Eames 0515073a / c639a489 addendum) ──────────
     Progressive disclosure, not one long document. The mirror is STRUCTURAL: each synthesis_section carries
     BOTH callout_md (its Exec-Summary thesis line) and content_md (its full prose), in section_index order,
     so call-out N <-> section N is guaranteed 1:1 with no hand-maintained correspondence.
       L0 Executive Summary = the stack of call-outs, each a door (anchor) to its L1 section.
       L1 Full Synthesis    = the sections in full, delineated, each with a per-section confidence indicator.
       L2 Evidence          = Ground Facts panel (rail) + per-claim descent (data-bound; TODO phase2).
       L3 Engine workings    = the existing theo.html research render, the DEEPEST descent, not the default. */
  function sectionsOrdered(d) {
    return (d.sections || []).slice().sort(function (a, b) { return (a.section_index || 0) - (b.section_index || 0); });
  }
  function sectionAnchor(s, idx) { return 'section-' + (s.section_index != null ? s.section_index : idx); }
  function calloutOf(s) {
    if (s.callout_md && String(s.callout_md).trim()) return String(s.callout_md).trim();
    // Fallback until Theo authors call-outs: the section's first sentence, else its title.
    var body = (s.content_md || '').trim();
    if (body) { var first = (body.replace(/^#+\s+.*$/m, '').trim().split(/(?<=[.?!])\s/)[0] || '').trim(); if (first) return first; }
    return s.title || '';
  }

  // L0 — the call-out stack. Each call-out is a door to its Full Synthesis section.
  function renderL0(secs) {
    if (!secs.length) return '<div class="dossier-section exec-summary"><h2>Executive Summary</h2><div class="dossier-prose"><p><em>Executive summary pending — one call-out per section.</em></p></div></div>';
    var items = secs.map(function (s, idx) {
      return '<a class="callout" href="#' + sectionAnchor(s, idx) + '">' +
        '<span class="callout-index">' + (idx + 1) + '</span>' +
        '<span class="callout-text">' + mdInline(esc(calloutOf(s))) + '</span>' +
      '</a>';
    }).join('');
    return '<div class="dossier-section exec-summary"><h2>Executive Summary</h2>' +
      '<div class="callout-stack">' + items + '</div></div>';
  }

  // Per-section confidence — derived from the tier-composition of the facts the section's claims rest on
  // (element_dependency). Data-bound: shows "ungrounded" until claim_on_fact edges land AND the per-section
  // fact-tier path is wired into the render data (a follow-on). Structural placeholder for now.
  function renderConfidence(/* d, s */) {
    return '<span class="confidence conf-ungrounded" title="Confidence derives from the evidence tiers of this section’s claims; shown once the section is grounded.">not yet grounded</span>';
  }

  // L1 — the full synthesis sections, delineated, in spine order, each an anchor target for its call-out.
  function renderL1(d, secs) {
    if (!secs.length) return '<div class="dossier-section"><div class="dossier-prose"><p><em>Full synthesis pending.</em></p></div></div>';
    return secs.map(function (s, idx) {
      return '<div class="dossier-section synthesis-section" id="' + sectionAnchor(s, idx) + '">' +
        '<div class="section-head"><h3>' + esc(s.title || ('Section ' + (idx + 1))) + '</h3>' + renderConfidence(d, s) + '</div>' +
        '<div class="dossier-prose">' + md(s.content_md) + '</div>' +
      '</div>';
    }).join('');
  }

  // L3 — the engine workings (existing session render), reachable as the deepest descent, not the default.
  function renderL3(d) {
    var sid = (d.session || {}).id || qs('session');
    return '<div class="engine-workings"><a href="theo.html?session=' + encodeURIComponent(sid) + '">' +
      'View the engine workings → the questions asked, the returns, and the sources (the deepest layer).</a></div>';
  }

  function renderMain(d) {
    var secs = sectionsOrdered(d);
    return '<div class="dossier-main">' +
      renderL0(secs) +
      '<div class="layer-divider"><span>Full synthesis</span></div>' +
      renderL1(d, secs) +
      renderL3(d) +
    '</div>';
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
