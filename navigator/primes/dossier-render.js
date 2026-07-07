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

  // Supporting-link curation (Theo b63ec6d5). The accept/reject affordances exist ONLY on the internal
  // Access-gated page, which sets window.DOSSIER_EDIT === true. The external token share (d.html) never
  // sets it, so a share reader gets no buttons and (see renderSectionFootLinks) sees accepted links only.
  function isEditor() { return typeof window !== 'undefined' && window.DOSSIER_EDIT === true; }
  function curateEndpoint() {
    return (typeof RENDER_CONFIG !== 'undefined' && RENDER_CONFIG.supabaseUrl)
      ? RENDER_CONFIG.supabaseUrl + '/functions/v1/dossier-curate-link' : '';
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
     Subject = theo_session.display_title (Eames 7f1156f6): a clean, curated title field. We do NOT read
     original_brief — it is the raw research instruction and carries PII (e.g. a named individual's
     situation), which must never reach the universal Dossier page (architecture §4/§8). The EF no longer
     ships original_brief at all; display_title is the single source for the header. */
  function subjectOf(d) {
    var s = d.session || {};
    return (s.display_title && String(s.display_title).trim()) || 'Research dossier';
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
  function renderGroundFactsPanel(d) {
    var facts = (d.ground_facts || []);
    var n = facts.length;
    // Count visible in the label ("N grounded sources"); the rows sit in a SCROLL region (below) so a
    // long list never drops facts off the bottom unreachable (Eames refinement 4ed7084a — scroll, not slider).
    var head = '<div class="rail-panel"><div class="rail-panel-label">' +
      (n ? n + ' grounded source' + (n === 1 ? '' : 's') : 'Grounded sources') + '</div>';
    if (!n) {
      return head + '<div class="rail-empty">Anchored sources appear here as the subject is grounded — each with its verification state, a frozen screenshot, and a neutral web-archive link.</div></div>';
    }
    var rows = facts.map(function (f) {
      var tier = String(f.authority_tier || '').toLowerCase();
      // Two-badge verification (design a656ff1d). "anchored" is EARNED, not assumed-from-a-URL:
      //   anchored          — numeric fact whose figure was found on the rendered page.
      //   screenshot_review — qualitative fact, screenshot frozen, a human confirms it supports the claim.
      //   cited_not_verified— capture failed or the figure was not on the page. Never reads as solid.
      var state = f.verification_state || 'cited_not_verified';
      var stateCls, stateLabel, stateTitle;
      if (state === 'anchored') {
        stateCls = 'gf-anchored'; stateLabel = 'anchored';
        stateTitle = 'The stated figure was found on the rendered, frozen page.';
      } else if (state === 'screenshot_review') {
        stateCls = 'gf-review'; stateLabel = 'needs review';
        stateTitle = 'A full-page screenshot is frozen; a human confirms it supports the claim.';
      } else {
        stateCls = 'gf-unverified'; stateLabel = 'unverified';
        stateTitle = 'The source could not be verified — figure not found on the page, or the page could not be captured.';
      }
      var stateBadge = '<span class="' + stateCls + '" title="' + esc(stateTitle) + '">' + stateLabel + '</span>';

      // Evidence links: the frozen screenshot (our permanent capture), the Wayback archive (neutral
      // third party), and the live source. Show whichever exist.
      var links = [];
      if (f.screenshot_url) links.push('<a class="gf-link" href="' + esc(f.screenshot_url) + '" target="_blank" rel="noopener">frozen screenshot</a>');
      if (f.archive_url)    links.push('<a class="gf-link" href="' + esc(f.archive_url) + '" target="_blank" rel="noopener">web archive</a>');
      if (f.source_url)     links.push('<a class="gf-link gf-link-src" href="' + esc(f.source_url) + '" target="_blank" rel="noopener">source</a>');
      var linksRow = links.length ? '<div class="gf-links">' + links.join('<span class="gf-link-sep">·</span>') + '</div>' : '';

      // Inline screenshot thumbnail — the visible proof, click to open the full frozen capture.
      var thumb = f.screenshot_url
        ? '<a class="gf-shot" href="' + esc(f.screenshot_url) + '" target="_blank" rel="noopener" title="Open the full frozen capture"><img loading="lazy" alt="Frozen screenshot of the source" src="' + esc(f.screenshot_url) + '"></a>'
        : '';

      var meta = '<span class="gf-tier ' + esc(tier) + '">' + esc(f.authority_tier || '?') + '</span>' +
        stateBadge +
        (f.review_state === 'pending' ? '<span class="gf-review-pill" title="Awaiting Argos/Reg review">review</span>' : '') +
        (f.contestability ? '<span>' + esc(f.contestability) + '</span>' : '') +
        (f.in_conflict ? '<span class="gf-conflict">conflict</span>' : '') +
        (f.freshness_status && f.freshness_status !== 'current' && f.freshness_status !== 'still_valid' ? '<span class="gf-stale">' + esc(f.freshness_status) + '</span>' : '');
      return '<div class="gf-row gf-row-' + state + '"><div class="gf-title">' + esc(f.title || '(untitled fact)') + '</div>' +
        '<div class="gf-meta">' + meta + '</div>' + thumb + linksRow + '</div>';
    }).join('');
    return head + '<div class="gf-scroll">' + rows + '</div></div>';
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
  // The short LABEL shared by call-out N and section N (the "§3 · <label>" identity). The section title.
  function labelOf(s, idx) { return (s.title && String(s.title).trim()) || ('Section ' + (idx + 1)); }
  // Per-section identity HUE — evenly spaced, applied only as a low-saturation LEFT-EDGE rule (reinforcement,
  // never a fill). Structure never depends on it: number + label + sticky header + collapse carry it alone
  // (Eames 4ed7084a — must survive colour-off). Same idx in L0 and L1 -> the call-out and its section match.
  function hueFor(idx, n) { return Math.round((idx * 360) / Math.max(n, 1)); }

  // L0 — the call-out stack. Each call-out is a door to its Full Synthesis section, carrying the shared
  // "§N · label" identity (legible in words, not just hue) plus the section's thesis line.
  function renderL0(secs) {
    if (!secs.length) return '<div class="dossier-section exec-summary"><h2>Executive Summary</h2><div class="dossier-prose"><p><em>Executive summary pending — one call-out per section.</em></p></div></div>';
    var n = secs.length;
    var items = secs.map(function (s, idx) {
      return '<a class="callout" data-idx="' + idx + '" href="#' + sectionAnchor(s, idx) + '" style="--sec-hue:' + hueFor(idx, n) + '">' +
        '<span class="callout-num">§' + (idx + 1) + '</span>' +
        '<span class="callout-body">' +
          '<span class="callout-label">' + esc(labelOf(s, idx)) + '</span>' +
          '<span class="callout-text">' + mdInline(esc(calloutOf(s))) + '</span>' +
        '</span>' +
      '</a>';
    }).join('');
    return '<div class="dossier-section exec-summary"><h2>Executive Summary</h2>' +
      '<div class="callout-stack">' + items + '</div></div>';
  }

  // Per-section confidence — the tier-composition of the facts this section's claims rest on
  // (render_section_confidence_v1, via synthesis_claim.section_id -> element_dependency). Live once claims
  // are grounded with claim_on_fact edges; 'ungrounded' until then.
  var CONF_LABEL = { ok: 'well grounded', needs_corroboration: 'needs corroboration', tier_conflict: 'sources conflict', sparse_record: 'sparse record', ungrounded: 'not yet grounded' };
  var CONF_CLASS = { ok: 'conf-ok', needs_corroboration: 'conf-needs-corroboration', tier_conflict: 'conf-tier-conflict', sparse_record: 'conf-sparse-record', ungrounded: 'conf-ungrounded' };
  function renderConfidence(d, s) {
    var st = (s && s.confidence_state) || 'ungrounded';
    var cls = CONF_CLASS[st] || 'conf-ungrounded';
    var g = (s && s.grounded_claim_count) || 0, n = (s && s.claim_count) || 0;
    var detail = n ? ' (' + g + '/' + n + ' claims grounded)' : '';
    return '<span class="confidence ' + cls + '" title="Per-section confidence, derived from the evidence tiers of this section’s claims.' + esc(detail) + '">' + (CONF_LABEL[st] || st) + '</span>';
  }

  function domainOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

  // Section-foot links (Eames c639a489 / 190f3512): TWO epistemic zones, which must never blur.
  //   GROUNDED SOURCES  — the section's anchored facts (verified, tier-badged, frozen). The solid spine.
  //   SUPPORTING LINKS  — ~6 curated engine links, NOT verified, perishable; domain shown, quieter than
  //                       grounded, with a "(valid: DATE)" zone header. A promotion "waiting room".
  // Colour marks the category boundary (a quiet neutral tint/left-rule on Supporting), never per-link;
  // Supporting always reads lighter than Grounded.
  function renderSectionFootLinks(s) {
    var grounded = s.grounded_sources || [];
    // Supporting links carry a review status (Theo b63ec6d5): pending | accepted | rejected (absent ===
    // pending). Rejected are NEVER shown; pending shows to an editor only; external readers see accepted
    // only — so no unreviewed/dead link leaks onto a shared dossier. Accepted sort first.
    var editor = isEditor();
    var supporting = (s.support_links || []).filter(function (l) {
      var st = (l && l.status) || 'pending';
      if (st === 'rejected') return false;
      if (st === 'accepted') return true;
      return editor;
    }).slice().sort(function (a, b) {
      return (((a && a.status) === 'accepted') ? 0 : 1) - (((b && b.status) === 'accepted') ? 0 : 1);
    });
    if (!grounded.length && !supporting.length) return '';
    var html = '<div class="section-links">';
    if (grounded.length) {
      var grows = grounded.map(function (f) {
        var tier = String(f.authority_tier || '').toLowerCase();
        var st = f.verification_state || 'cited_not_verified';
        var cls = st === 'anchored' ? 'gf-anchored' : (st === 'screenshot_review' ? 'gf-review' : 'gf-unverified');
        var lbl = st === 'anchored' ? 'anchored' : (st === 'screenshot_review' ? 'needs review' : 'unverified');
        var links = [];
        if (f.screenshot_url) links.push('<a class="gf-link" href="' + esc(f.screenshot_url) + '" target="_blank" rel="noopener">frozen screenshot</a>');
        if (f.archive_url)    links.push('<a class="gf-link" href="' + esc(f.archive_url) + '" target="_blank" rel="noopener">web archive</a>');
        if (f.source_url)     links.push('<a class="gf-link gf-link-src" href="' + esc(f.source_url) + '" target="_blank" rel="noopener">source</a>');
        return '<div class="sl-grounded-row">' +
          '<span class="gf-tier ' + esc(tier) + '">' + esc(f.authority_tier || '?') + '</span>' +
          '<span class="' + cls + '">' + lbl + '</span>' +
          '<span class="sl-g-title">' + esc(f.title || '(untitled)') + '</span>' +
          (links.length ? '<span class="sl-g-links">' + links.join('<span class="gf-link-sep">·</span>') + '</span>' : '') +
        '</div>';
      }).join('');
      html += '<div class="sl-grounded"><div class="sl-head">Grounded sources</div>' + grows + '</div>';
    }
    if (supporting.length) {
      var v = s.support_links_valid_as_of;
      var valid = v ? ' <span class="sl-valid">(valid: ' + esc(fmtDate(v) || v) + ')</span>' : '';
      var srows = supporting.map(function (l) {
        var url = (l && l.url) ? String(l.url) : '';
        if (!url) return '';
        var dom = (l.domain && String(l.domain)) || domainOf(url);
        var title = (l.title && String(l.title)) || '';
        var note = (l.note && String(l.note)) || '';
        var accepted = ((l && l.status) === 'accepted');
        // Buttons render for an editor on unreviewed (pending) links only; accepted links show a confirmed
        // dot and no buttons. The write is auth-gated server-side (dossier-curate-link) — buttons are UX.
        var btns = (editor && !accepted)
          ? '<span class="sl-curate">' +
              '<button type="button" class="sl-acc" data-url="' + esc(url) + '" data-act="accepted" title="Accept" aria-label="Accept link">&#10003;</button>' +
              '<button type="button" class="sl-rej" data-url="' + esc(url) + '" data-act="rejected" title="Reject" aria-label="Reject link">&#10007;</button>' +
            '</span>'
          : '';
        return '<div class="sl-support-row' + (accepted ? ' is-accepted' : '') + '" data-url="' + esc(url) + '">' +
          (accepted ? '<span class="sl-accepted-dot" title="Accepted" aria-label="Accepted">&#9679;</span>' : '') +
          '<a class="sl-support-link" href="' + esc(url) + '" target="_blank" rel="noopener">' +
            '<span class="sl-domain">' + esc(dom) + '</span>' +
            (title ? '<span class="sl-support-title">' + esc(title) + '</span>' : '') +
          '</a>' +
          (note ? '<span class="sl-support-note">' + esc(note) + '</span>' : '') +
          btns +
        '</div>';
      }).join('');
      html += '<div class="sl-supporting" data-section="' + esc(s.id) + '"><div class="sl-head sl-support-head">Supporting links' + valid + '</div>' + srows + '</div>';
    }
    return html + '</div>';
  }

  // L1 — the full synthesis sections. Each is COLLAPSIBLE and opens headers-only on first load, so the
  // synthesis reads as a scannable stack of §N · label headers (structure undeniable) rather than one
  // undifferentiated scroll. The header is a STICKY button (stays pinned while scrolling a long section,
  // so you always know which section you are in) carrying the shared identity + per-section confidence.
  function renderL1(d, secs) {
    if (!secs.length) return '<div class="dossier-section"><div class="dossier-prose"><p><em>Full synthesis pending.</em></p></div></div>';
    var n = secs.length;
    return secs.map(function (s, idx) {
      return '<section class="dossier-section synthesis-section collapsed" id="' + sectionAnchor(s, idx) + '" data-idx="' + idx + '" style="--sec-hue:' + hueFor(idx, n) + '">' +
        '<button type="button" class="section-head" aria-expanded="false">' +
          '<span class="section-caret" aria-hidden="true"></span>' +
          '<span class="section-id">§' + (idx + 1) + ' · ' + esc(labelOf(s, idx)) + '</span>' +
          renderConfidence(d, s) +
        '</button>' +
        '<div class="section-body"><div class="dossier-prose">' + md(s.content_md) + '</div>' + renderSectionFootLinks(s) + '</div>' +
      '</section>';
    }).join('');
  }

  // L3 (engine workings) is deliberately NOT rendered. The link pointed at theo.html — which is not on the
  // public share host, so it could never be viewed there — and, more importantly, the engine workings expose
  // the underlying dispatches (here, an individual's job search) which must NOT be shared. Removed until a
  // reviewed way to surface workings safely exists (Reg, 7 Jul).
  function renderMain(d) {
    var secs = sectionsOrdered(d);
    return '<div class="dossier-main">' +
      renderL0(secs) +
      '<div class="layer-divider"><span>Full synthesis</span>' +
        (secs.length ? '<button type="button" class="expand-all" data-mode="expand">Expand all</button>' : '') +
      '</div>' +
      renderL1(d, secs) +
    '</div>';
  }

  // Post a support-link accept/reject. Optimistic: the row is already updated in the DOM by the caller-side
  // change here; on write failure we revert and surface the error. Matches only by (section, url).
  function curateSupportLink(sectionId, url, act, row) {
    var ep = curateEndpoint();
    if (!ep || !row) return;
    var parent = row.parentNode;
    var nextSibling = row.nextSibling;
    var prevClass = row.className;
    var btnBar = row.querySelector('.sl-curate');
    row.querySelectorAll('.sl-acc, .sl-rej').forEach(function (x) { x.disabled = true; });
    // Optimistic UI.
    if (act === 'rejected') {
      row.style.display = 'none';
    } else {
      if (btnBar) btnBar.remove();
      if (!row.querySelector('.sl-accepted-dot')) {
        var dot = document.createElement('span');
        dot.className = 'sl-accepted-dot'; dot.title = 'Accepted'; dot.setAttribute('aria-label', 'Accepted');
        dot.innerHTML = '&#9679;';
        row.insertBefore(dot, row.firstChild);
      }
      row.classList.add('is-accepted');
      var head = parent && parent.querySelector('.sl-head');           // hoist accepted to the top of the list
      if (parent && head && head.nextSibling !== row) parent.insertBefore(row, head.nextSibling);
    }
    fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': RENDER_CONFIG.supabaseKey, 'Authorization': 'Bearer ' + RENDER_CONFIG.supabaseKey },
      body: JSON.stringify({ section_id: sectionId, url: url, action: act }),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
      return r.json();
    }).catch(function (err) {
      // Revert to the pre-click state.
      row.style.display = '';
      row.className = prevClass;
      var d = row.querySelector('.sl-accepted-dot'); if (d && act === 'accepted') d.remove();
      if (parent) { if (nextSibling) parent.insertBefore(row, nextSibling); else parent.appendChild(row); }
      if (act === 'accepted' && !row.querySelector('.sl-curate')) {
        var u = esc(url);
        var span = document.createElement('span');
        span.className = 'sl-curate';
        span.innerHTML = '<button type="button" class="sl-acc" data-url="' + u + '" data-act="accepted" title="Accept" aria-label="Accept link">&#10003;</button>' +
                         '<button type="button" class="sl-rej" data-url="' + u + '" data-act="rejected" title="Reject" aria-label="Reject link">&#10007;</button>';
        row.appendChild(span);
      } else {
        row.querySelectorAll('.sl-acc, .sl-rej').forEach(function (x) { x.disabled = false; });
      }
      if (typeof console !== 'undefined') console.error('curate failed', err);
      alert('Could not save that change: ' + (err && err.message ? err.message : 'unknown error'));
    });
  }

  // Post-render wiring: collapse toggles, expand/collapse-all, call-out-opens-target, and a scroll-spy that
  // marks the active section (and its matching call-out). All progressive-enhancement — the page is fully
  // legible with JS off (sections just render open) and with colour off (identity is number + label).
  function wireInteractions() {
    var main = root.querySelector('.dossier-main');
    if (!main) return;
    function setExpanded(sec, open) {
      sec.classList.toggle('collapsed', !open);
      var h = sec.querySelector('.section-head'); if (h) h.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    // Toggle a section by clicking its header.
    main.addEventListener('click', function (e) {
      var head = e.target.closest && e.target.closest('.section-head');
      if (head && main.contains(head)) { var sec = head.parentNode; setExpanded(sec, sec.classList.contains('collapsed')); }
    });
    // Expand all / collapse all.
    var btn = main.querySelector('.expand-all');
    if (btn) btn.addEventListener('click', function () {
      var expand = btn.getAttribute('data-mode') === 'expand';
      main.querySelectorAll('.synthesis-section').forEach(function (sec) { setExpanded(sec, expand); });
      btn.setAttribute('data-mode', expand ? 'collapse' : 'expand');
      btn.textContent = expand ? 'Collapse all' : 'Expand all';
    });
    // A call-out opens its target section before the anchor jump lands (so you don't land on a closed header).
    root.addEventListener('click', function (e) {
      var call = e.target.closest && e.target.closest('.callout');
      if (!call) return;
      var sec = main.querySelector('.synthesis-section[data-idx="' + call.getAttribute('data-idx') + '"]');
      if (sec) setExpanded(sec, true);
    });
    // Supporting-link accept/reject (editor only; buttons only exist when isEditor()). Optimistic UI: the
    // row updates immediately, then the write is posted. On write failure we revert and surface it.
    main.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.sl-acc, .sl-rej');
      if (!b || b.disabled) return;
      e.preventDefault();
      var wrap = b.closest('.sl-supporting');
      var row = b.closest('.sl-support-row');
      var sectionId = wrap && wrap.getAttribute('data-section');
      var url = b.getAttribute('data-url');
      var act = b.getAttribute('data-act');
      if (!sectionId || !url) return;
      curateSupportLink(sectionId, url, act, row);
    });
    // Scroll-spy: mark the section nearest the top as active (neutral shading, distinct from identity hue),
    // and mirror it onto the matching call-out. Bonus cue; structure does not depend on it.
    var secs = Array.prototype.slice.call(main.querySelectorAll('.synthesis-section'));
    if (secs.length && 'IntersectionObserver' in window) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) setActive(en.target.getAttribute('data-idx')); });
      }, { rootMargin: '0px 0px -75% 0px', threshold: 0 });
      secs.forEach(function (s) { obs.observe(s); });
    }
    function setActive(idx) {
      main.querySelectorAll('.synthesis-section.is-active').forEach(function (s) { s.classList.remove('is-active'); });
      root.querySelectorAll('.callout.is-active').forEach(function (c) { c.classList.remove('is-active'); });
      var sec = main.querySelector('.synthesis-section[data-idx="' + idx + '"]'); if (sec) sec.classList.add('is-active');
      var call = root.querySelector('.callout[data-idx="' + idx + '"]'); if (call) call.classList.add('is-active');
    }
  }

  function render(d) {
    var html = '<div class="dossier-shell">';
    html += renderHeader(d);
    html += '<div class="dossier-body">';
    html += '<div class="dossier-rail">' + renderGroundFactsPanel(d) + renderAdjustPanel(d) + renderAssetsPanel(d) + '</div>';
    html += renderMain(d);
    html += '</div></div>';
    root.innerHTML = html;
    wireInteractions();
  }

  // Session id from ?session= (page behind Cloudflare Access) OR window.RENDER_SESSION_ID (set by the
  // token-gated public share page d.html after resolve_dossier_share — the capability-link path).
  var sid = qs('session') || (typeof window !== 'undefined' ? window.RENDER_SESSION_ID : null);
  if (!sid) { root.innerHTML = '<div class="render-status">No dossier specified — append <code>?session=&lt;uuid&gt;</code>.</div>'; return; }
  fetchDossier(sid).then(render).catch(function (e) {
    root.innerHTML = '<div class="render-error">Could not load this dossier: ' + esc(e.message) + '</div>';
  });
})();
