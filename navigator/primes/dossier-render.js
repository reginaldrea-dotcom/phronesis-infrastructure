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
      // include_unreviewed only on the internal editor page — the external share gets kept-only links.
      body: JSON.stringify({ session_id: sessionId, include_unreviewed: isEditor() }),
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

  /* ── interrogate surface v2 — anchor-quote first-class + inverted stamps (Eames SP 4985c519, Napoleon
     baton 629e4723) ──────────────────────────────────────────────────────────────────────────────────
     The deepest fix: we spent the anchor-hazard rebuild to hold a verbatim span from the source's own bytes,
     then showed the reader only the CONCLUSION of verification and never the THING VERIFIED. A badge ASSERTS;
     a quote DEMONSTRATES. So each load-bearing claim now shows the exact source sentence that anchors it —
     the quote is the visual centre of gravity, the stamps are trim. claim.grounding[] comes from
     theo-render-data: one entry per claim_on_fact edge, carrying the edge's anchor_quote (the quote belongs
     to the EDGE, not the fact — per-edge ruling 83163028), its verification_state, and the tier + document
     of what grounds it. */
  function claimsBySection(d) {
    var m = {};
    (d.claims || []).forEach(function (c) {
      var sid = c.section_id; if (!sid) return;
      (m[sid] = m[sid] || []).push(c);
    });
    return m;
  }

  // A verification MARK, sized by Eames's inversion: strength is RECESSIVE (small text mark, no filled
  // badge), caution is LOUD (filled tint). anchored = the figure was found verbatim in the source's frozen
  // bytes; screenshot_review = a human still confirms the frozen screenshot; cited_not_verified = a real
  // weakness. QUIET IS NOT ABSENT — an anchored mark is present-but-recessive, never removed (an unmarked
  // claim is indistinguishable from an unassessed one).
  function verificationMark(state) {
    if (state === 'anchored')          return { cls: 'av-anchored',   label: 'anchored', title: 'The stated figure was found verbatim in the source’s frozen page.' };
    if (state === 'screenshot_review') return { cls: 'av-review',     label: 'screenshot · pending review', title: 'A full-page screenshot is frozen; a human confirms it supports the claim.' };
    return { cls: 'av-unverified', label: 'unverified', title: 'Not verified — the figure was not found on the page, or the page could not be captured.' };
  }

  // One anchoring edge: the verbatim quote (centre of gravity, rendered visibly as THE SOURCE'S WORDS —
  // quotation via a serif blockquote on a distinct surface) + a trim line of mark + tier + document.
  function renderAnchorEdge(g) {
    var mark = verificationMark(g.verification_state);
    var tier = String(g.tier || '').toLowerCase();
    var doc = g.document_title
      ? (g.source_url
          ? '<a class="av-doc" href="' + esc(g.source_url) + '" target="_blank" rel="noopener">' + esc(g.document_title) + '</a>'
          : '<span class="av-doc">' + esc(g.document_title) + '</span>')
      : '';
    var quote = g.anchor_quote
      ? '<blockquote class="av-quote">' + esc(g.anchor_quote) + '</blockquote>'
      : '<div class="av-noquote">The co-locating span is not yet captured; the frozen screenshot is under review.</div>';
    var trim = '<div class="av-trim">' +
        '<span class="av-mark ' + mark.cls + '" title="' + esc(mark.title) + '">' + esc(mark.label) + '</span>' +
        (tier ? '<span class="gf-tier ' + esc(tier) + '">' + esc(g.tier) + '</span>' : '') +
        doc +
      '</div>';
    return '<div class="av-edge ' + mark.cls + '">' + quote + trim + '</div>';
  }

  // A single anchored claim: the claim, then the span(s) that anchor it. Anchored (strong) spans read first.
  function renderAnchorClaim(c) {
    var gs = (c.grounding || []).filter(Boolean);
    if (!gs.length) return '';
    var order = { anchored: 0, screenshot_review: 1, cited_not_verified: 2 };
    gs = gs.slice().sort(function (a, b) {
      var ra = order[a.verification_state]; var rb = order[b.verification_state];
      return (ra == null ? 3 : ra) - (rb == null ? 3 : rb);
    });
    return '<div class="anchor-claim">' +
        '<div class="ac-claim">' + esc(c.claim_text || '') + '</div>' +
        gs.map(renderAnchorEdge).join('') +
      '</div>';
  }

  // The worked-example rounding note (Eames §5): the five AESSEAL component figures sum to 294,999.65 t
  // against a stated 294,999.6 t. Displaying the quotes adjacently invites a numerate reader to do the
  // arithmetic, so we anticipate it with a quiet reconciliation note rather than claim a false exactness.
  // Rendered only in the section that actually carries the total figure (detected from its own spans).
  function roundingNote(claims) {
    var hit = (claims || []).some(function (c) {
      if (/294,999\.6\b/.test(c.claim_text || '')) return true;
      return (c.grounding || []).some(function (g) { return /294,999\.6\b/.test(g.anchor_quote || ''); });
    });
    if (!hit) return '';
    return '<div class="av-rounding">The five component figures sum to 294,999.65&nbsp;t; the report states 294,999.6&nbsp;t — consistent to rounding.</div>';
  }

  // The section's "what anchors this" zone — the receipt on the page, not one interaction away.
  function renderSectionAnchors(claims) {
    var withGrounding = (claims || []).filter(function (c) { return (c.grounding || []).length; });
    if (!withGrounding.length) return '';
    return '<div class="anchor-zone">' +
        '<div class="az-head">What anchors this section</div>' +
        withGrounding.map(renderAnchorClaim).join('') +
        roundingNote(claims) +
      '</div>';
  }

  // INVERTED STAMP DEFAULT — the section tab. Derived from what actually ANCHORS the section, not from
  // tier-composition alone: a section anchored to verbatim bytes wears NOTHING (quiet is the signal of
  // strength); prominence (a filled warning tint) is reserved for GENUINE caution — an unverified source or
  // a tier conflict. This fixes the false gestalt where a page of qualifiers reads "nothing here is solid"
  // when much of it is anchored (Reg: the old per-section tabs "just make it appear that everything is
  // uncertain"). A well-grounded section is silent; only a warning speaks.
  function sectionPosture(claims, confidenceState) {
    var edges = [];
    (claims || []).forEach(function (c) { (c.grounding || []).forEach(function (g) { edges.push(g); }); });
    var anchored = edges.some(function (g) { return g.verification_state === 'anchored'; });
    var weak     = edges.some(function (g) { return g.verification_state === 'cited_not_verified'; });
    var review   = edges.some(function (g) { return g.verification_state === 'screenshot_review'; });
    var hasClaims = (claims || []).length > 0;
    if (weak)                                return { salience: 'warn',  label: 'unverified source', title: 'A source in this section could not be verified.' };
    if (confidenceState === 'tier_conflict') return { salience: 'warn',  label: 'sources conflict', title: 'Sources in this section disagree.' };
    if (anchored)                            return { salience: 'none' };   // anchored to verbatim bytes — wears nothing
    if (review)                              return { salience: 'quiet', label: 'pending review', title: 'Frozen screenshots in this section await human confirmation.' };
    if (hasClaims && edges.length === 0)     return { salience: 'quiet', label: 'not yet grounded', title: 'This section’s claims are not yet anchored to sources.' };
    return { salience: 'none' };
  }
  function renderSectionTab(claims, confidenceState) {
    var p = sectionPosture(claims, confidenceState);
    if (p.salience === 'none') return '';
    var cls = p.salience === 'warn' ? 'sec-tab sec-tab-warn' : 'sec-tab sec-tab-quiet';
    return '<span class="' + cls + '" title="' + esc(p.title || '') + '">' + esc(p.label) + '</span>';
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
    // Supporting links carry Connie's review_state (supporting_link table): unreviewed | kept | removed.
    // The render EF already drops 'removed' and only sends 'unreviewed' to an editor; we filter again
    // defensively. kept = shown to everyone (the reviewed-good links); unreviewed = editor-only, with the
    // keep / remove controls; removed = never shown. kept sort first.
    var editor = isEditor();
    var supporting = (s.support_links || []).filter(function (l) {
      var st = (l && l.review_state) || 'unreviewed';
      if (st === 'removed') return false;
      if (st === 'kept') return true;
      return editor;
    }).slice().sort(function (a, b) {
      return (((a && a.review_state) === 'kept') ? 0 : 1) - (((b && b.review_state) === 'kept') ? 0 : 1);
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
        var kept = ((l && l.review_state) === 'kept');
        var lid = (l && l.id) ? String(l.id) : '';
        // Editor controls on unreviewed links: Keep, or Remove -> a reason chooser (dead | wrong | irrelevant,
        // the rejection_class Connie's schema requires on removal). Kept links show a confirmed dot, no
        // controls. Writes are auth-gated server-side (dossier-curate-link) — controls are UX only.
        var curate = (editor && !kept && lid)
          ? '<span class="sl-curate">' +
              '<button type="button" class="sl-keep" data-id="' + esc(lid) + '" title="Keep" aria-label="Keep link">&#10003;</button>' +
              '<button type="button" class="sl-rej" title="Remove" aria-label="Remove link">&#10007;</button>' +
              '<span class="sl-reasons">' +
                '<button type="button" class="sl-reason" data-id="' + esc(lid) + '" data-class="dead">dead</button>' +
                '<button type="button" class="sl-reason" data-id="' + esc(lid) + '" data-class="wrong">wrong</button>' +
                '<button type="button" class="sl-reason" data-id="' + esc(lid) + '" data-class="irrelevant">irrelevant</button>' +
              '</span>' +
            '</span>'
          : '';
        return '<div class="sl-support-row' + (kept ? ' is-accepted' : '') + '" data-id="' + esc(lid) + '">' +
          (kept ? '<span class="sl-accepted-dot" title="Kept" aria-label="Kept">&#9679;</span>' : '') +
          '<a class="sl-support-link" href="' + esc(url) + '" target="_blank" rel="noopener">' +
            '<span class="sl-domain">' + esc(dom) + '</span>' +
            (title ? '<span class="sl-support-title">' + esc(title) + '</span>' : '') +
          '</a>' +
          (note ? '<span class="sl-support-note">' + esc(note) + '</span>' : '') +
          curate +
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
  function renderL1(d, secs, cbs) {
    if (!secs.length) return '<div class="dossier-section"><div class="dossier-prose"><p><em>Full synthesis pending.</em></p></div></div>';
    var n = secs.length;
    return secs.map(function (s, idx) {
      var claims = (cbs && cbs[s.id]) || [];
      return '<section class="dossier-section synthesis-section collapsed" id="' + sectionAnchor(s, idx) + '" data-idx="' + idx + '" style="--sec-hue:' + hueFor(idx, n) + '">' +
        '<button type="button" class="section-head" aria-expanded="false">' +
          '<span class="section-caret" aria-hidden="true"></span>' +
          '<span class="section-id">§' + (idx + 1) + ' · ' + esc(labelOf(s, idx)) + '</span>' +
          renderSectionTab(claims, s.confidence_state) +
        '</button>' +
        '<div class="section-body"><div class="dossier-prose">' + md(s.content_md) + '</div>' +
          renderSectionAnchors(claims) + renderSectionFootLinks(s) + '</div>' +
      '</section>';
    }).join('');
  }

  // L3 (engine workings) is deliberately NOT rendered. The link pointed at theo.html — which is not on the
  // public share host, so it could never be viewed there — and, more importantly, the engine workings expose
  // the underlying dispatches (here, an individual's job search) which must NOT be shared. Removed until a
  // reviewed way to surface workings safely exists (Reg, 7 Jul).
  /* ── THE ASK SIDE (interrogate surface v2, Eames §4 / Napoleon baton 629e4723) ──────────────────────
     A reader asks a natural-language question; the answer comes back through trace_interrogation — the ONLY
     sanctioned answer path — vetted below the model against the live claim->fact graph. Each KEPT line is
     grounded (with the tier of what grounds it); WITHHELD material is shown as an EXPLICIT, PROMINENT block
     ("withheld — no grounded fact supports this"), never silently dropped: withholding is a FINDING, and the
     reader should SEE the djinn declining to assert. The dossier-interrogate EF confirms availability lazily
     (a sealed interrogation session must exist for this Dossier) and returns { kept, withheld, vetted_answer }. */
  function renderAskPanel(d) {
    return '<div class="ask-panel" data-session="' + esc((d.session || {}).id || '') + '">' +
        '<div class="ask-head">Interrogate this dossier</div>' +
        '<div class="ask-sub">Ask a question. The answer is drawn only from the grounded record — every line is traced below the model, and anything the record does not support is shown as <em>withheld</em>, not guessed.</div>' +
        '<form class="ask-form" autocomplete="off">' +
          '<input type="text" class="ask-input" name="q" placeholder="e.g. How much emissions avoidance did AESSEAL report, and who verified it?" maxlength="600">' +
          '<button type="submit" class="ask-submit">Ask</button>' +
        '</form>' +
        '<div class="ask-answer" hidden></div>' +
      '</div>';
  }
  function tierStamp(tier) {
    if (!tier) return '';
    return '<span class="gf-tier ' + esc(String(tier).toLowerCase()) + '">' + esc(tier) + '</span>';
  }
  // The vetted answer: kept segments carry their tier stamp (attributions labelled as such); withheld
  // segments render as a prominent gap-note block stating absence-of-SOURCE (never absence of truth).
  function renderVettedAnswer(res) {
    var segs = res.vetted_answer || [];
    var summary = '<div class="ans-summary">' +
      '<span class="ans-count-kept">' + (res.kept || 0) + ' grounded</span>' +
      '<span class="ans-count-withheld' + ((res.withheld || 0) ? ' has-withheld' : '') + '">' + (res.withheld || 0) + ' withheld</span>' +
    '</div>';
    var body = segs.map(function (s) {
      if (s && s.withheld) {
        return '<div class="ans-withheld">' +
            '<span class="ans-withheld-label">Withheld</span>' +
            '<span class="ans-withheld-note">' + esc(s.note || 'No grounded fact in this dossier supports this.') + '</span>' +
          '</div>';
      }
      var attr = s && s.attributed_to ? '<span class="ans-attr">attributed to ' + esc(s.attributed_to) + '</span>' : '';
      var framing = s && s.framing === 'attribution' ? '<span class="ans-framing">as an attribution</span>' : '';
      // The RECEIPT (baton 4fb28d1c Part 2): the verbatim anchor quote is the persuasive object — render it
      // as the serif source span below the claim, with the source document as the quiet attribution line.
      var quote = s && s.anchor_quote
        ? '<blockquote class="av-quote ans-quote">' + esc(s.anchor_quote) + '</blockquote>' : '';
      var src = '';
      if (s && s.source && (s.source.document || s.source.url)) {
        var label = esc(s.source.document || 'source');
        src = '<span class="ans-source">' + (s.source.url
          ? '<a href="' + esc(s.source.url) + '" target="_blank" rel="noopener">' + label + '</a>'
          : label) + '</span>';
      }
      return '<div class="ans-kept">' +
        '<p class="ans-kept-text">' + esc((s && s.text) || '') + '</p>' +
        quote +
        '<div class="ans-trim">' + tierStamp(s && s.tier) + attr + framing + src + '</div>' +
      '</div>';
    }).join('');
    return summary + body;
  }

  function renderMain(d) {
    var secs = sectionsOrdered(d);
    var cbs = claimsBySection(d);
    return '<div class="dossier-main">' +
      renderAskPanel(d) +
      renderL0(secs) +
      '<div class="layer-divider"><span>Full synthesis</span>' +
        (secs.length ? '<button type="button" class="expand-all" data-mode="expand">Expand all</button>' : '') +
      '</div>' +
      renderL1(d, secs, cbs) +
    '</div>';
  }

  // Write a support-link review to Connie's supporting_link table via dossier-curate-link, keyed by link id.
  // state is 'kept' or 'removed'; rejectionClass (dead|wrong|irrelevant) is required by the schema on removal.
  // Optimistic: the row updates here immediately; on write failure we revert and surface the error.
  function curateSupportLink(linkId, state, rejectionClass, row) {
    var ep = curateEndpoint();
    if (!ep || !row || !linkId) return;
    var parent = row.parentNode;
    var nextSibling = row.nextSibling;
    var prevClass = row.className;
    var btnBar = row.querySelector('.sl-curate');
    row.querySelectorAll('.sl-keep, .sl-rej, .sl-reason').forEach(function (x) { x.disabled = true; });
    row.classList.remove('reasons-open');
    // Optimistic UI.
    if (state === 'removed') {
      row.style.display = 'none';
    } else {
      if (btnBar) btnBar.remove();
      if (!row.querySelector('.sl-accepted-dot')) {
        var dot = document.createElement('span');
        dot.className = 'sl-accepted-dot'; dot.title = 'Kept'; dot.setAttribute('aria-label', 'Kept');
        dot.innerHTML = '&#9679;';
        row.insertBefore(dot, row.firstChild);
      }
      row.classList.add('is-accepted');
      var head = parent && parent.querySelector('.sl-head');           // hoist kept to the top of the list
      if (parent && head && head.nextSibling !== row) parent.insertBefore(row, head.nextSibling);
    }
    fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': RENDER_CONFIG.supabaseKey, 'Authorization': 'Bearer ' + RENDER_CONFIG.supabaseKey },
      body: JSON.stringify({ link_id: linkId, action: state, rejection_class: rejectionClass || null }),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
      return r.json();
    }).catch(function (err) {
      // Revert to the pre-click state.
      row.style.display = '';
      row.className = prevClass;
      var d = row.querySelector('.sl-accepted-dot'); if (d && state === 'kept') d.remove();
      if (parent) { if (nextSibling) parent.insertBefore(row, nextSibling); else parent.appendChild(row); }
      if (state === 'kept' && !row.querySelector('.sl-curate')) {
        var id = esc(linkId);
        var span = document.createElement('span');
        span.className = 'sl-curate';
        span.innerHTML = '<button type="button" class="sl-keep" data-id="' + id + '" title="Keep" aria-label="Keep link">&#10003;</button>' +
                         '<button type="button" class="sl-rej" title="Remove" aria-label="Remove link">&#10007;</button>' +
                         '<span class="sl-reasons">' +
                           '<button type="button" class="sl-reason" data-id="' + id + '" data-class="dead">dead</button>' +
                           '<button type="button" class="sl-reason" data-id="' + id + '" data-class="wrong">wrong</button>' +
                           '<button type="button" class="sl-reason" data-id="' + id + '" data-class="irrelevant">irrelevant</button>' +
                         '</span>';
        row.appendChild(span);
      } else {
        row.querySelectorAll('.sl-keep, .sl-rej, .sl-reason').forEach(function (x) { x.disabled = false; });
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
    // Supporting-link review (editor only; controls exist only when isEditor()). Keep writes immediately;
    // Remove reveals the reason chooser (dead|wrong|irrelevant), and picking a reason writes the removal.
    main.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var keep = e.target.closest('.sl-keep');
      var rej = e.target.closest('.sl-rej');
      var reason = e.target.closest('.sl-reason');
      var row = e.target.closest('.sl-support-row');
      if (keep && !keep.disabled) {
        e.preventDefault();
        curateSupportLink(keep.getAttribute('data-id'), 'kept', null, row);
      } else if (rej && !rej.disabled) {
        e.preventDefault();
        if (row) row.classList.toggle('reasons-open');   // reveal dead|wrong|irrelevant
      } else if (reason && !reason.disabled) {
        e.preventDefault();
        curateSupportLink(reason.getAttribute('data-id'), 'removed', reason.getAttribute('data-class'), row);
      }
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

  // A uuid the client controls, so it can POLL for real progress while the interrogation runs (baton
  // 39ea928f). crypto.randomUUID needs a secure context (https) — clarev.ai + the share page both are; a
  // rare fallback keeps the ASK working (just without progress polling) if it is ever unavailable.
  function newProgressId() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return null;
  }
  // The live progress line. Stages come from REAL execution rows (dossier-interrogate-status), never a timer.
  // "The wait is the proof" (Napoleon): show the record being read, the answer drafted, and — the reveal —
  // the real count of statements checked and withheld. Honest at every step; nothing here is faked.
  function progressHTML(st) {
    var label, detail;
    if (st && st.stage === 'checked') {
      var total = (st.assertion_count != null) ? st.assertion_count : ((st.kept || 0) + (st.withheld || 0));
      label = 'Checking each statement against the record';
      detail = total + ' statement' + (total === 1 ? '' : 's') + ' checked — ' +
        (st.kept || 0) + ' supported, ' + (st.withheld || 0) + ' withheld. Assembling the answer…';
    } else if (st && st.stage === 'checking') {
      label = 'Checking each statement against the record';
      detail = 'Weighing each drafted statement against the grounded facts…';
    } else if (st && st.stage === 'drafting') {
      label = 'Drafting a grounded answer';
      detail = 'Then every statement is checked against the record — this can take up to a minute.';
    } else {
      label = 'Reading the grounded record';
      detail = 'Then drafting an answer and checking each statement against it — this can take up to a minute.';
    }
    return '<div class="ans-progress">' +
      '<div class="ans-progress-spin" aria-hidden="true"></div>' +
      '<div class="ans-progress-text"><span class="ans-progress-stage">' + esc(label) + '</span>' +
      '<span class="ans-progress-detail">' + esc(detail) + '</span></div>' +
    '</div>';
  }

  // The ASK side wiring: submit a question to dossier-interrogate, showing REAL progress (polled from the
  // status EF, driven by actual execution rows) during the wait, then render the trace-vetted answer.
  function wireAsk() {
    var panel = root.querySelector('.ask-panel');
    if (!panel) return;
    var form = panel.querySelector('.ask-form');
    var input = panel.querySelector('.ask-input');
    var out = panel.querySelector('.ask-answer');
    var endpoint = (typeof RENDER_CONFIG !== 'undefined' && RENDER_CONFIG.interrogateUrl) ? RENDER_CONFIG.interrogateUrl : '';
    var statusUrl = (typeof RENDER_CONFIG !== 'undefined' && RENDER_CONFIG.interrogateStatusUrl) ? RENDER_CONFIG.interrogateStatusUrl : '';
    if (!form || !endpoint) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = (input.value || '').trim();
      if (!q) return;
      var sid = panel.getAttribute('data-session');
      var progressId = newProgressId();
      out.hidden = false;
      out.innerHTML = progressHTML(null);
      panel.classList.add('is-asking');
      var submit = form.querySelector('.ask-submit'); if (submit) submit.disabled = true;

      // Poll REAL stage state while the answer computes. Only runs if we have a progress_id + status URL;
      // otherwise the initial honest message holds. Stops as soon as the answer arrives.
      var finished = false;
      var pollTimer = null;
      function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
      function poll() {
        if (finished || !progressId || !statusUrl) return;
        fetch(statusUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': RENDER_CONFIG.supabaseKey, 'Authorization': 'Bearer ' + RENDER_CONFIG.supabaseKey },
          body: JSON.stringify({ progress_id: progressId, theo_session_id: sid }),
        }).then(function (r) { return r.json(); }).then(function (st) {
          if (finished) return;
          if (st && st.ok) out.innerHTML = progressHTML(st);
        }).catch(function () { /* a dropped poll is harmless — the last message holds */ }).then(function () {
          if (!finished) pollTimer = setTimeout(poll, 1500);
        });
      }
      if (progressId && statusUrl) pollTimer = setTimeout(poll, 1200);

      function done() { finished = true; stopPoll(); panel.classList.remove('is-asking'); if (submit) submit.disabled = false; }
      var reqBody = { theo_session_id: sid, question: q };
      if (progressId) reqBody.progress_id = progressId;
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': RENDER_CONFIG.supabaseKey, 'Authorization': 'Bearer ' + RENDER_CONFIG.supabaseKey },
        body: JSON.stringify(reqBody),
      }).then(function (r) { return r.json(); }).then(function (res) {
        done();
        if (!res || res.ok === false) { out.innerHTML = '<div class="ans-error">The interrogation could not be completed. Please try again.</div>'; return; }
        if (res.available === false) { out.innerHTML = '<div class="ans-note">Interrogation is not enabled for this dossier.</div>'; return; }
        if (res.traced === false) {
          out.innerHTML = '<div class="ans-note">This question could not be answered from the grounded record.</div>' +
            (res.response ? '<div class="ans-model">' + esc(res.response) + '</div>' : '');
          return;
        }
        out.innerHTML = '<div class="ans-question">' + esc(res.question || q) + '</div>' + renderVettedAnswer(res);
      }).catch(function () {
        done();
        out.innerHTML = '<div class="ans-error">Could not reach the interrogation service. Please try again.</div>';
      });
    });
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
    wireAsk();
  }

  // Session id from ?session= (page behind Cloudflare Access) OR window.RENDER_SESSION_ID (set by the
  // token-gated public share page d.html after resolve_dossier_share — the capability-link path).
  var sid = qs('session') || (typeof window !== 'undefined' ? window.RENDER_SESSION_ID : null);
  if (!sid) { root.innerHTML = '<div class="render-status">No dossier specified — append <code>?session=&lt;uuid&gt;</code>.</div>'; return; }
  fetchDossier(sid).then(render).catch(function (e) {
    root.innerHTML = '<div class="render-error">Could not load this dossier: ' + esc(e.message) + '</div>';
  });
})();
