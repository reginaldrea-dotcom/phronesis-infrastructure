/* theo-render.js — Display/Verify render (Eames spec 2835520b, MR 1ad5b49e).
 * Reads the open theo-render-data EF (UUID-addressed; Cloudflare gates the surface) and
 * renders the two postures. The face is a SELECT, not a story: every element is a pure
 * function of the returned rows. No render-time LLM. Reading-first (Napoleon).
 *
 * URL: theo.html?session=<uuid>
 */
(function () {
  var root = document.getElementById('render-root');

  /* ── helpers ──────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function qs(name) { return new URLSearchParams(location.search).get(name); }
  function nl2p(s) {
    return String(s || '').split(/\n{2,}/).map(function (para) {
      return '<p>' + esc(para).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }
  function elapsed(fromIso, toIso) {
    if (!fromIso) return '';
    var a = new Date(fromIso).getTime(), b = toIso ? new Date(toIso).getTime() : Date.now();
    var s = Math.max(0, Math.round((b - a) / 1000));
    if (s < 90) return s + 's';
    if (s < 5400) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }
  function groupBy(arr, key) {
    var m = {}; (arr || []).forEach(function (x) { (m[x[key]] = m[x[key]] || []).push(x); }); return m;
  }
  var CLAIM_ORDER = { convergent: 0, divergent: 1, single_source: 2, synthesis_inference: 3, gap: 4 };

  /* ── fetch (publishable bearer, like the navigator EF calls) ── */
  function fetchRender(sessionId) {
    return fetch(RENDER_CONFIG.renderDataUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': RENDER_CONFIG.supabaseKey,
        'Authorization': 'Bearer ' + RENDER_CONFIG.supabaseKey,
      },
      body: JSON.stringify({ session_id: sessionId }),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
      return r.json();
    });
  }

  /* ── engine state chip (Eames §4b / §6) ──────────────────────── */
  function stateChip(eng, reading) {
    var st = eng.render_state, cls = 'chip', label = st;
    if (st === 'returned')            { cls += ' returned'; label = 'Returned'; }
    else if (st === 'returned_empty') { cls += ' empty';    label = 'No results'; }
    else if (st === 'partial')        { cls += ' amber';    label = 'Partial return'; }
    else if (st === 'failed_with_reason') { cls += ' amber'; label = 'Failed · ' + (eng.error_detail || 'unknown'); }
    else if (st === 'pending')        { cls += ' pending';  label = 'Pending'; }
    else if (st === 'dispatched')     { var e = elapsed(eng.dispatched_at, reading ? eng.response_received_at : null);
                                        label = 'In flight' + (e ? ' · ' + e : ''); }
    else if (st === 'not_asked')      { label = 'Not dispatched'; }
    return '<span class="' + cls + '">' + esc(label) + '</span>';
  }

  /* ── L4: engine return expansion (per claim) ─────────────────── */
  function engineExpansion(claimId, ctx) {
    var srcs = ctx.sourcesByClaim[claimId] || [];
    if (!srcs.length) return '';   // no claim_source data → no per-engine drill (counts still shown on the claim)
    var rows = srcs.map(function (s) {
      var eng = ctx.enginesByDispatch[s.dispatch_id];
      if (!eng) return '';
      var preview = (eng.content || '');
      try { var j = JSON.parse(eng.content); if (j && typeof j.text === 'string') preview = j.text; } catch (e) {}
      preview = preview.slice(0, 400);
      var meta = engineDisplayName(eng.source_name) + ' · ' + stateChip(eng, true) +
        (eng.source_count != null ? ' · ' + eng.source_count + ' sources cited' : '') +
        (eng.cost_usd != null ? ' · $' + Number(eng.cost_usd).toFixed(3) : '') +
        (s.stance === 'diverges' ? ' · <span style="color:var(--status-amber)">diverges</span>' : '');
      return '<div class="ee-row"><div class="ee-meta">' + meta + '</div>' +
        (eng.render_state === 'failed_with_reason'
          ? '<div class="ee-error">' + esc(eng.error_detail || '') + '</div>'
          : '<div class="ee-preview">' + esc(preview) + (preview.length >= 400 ? ' …' : '') + '</div>') +
        '</div>';
    }).join('');
    return '<div class="engine-expansion" data-exp="' + esc(claimId) + '">' + rows + '</div>';
  }

  /* ── L5: citation drawer (per claim, two grades) ─────────────── */
  function citationDrawer(claimId, ctx) {
    var cits = ctx.citationsByClaim[claimId] || [];
    if (!cits.length) return '';   // absence is information — no empty state
    var rows = cits.map(function (c) {
      var res = c.resolution || 'unchecked';
      var resCls = 'pill cite-resolution ' + res + ((res === 'dead' || res === 'mismatched') ? ' amber' : '');
      var resLabel = { unchecked: 'Unverified', resolved: '✓', dead: 'Link unavailable', mismatched: 'Content mismatch' }[res] || res;
      var link = c.url
        ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.title || c.url) + '</a>'
        : esc(c.title || '(no link)');
      return '<div class="citation">' + link +
        (c.source_date ? ' <span class="cite-date">Published ' + esc(c.source_date) + '</span>' : '') +
        ' <span class="' + resCls + '">' + esc(resLabel) + '</span>' +
        (c.note ? '<div class="cite-note">' + esc(c.note) + '</div>' : '') + '</div>';
    }).join('');
    return '<div class="citation-drawer" data-drawer="' + esc(claimId) + '">' + rows + '</div>';
  }

  /* attribution + citation links (shared by the source-backed grammars) */
  function attribLinks(cl) {
    var out = '';
    if (cl.supporting_engines > 0 || cl.diverging_engines > 0) {
      var n = (cl.supporting_engines || 0) + (cl.diverging_engines || 0);
      out += '<span class="claim-attrib" data-attrib="' + esc(cl.claim_id) + '">' + n + (n === 1 ? ' engine' : ' engines') + '</span>';
    }
    if (cl.citations_total > 0) {
      out += '<span class="claim-cite-link" data-cite="' + esc(cl.claim_id) + '">' + cl.citations_total + (cl.citations_total === 1 ? ' source' : ' sources') + '</span>';
    }
    return out;
  }

  /* ── claim — five grammars (Eames §5c) ───────────────────────── */
  function renderClaim(cl, ctx) {
    var st = cl.claim_status, body, cls = 'claim ' + st;
    if (st === 'convergent') {
      body = '<span class="claim-text">' + esc(cl.claim_text) + '</span>' + attribLinks(cl);
    } else if (st === 'divergent') {
      var open = cl.divergence_status === 'open';
      cls += open ? ' open' : ' resolved';
      body = (open ? '<span class="open-label">Open divergence</span> ' : '') +
        '<span class="claim-text">' + esc(cl.claim_text) + '</span>' + attribLinks(cl) +
        (cl.resolution_note ? '<div class="resolution">' + (open ? '' : 'Resolved: ') + esc(cl.resolution_note) + '</div>' : '');
    } else if (st === 'single_source') {
      if (cl.divergence_status === 'open') cls += ' open';
      body = '<span class="claim-text">' + esc(cl.claim_text) + '</span> <span class="pill ss-label">Single source</span>' +
        attribLinks(cl) +
        (cl.divergence_status === 'open' && cl.resolution_note ? '<div class="resolution">' + esc(cl.resolution_note) + '</div>' : '');
    } else if (st === 'synthesis_inference') {
      body = '<span class="infer-label">Synthesist note</span><span class="claim-text">' + esc(cl.claim_text) + '</span>' +
        (cl.resolution_note ? ' <span class="claim-text">' + esc(cl.resolution_note) + '</span>' : '');
    } else if (st === 'gap') {
      var technical = (cl.scope || '') === 'technical-failure';
      cls += technical ? ' technical' : ' honest';
      body = (technical ? '<span class="not-run">Not run</span> ' : '') +
        '<span class="claim-text">' + esc(cl.claim_text) + '</span>' +
        (technical && cl.resolution_note ? ' <span class="claim-text">— ' + esc(cl.resolution_note) + '</span>' : '');
    } else {
      body = '<span class="claim-text">' + esc(cl.claim_text) + '</span>';
    }
    return '<div class="' + cls + '">' + body + engineExpansion(cl.claim_id, ctx) + citationDrawer(cl.claim_id, ctx) + '</div>';
  }

  /* ── reading posture ─────────────────────────────────────────── */
  function renderReading(d, ctx) {
    var html = '';
    // synthesis document
    html += '<div class="synthesis-doc">';
    if (d.sections && d.sections.length) {
      d.sections.forEach(function (s) {
        var c = 'synth-section' + (s.section_type === 'comparison' ? ' comparison' : '');
        html += '<div class="' + c + '">' +
          (s.title ? '<h3>' + esc(s.title) + (s.needs_review ? ' <span class="pill needs-review">Needs review</span>' : '') + '</h3>' : '') +
          '<div class="synth-body">' + nl2p(s.content_md) + '</div>' +
          (s.join_note ? '<div class="join-note">' + esc(s.join_note) + '</div>' : '') + '</div>';
      });
    } else {
      html += '<div class="synth-body">' + nl2p(d.synthesis.layer_1_synthesis_md) + '</div>';
    }
    html += '</div>';

    // strata navigator — question axis
    var claimsByQ = groupBy(d.claims, 'question_id');
    html += '<div class="strata-nav">';
    (d.questions || []).forEach(function (q) {
      html += renderQuestionRow(q, (claimsByQ[q.id] || []), ctx);
    });
    // claims with no question link → a trailing group
    var unlinked = (d.claims || []).filter(function (c) { return !c.question_id; });
    if (unlinked.length) html += renderQuestionRow({ question_text: 'Further claims', status: '' }, unlinked, ctx);
    html += '</div>';
    html += renderFooter(d);
    return html;
  }

  /* session metadata footer (Eames §2) — names every engine used + its outcome */
  function renderFooter(d) {
    var engs = d.engines || [];
    if (!engs.length) return '';
    var items = engs.map(function (e) {
      return '<span class="footer-engine">' + esc(engineDisplayName(e.source_name)) + ' ' + stateChip(e, true) + '</span>';
    }).join('');
    var totalSources = engs.reduce(function (a, e) { return a + (e.source_count || 0); }, 0);
    var totalCost = engs.reduce(function (a, e) { return a + (Number(e.cost_usd) || 0); }, 0);
    return '<div class="render-footer"><div class="footer-label">Engines used</div>' +
      '<div class="footer-engines">' + items + '</div>' +
      '<div class="footer-meta">' + totalSources + ' source' + (totalSources === 1 ? '' : 's') + ' cited' +
      (totalCost > 0 ? ' · $' + totalCost.toFixed(3) : '') + '</div></div>';
  }

  function renderQuestionRow(q, claims, ctx) {
    claims = claims.slice().sort(function (a, b) {
      return (CLAIM_ORDER[a.claim_status] - CLAIM_ORDER[b.claim_status]) || (new Date(a.created_at) - new Date(b.created_at));
    });
    var counts = {};
    claims.forEach(function (c) { counts[c.claim_status] = (counts[c.claim_status] || 0) + 1; });
    var summary = Object.keys(CLAIM_ORDER).filter(function (k) { return counts[k]; })
      .map(function (k) { return counts[k] + ' ' + k.replace('_', '-'); }).join(' · ');
    var statusCls = 'q-status' + (q.status === 'withdrawn' ? ' withdrawn' : '');
    return '<div class="q-row">' +
      '<div class="q-head" data-q="1">' +
        '<span class="q-text">' + esc(q.question_text) + '</span>' +
        (q.status ? '<span class="' + statusCls + '">' + esc(q.status) + '</span>' : '') +
        '<span class="q-counts">' + esc(summary) + '</span>' +
        '<span class="q-chevron">▾</span>' +
      '</div>' +
      '<div class="q-claims">' + (claims.map(function (c) { return renderClaim(c, ctx); }).join('') || '<div class="claim"><span class="claim-text" style="color:var(--text-muted)">No claims recorded.</span></div>') + '</div>' +
    '</div>';
  }

  /* ── production posture ──────────────────────────────────────── */
  function renderProduction(d) {
    var html = '<div class="engine-grid">';
    (d.engines || []).forEach(function (eng) {
      html += '<div class="engine-box">' +
        '<span class="engine-state">' + stateChip(eng, false) + '</span>' +
        '<div class="engine-name">' + esc(engineDisplayName(eng.source_name)) + '</div>' +
        '<div class="engine-meta">' + (eng.role ? esc(eng.role) : '') +
          (eng.source_count != null ? '<span class="sources"> · ' + eng.source_count + ' sources cited</span>' : '') + '</div>' +
        (eng.cost_usd != null ? '<div class="engine-cost">$' + Number(eng.cost_usd).toFixed(3) +
          (eng.tokens_in != null ? ' · ' + eng.tokens_in + ' in / ' + (eng.tokens_out || 0) + ' out' : '') + '</div>' : '') +
      '</div>';
    });
    html += '</div>';
    // synthesis-pending (engines returned, no committed synthesis)
    html += '<div class="synthesis-pending">Synthesis not yet committed — engine returns are ready. Review the strata below before committing.</div>';
    if (RENDER_CONFIG.interactive) html += '<div style="text-align:center"><button class="action-btn">Commit synthesis</button></div>';
    return html;
  }

  /* ── header (both postures) ──────────────────────────────────── */
  function renderHeader(d, committed) {
    var s = d.session || {};
    var title = s.refined_prompt || s.original_brief || 'Research session';
    var nQ = (d.questions || []).length, nE = (d.engines || []).length;
    var counts;
    if (committed) {
      var nSources = (d.engines || []).reduce(function (a, e) { return a + (e.source_count || 0); }, 0);
      counts = nQ + ' question' + (nQ === 1 ? '' : 's') + '<span class="dot">·</span>' + nE + ' engine' + (nE === 1 ? '' : 's') +
        '<span class="dot">·</span>' + nSources + ' sources<span class="dot">·</span>synthesis committed';
    } else {
      var byState = {}; (d.engines || []).forEach(function (e) { byState[e.render_state] = (byState[e.render_state] || 0) + 1; });
      counts = nQ + ' question' + (nQ === 1 ? '' : 's') + '<span class="dot">·</span>' +
        Object.keys(byState).map(function (k) { return byState[k] + ' ' + k; }).join(' · ') +
        ' <span class="posture-tag">· in progress</span>';
    }
    return '<div class="render-header"><h1 class="render-title">' + esc(title) + '</h1><div class="render-counts">' + counts + '</div></div>';
  }

  /* ── interactions (event delegation) ─────────────────────────── */
  function wire() {
    root.addEventListener('click', function (ev) {
      var qh = ev.target.closest('.q-head');
      if (qh) { qh.parentNode.classList.toggle('active'); return; }
      var at = ev.target.closest('.claim-attrib');
      if (at) { var ex = at.closest('.claim').querySelector('.engine-expansion'); if (ex) ex.classList.toggle('open'); return; }
      var cl = ev.target.closest('.claim-cite-link');
      if (cl) { var dr = cl.closest('.claim').querySelector('.citation-drawer'); if (dr) dr.classList.toggle('open'); return; }
    });
  }

  /* ── render + boot ───────────────────────────────────────────── */
  function render(d) {
    var ctx = {
      enginesByDispatch: {}, citationsByClaim: groupBy(d.citations, 'claim_id'), sourcesByClaim: groupBy(d.claim_sources, 'claim_id'),
    };
    (d.engines || []).forEach(function (e) { ctx.enginesByDispatch[e.dispatch_id] = e; });
    var committed = d.synthesis && d.synthesis.layer_1_synthesis_md;
    root.innerHTML = renderHeader(d, committed) + (committed ? renderReading(d, ctx) : renderProduction(d));
    wire();
  }

  var sid = qs('session');
  if (!sid) { root.innerHTML = '<div class="render-status">No session specified — append <code>?session=&lt;uuid&gt;</code> to the URL.</div>'; return; }
  fetchRender(sid).then(render).catch(function (e) {
    root.innerHTML = '<div class="render-error">Could not load this session: ' + esc(e.message) + '</div>';
  });
})();
