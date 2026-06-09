/* theo-render.js — Display/Verify render (Eames spec 2835520b, MR 1ad5b49e).
 * Reads the open theo-render-data EF (UUID-addressed; Cloudflare gates the surface) and
 * renders the two postures. The face is a SELECT, not a story: every element is a pure
 * function of the returned rows. No render-time LLM. Reading-first (Napoleon).
 *
 * URL: theo.html?session=<uuid>
 */
(function () {
  var root = document.getElementById('render-root');
  var lastData = null, lastCtx = null; // kept so stratum pages can route back to the session view

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

  /* ── F11 stratum helpers (Eames WN 0f533d0b) ─────────────────── */
  function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  // Response envelope contract: { raw, text, usage, labels, sources }. Malformed text
  // falls back to the unparsed view (the spec's rule), so be tolerant here.
  function parseEnvelope(content) {
    var j = safeParse(content);
    if (j && typeof j === 'object') return j;
    return { text: typeof content === 'string' ? content : '', raw: content };
  }
  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d.getTime())) return String(iso);
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
  // Status label for the signals band (text form of the chip).
  function stateLabel(eng) {
    var st = eng.render_state;
    if (st === 'returned') return 'Returned';
    if (st === 'returned_empty') return 'No results';
    if (st === 'partial') return 'Partial return';
    if (st === 'failed_with_reason') return 'Failed';
    if (st === 'pending') return 'Pending';
    if (st === 'dispatched') return 'In flight';
    if (st === 'not_asked') return 'Not dispatched';
    return st || 'Unknown';
  }

  /* Compact GFM-subset markdown → HTML for the engine's returned text. Handles
     headings, bold/italic/code, links, ordered/unordered lists, and tables (which
     break out of the prose measure). Anything it cannot parse stays readable as a
     paragraph; the "view unparsed" toggle is the guaranteed fallback. */
  function mdInline(s) {
    return s
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, function (_, t, u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>'; })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function splitRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
  }
  function md(text) {
    var lines = String(text == null ? '' : text).split('\n');
    var out = [], i = 0, para = [];
    function flushPara() { if (para.length) { out.push('<p>' + mdInline(esc(para.join(' '))) + '</p>'); para = []; } }
    while (i < lines.length) {
      var line = lines[i], t = line.trim();
      // table: a row containing | immediately followed by a |---|---| separator
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flushPara();
        var header = splitRow(line); i += 2;
        var rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        out.push('<div class="stratum-table-wrap"><table><tr>' +
          header.map(function (c) { return '<th>' + mdInline(esc(c)) + '</th>'; }).join('') + '</tr>' +
          rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + mdInline(esc(c)) + '</td>'; }).join('') + '</tr>'; }).join('') +
          '</table></div>');
        continue;
      }
      var h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); out.push('<h' + h[1].length + '>' + mdInline(esc(h[2])) + '</h' + h[1].length + '>'); i++; continue; }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        flushPara();
        var ordered = /^\s*\d+\./.test(line), items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')); i++; }
        out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.map(function (it) { return '<li>' + mdInline(esc(it)) + '</li>'; }).join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
        continue;
      }
      if (!t) { flushPara(); i++; continue; }
      para.push(t); i++;
    }
    flushPara();
    return out.join('');
  }

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

  /* ── F-calibration helpers (Eames WN ba455434) ──────────────── */
  // §1/§2/§4: every card wears its status, derived mechanically from render_claim_v1.
  // divergence_status always rides the chip as the qualifier; open is a warning (amber).
  function claimChip(cl) {
    var st = cl.claim_status, div = cl.divergence_status, text, accent = '';
    if (st === 'convergent') { text = 'Convergent'; }
    else if (st === 'divergent') { text = 'Divergent' + (div ? ' · ' + div : ''); if (div === 'open') accent = ' amber'; }
    else if (st === 'single_source') { text = 'Single source' + (div ? ' · ' + div : ''); if (div === 'open') accent = ' amber'; }
    else if (st === 'gap') { text = 'Gap'; accent = ' gap'; }
    // Eames reopen 5992c6ea: keep the WARM "Synthesist note" voice (violet released). Keys off
    // claim_status='synthesis_inference'; the warm tint reads as the synthesist's own voice.
    else if (st === 'synthesis_inference') { text = 'Synthesist note'; accent = ' warm'; }
    else { text = st || 'Claim'; }
    return '<span class="claim-chip' + accent + '"' + (cl.scope ? ' title="' + esc(cl.scope) + '"' : '') + '>' + esc(text) + '</span>';
  }
  // §3: citation line from the view's lifecycle counts. "citations" (F6), singular/plural,
  // single-category collapses to "· resolved/unchecked", dead/mismatched enumerate in amber.
  function citationLine(cl) {
    var total = cl.citations_total || 0;
    if (total === 0) {
      if (cl.claim_status === 'gap' || cl.claim_status === 'synthesis_inference') return '';
      return '<span class="claim-cite-zero">no citations</span>';   // a citation-less factual claim is a finding
    }
    var noun = total === 1 ? 'citation' : 'citations';
    var cats = [];
    if (cl.citations_resolved)   cats.push({ n: cl.citations_resolved,   label: 'resolved' });
    if (cl.citations_unchecked)  cats.push({ n: cl.citations_unchecked,  label: 'unchecked' });
    if (cl.citations_dead)       cats.push({ n: cl.citations_dead,       label: 'dead', warn: true });
    if (cl.citations_mismatched) cats.push({ n: cl.citations_mismatched, label: 'mismatched', warn: true });
    var tail;
    if (cats.length === 1 && !cats[0].warn) {
      tail = ' · ' + cats[0].label;                                   // all one clean kind: no count
    } else {
      tail = ' · ' + cats.map(function (c) { var t = c.n + ' ' + c.label; return c.warn ? '<span class="cite-warn">' + t + '</span>' : t; }).join(' · ');
    }
    return '<span class="claim-cite-link" data-cite="' + esc(cl.claim_id) + '">' + total + ' ' + noun + tail + '</span>';
  }
  // §5: rollup enumeration in fixed status order with open/resolved qualifiers (F8, F2).
  var ROLLUP_ORDER = [['convergent', 'convergent'], ['divergent', 'divergent'], ['single_source', 'single source'], ['gap', 'gap'], ['synthesis_inference', 'inference']];
  function rollupEnum(claims) {
    var byStatus = {};
    (claims || []).forEach(function (c) { (byStatus[c.claim_status] = byStatus[c.claim_status] || []).push(c); });
    return ROLLUP_ORDER.filter(function (o) { return byStatus[o[0]]; }).map(function (o) {
      var arr = byStatus[o[0]], n = arr.length;
      var open = arr.filter(function (c) { return c.divergence_status === 'open'; }).length;
      return n + ' ' + o[1] + (open > 0 ? (n === 1 ? ' (open)' : ' (' + open + ' open)') : '');
    }).join(' · ');
  }

  /* ── repair-pass helpers (Eames reopen brief 5992c6ea) ───────── */
  // Q-label: ONE convention everywhere — "Q1)" in the mono signals face (the (1)/Q1/Q1: drift,
  // settled). question_index is 0-based in the substrate, so display index+1. '' when no index
  // (the trailing "Further claims" group).
  function qLabel(idx) { return (idx != null && idx !== '') ? 'Q' + (Number(idx) + 1) + ')' : ''; }
  // A synthesis json field may arrive parsed (jsonb) or as a string (text col) — tolerate both.
  function asArray(v) { if (Array.isArray(v)) return v; if (typeof v === 'string') { var p = safeParse(v); return Array.isArray(p) ? p : []; } return []; }
  // §F9 answer-state: one grammar per question — a lead STATE-WORD (amber only for unresolved
  // divergence, per Eames's amber=divergence map) + a quiet breakdown. Default vocabulary; Eames
  // finalises the words at sign-off.
  function answerState(claims) {
    var has = {}; (claims || []).forEach(function (c) { has[c.claim_status] = (has[c.claim_status] || 0) + 1; });
    var openDiv = (claims || []).some(function (c) { return (c.claim_status === 'divergent' || c.claim_status === 'single_source') && c.divergence_status === 'open'; });
    if (openDiv) return { word: 'Divergent', cls: 'amber' };
    if (has.divergent) return { word: 'Reconciled', cls: '' };
    if (has.single_source) return { word: 'Single-source', cls: '' };
    if (has.convergent) return { word: 'Convergent', cls: '' };
    if (has.gap) return { word: 'Gap', cls: 'muted' };
    if (has.synthesis_inference) return { word: 'Inference', cls: '' };
    return { word: '', cls: '' };
  }
  // Material status (the reader's "what can I use"): confidence_ratings_json as a first-class
  // block — claims by confidence tier (high -> low) with their basis. Synthesis-level.
  var CONF_ORDER = ['high', 'medium-high', 'medium', 'low-medium', 'low'];
  function renderMaterialStatus(d) {
    var rows = asArray(d.synthesis && d.synthesis.confidence_ratings_json);
    if (!rows.length) return '';
    rows = rows.slice().sort(function (a, b) {
      return CONF_ORDER.indexOf(String(a.confidence || '').toLowerCase()) - CONF_ORDER.indexOf(String(b.confidence || '').toLowerCase());
    });
    var items = rows.map(function (r) {
      var conf = String(r.confidence || '').toLowerCase().replace(/[^a-z-]/g, '');
      return '<li class="mat-row"><span class="mat-tier mat-' + esc(conf || 'unk') + '">' + esc(r.confidence || '?') + '</span>' +
        '<span class="mat-claim">' + esc(r.claim || '') + '</span>' +
        (r.basis ? '<div class="mat-basis">' + esc(r.basis) + '</div>' : '') + '</li>';
    }).join('');
    return '<div class="cover-block"><div class="cover-label">Material status — what you can rely on</div><ul class="material-status">' + items + '</ul></div>';
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
        (eng.source_count > 0 ? ' · ' + eng.source_count + ' sources' : '') +
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

  /* per-answer attribution (Eames note bfa3c7bb, issues 1+2): two-level — type label over
     model string. One engine: the two lines. Multiple (convergence): inline "N engines:
     type · type" (the count is the convergence signal), model strings on hover. The block
     is also the L4 drill. The citation (L5) link follows. */
  function attribLinks(cl, ctx) {
    var srcs = (ctx && ctx.sourcesByClaim[cl.claim_id]) || [];
    var engs = [], seen = {};
    srcs.forEach(function (s) {
      var e = ctx.enginesByDispatch[s.dispatch_id];
      if (e && !seen[e.source_name]) { seen[e.source_name] = 1; engs.push(e); }
    });
    if (!engs.length) return '';
    // §8: friendly name only on cards; each links to its stratum page (F11). The registry
    // name lives in exactly one place — the stratum signals band. (Citations are a separate
    // line now, owned by citationLine.)
    return '<div class="attribution">' + engs.map(function (e) {
      return '<span class="attr-engine" data-stratum="' + esc(e.dispatch_id) + '" title="Open the evidence room for this engine">' +
        esc(engineDisplayName(e.source_name)) + '</span>';
    }).join('<span class="attr-sep">·</span>') + '</div>';
  }

  /* ── claim — five grammars (Eames §5c) ───────────────────────── */
  // Universal card (§1): every claim wears its chip, then body, attribution, attached note,
  // citation line. One grammar for all five statuses — the Quantinuum reference extended,
  // not a second design. Open divergence keeps the amber border (a warning); gap is muted;
  // synthesis_inference is a claim, not a warning, so only its chip is tinted.
  function renderClaim(cl, ctx) {
    var st = cl.claim_status, cls = 'claim ' + st;
    if ((st === 'divergent' || st === 'single_source') && cl.divergence_status === 'open') cls += ' open';
    if (st === 'gap') cls += ((cl.scope || '') === 'technical-failure' ? ' technical' : ' honest');
    var body = '<div class="claim-head">' + claimChip(cl) + '</div>' +
      '<div class="claim-text">' + esc(cl.claim_text) + '</div>' +
      attribLinks(cl, ctx);
    // §2: resolution_note is the ATTACHED note (the Quantinuum pattern) — never concatenated
    // into claim_text. This is the fix for the floating-box seam on inference claims.
    if (cl.resolution_note) body += '<div class="resolution">' + esc(cl.resolution_note) + '</div>';
    var cite = citationLine(cl);
    if (cite) body += cite;
    return '<div class="' + cls + '">' + body + engineExpansion(cl.claim_id, ctx) + citationDrawer(cl.claim_id, ctx) + '</div>';
  }

  /* ── reading layers (COVER architecture: one screen per onion layer) ── */
  // The synthesis document on its own (the "Full synthesis" door).
  function renderSynthesisDoc(d) {
    var html = '<div class="synthesis-doc">';
    if (d.sections && d.sections.length) {
      d.sections.forEach(function (s) {
        var c = 'synth-section' + (s.section_type === 'comparison' ? ' comparison' : '');
        html += '<div class="' + c + '">' +
          (s.title ? '<h3>' + esc(s.title) + (s.needs_review ? ' <span class="pill needs-review">Needs review</span>' : '') + '</h3>' : '') +
          '<div class="synth-body">' + nl2p(s.content_md) + '</div>' +
          // Eames reopen 5992c6ea: join_note holds transition prose ("section 2 turns to..."),
          // not review metadata — suppress it entirely (default all-off; section-0 opening pointer
          // special-case is Reg's call). Removing the render removes them all cleanly.
          '</div>';
      });
    } else {
      html += '<div class="synth-body">' + nl2p(d.synthesis.layer_1_synthesis_md) + '</div>';
    }
    return html + '</div>';
  }
  // The question-axis claims navigator (the "Claims" door).
  function renderStrataNav(d, ctx) {
    var claimsByQ = groupBy(d.claims, 'question_id');
    var html = '<div class="strata-nav">';
    (d.questions || []).forEach(function (q) { html += renderQuestionRow(q, (claimsByQ[q.id] || []), ctx); });
    var unlinked = (d.claims || []).filter(function (c) { return !c.question_id; });
    if (unlinked.length) html += renderQuestionRow({ question_text: 'Further claims', status: '' }, unlinked, ctx);
    return html + '</div>';
  }

  /* session metadata footer (Eames §2) — names every engine used + its outcome */
  function renderFooter(d) {
    var engs = d.engines || [];
    if (!engs.length) return '';
    var items = engs.map(function (e) {
      // F11: each strip row links to its stratum page (affordance only — content unchanged,
      // audited correct in the walkthrough). F6: "sources", not "sources cited".
      return '<span class="footer-engine" data-stratum="' + esc(e.dispatch_id) + '" title="Open the evidence room for this engine">' +
        esc(engineDisplayName(e.source_name)) + ' ' + stateChip(e, true) +
        (e.source_count > 0 ? ' <span class="sources">' + e.source_count + ' sources</span>' : '') + '</span>';
    }).join('');
    var totalSources = engs.reduce(function (a, e) { return a + (e.source_count || 0); }, 0);
    var totalCost = engs.reduce(function (a, e) { return a + (Number(e.cost_usd) || 0); }, 0);
    return '<div class="render-footer"><div class="footer-label">Engines used</div>' +
      '<div class="footer-engines">' + items + '</div>' +
      '<div class="footer-meta">' + totalSources + ' source' + (totalSources === 1 ? '' : 's') +
      (totalCost > 0 ? ' · $' + totalCost.toFixed(3) : '') + '</div></div>';
  }

  function renderQuestionRow(q, claims, ctx) {
    claims = claims.slice().sort(function (a, b) {
      return (CLAIM_ORDER[a.claim_status] - CLAIM_ORDER[b.claim_status]) || (new Date(a.created_at) - new Date(b.created_at));
    });
    // §F9 (reopen): one grammar — a lead state-word (amber = unresolved divergence) + a quiet
    // breakdown (the enumeration). "Divergent answers" vagueness + open/resolved blindness retired.
    var state = answerState(claims);
    var breakdown = rollupEnum(claims);
    var label = qLabel(q.question_index);                 // "Q1)" convention, mono
    var statusCls = 'q-status' + (q.status === 'withdrawn' ? ' withdrawn' : '');
    // §6: question header is a SECTION header, not a card — its own organ, so it can no
    // longer read as a fifth claim.
    return '<div class="q-row" data-qid="' + esc(q.id != null ? q.id : '') + '">' +
      '<div class="q-head" data-q="1">' +
        '<div class="q-head-top">' + (label ? '<span class="q-label">' + esc(label) + '</span>' : '') +
          '<span class="q-text">' + esc(q.question_text) + '</span>' +
          (q.status ? '<span class="' + statusCls + '">' + esc(q.status) + '</span>' : '') +
          '<span class="q-chevron">▾</span>' +
        '</div>' +
        ((state.word || breakdown) ? '<div class="q-rollup">' +
          (state.word ? '<span class="q-state ' + state.cls + '">' + esc(state.word) + '</span>' : '') +
          (breakdown ? '<span class="q-breakdown">' + esc(breakdown) + '</span>' : '') + '</div>' : '') +
      '</div>' +
      '<div class="q-claims">' + (claims.map(function (c) { return renderClaim(c, ctx); }).join('') || '<div class="claim"><span class="claim-text" style="color:var(--text-muted)">No claims recorded.</span></div>') + '</div>' +
    '</div>';
  }

  /* ── production posture ──────────────────────────────────────── */
  function renderProduction(d) {
    var html = '<div class="engine-grid">';
    (d.engines || []).forEach(function (eng) {
      html += '<div class="engine-box" data-stratum="' + esc(eng.dispatch_id) + '" title="Open the evidence room for this engine">' +
        '<span class="engine-state">' + stateChip(eng, false) + '</span>' +
        '<div class="engine-name">' + esc(engineDisplayName(eng.source_name)) + '</div>' +
        '<div class="engine-meta">' + (eng.role ? esc(eng.role) : '') +
          (eng.source_count > 0 ? '<span class="sources"> · ' + eng.source_count + ' sources</span>' : '') + '</div>' +
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

  // §9: title fallback chain. display_title → first H1 of the synthesis → first sentence of
  // refined_prompt (ellipsized). The six-line operational prompt never renders at title scale.
  function renderTitle(d) {
    var s = d.session || {};
    if (s.display_title && String(s.display_title).trim()) return String(s.display_title).trim();
    var synthMd = d.synthesis && d.synthesis.layer_1_synthesis_md;
    if (synthMd) { var m = synthMd.match(/^#\s+(.+)$/m); if (m) return m[1].trim(); }
    var rp = (s.refined_prompt || s.original_brief || '').trim();
    if (rp) { var first = (rp.split(/(?<=[.?!])\s/)[0] || rp).trim(); return first.length > 100 ? first.slice(0, 100).trim() + '…' : first; }
    return 'Research session';
  }

  /* ── header (both postures) ──────────────────────────────────── */
  function renderHeader(d, committed) {
    var s = d.session || {};
    var title = renderTitle(d);
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
  // Attached once; the views below just swap root.innerHTML, the delegated listener persists.
  function wireOnce() {
    root.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-back]');
      if (b) { back(); return; }
      var up = ev.target.closest('[data-unparsed]');
      if (up) { var pre = up.parentNode.querySelector('.stratum-raw'); if (pre) { pre.hidden = !pre.hidden; up.textContent = pre.hidden ? 'View unparsed' : 'Hide unparsed'; } return; }
      var door = ev.target.closest('[data-door]');
      if (door) { var w = door.getAttribute('data-door'); nav(w === 'synthesis' ? showSynthesis : w === 'claims' ? showClaims : showEngines); return; }
      var jump = ev.target.closest('[data-jump]');
      if (jump) {
        var qid = jump.getAttribute('data-jump');
        nav(function () { showClaims(); var el = root.querySelector('.q-row[data-qid="' + qid + '"]'); if (el) { el.classList.add('active'); el.scrollIntoView(); } });
        return;
      }
      var strat = ev.target.closest('[data-stratum]');
      if (strat) { ev.preventDefault(); var id = strat.getAttribute('data-stratum'); nav(function () { showStratum(id); }); return; }
      var cl = ev.target.closest('.claim-cite-link');
      if (cl) { var dr = cl.closest('.claim').querySelector('.citation-drawer'); if (dr) dr.classList.toggle('open'); return; }
      var qh = ev.target.closest('.q-head');
      if (qh) { qh.parentNode.classList.toggle('active'); return; }
    });
  }

  /* ── F11 stratum page (the evidence room) ────────────────────── */
  // Signals band — the system's voice. Order: status · cost · tokens · received-at
  // (· dispatched-at when present). Absent fields are OMITTED, never dashed. A source
  // count that disagrees with the list is flagged here, never silently reconciled.
  function renderSignals(eng, sourcesLen) {
    var parts = [stateLabel(eng)];
    if (eng.cost_usd != null) parts.push('$' + Number(eng.cost_usd).toFixed(4));
    if (eng.tokens_in != null || eng.tokens_out != null) parts.push((eng.tokens_in || 0) + ' in / ' + (eng.tokens_out || 0) + ' out');
    if (eng.response_received_at) parts.push('received ' + fmtDateTime(eng.response_received_at));
    if (eng.dispatched_at) parts.push('dispatched ' + fmtDateTime(eng.dispatched_at));
    var band = '<div class="stratum-signals">' + parts.map(function (p) { return '<span>' + esc(p) + '</span>'; }).join('<span class="sig-dot">·</span>') + '</div>';
    if (eng.source_count != null && eng.source_count !== sourcesLen) {
      band += '<div class="stratum-flag">⚠ source count mismatch — strip records ' + esc(eng.source_count) + ', the list below has ' + sourcesLen + '. The list is shown; the count is not reconciled.</div>';
    }
    // error_detail belongs here only when the return did not complete cleanly.
    if (eng.render_state !== 'returned' && eng.render_state !== 'returned_empty' && eng.error_detail) {
      band += '<div class="stratum-error-detail">' + esc(eng.error_detail) + '</div>';
    }
    // §8: the registry/model name appears in exactly ONE place in the whole face — here.
    return '<section class="stratum-block"><div class="stratum-label">Signals</div>' +
      '<div class="stratum-registry">' + esc(eng.source_name) + '</div>' + band + '</section>';
  }

  function renderStratumPage(eng) {
    var env = parseEnvelope(eng.content);
    var sources = Array.isArray(env.sources) ? env.sources : [];
    var html = '<div class="stratum-page">';
    html += '<a class="stratum-back" data-back="1">← Back to session</a>';
    // friendly name only (registry name moves to signals — discharges F7 at this layer)
    html += '<div class="stratum-engine">' + esc(engineDisplayName(eng.source_name)) + '</div>';

    // 1 — what was asked (the dispatcher's voice)
    if (eng.prompt_sent) {
      html += '<section class="stratum-block"><div class="stratum-label">What was asked</div>' +
        '<blockquote class="stratum-asked">' + nl2p(eng.prompt_sent) + '</blockquote></section>';
    }

    // 2 — what came back (the engine's voice)
    html += '<section class="stratum-block"><div class="stratum-label">What came back</div>';
    if (eng.render_state === 'failed_with_reason') {
      html += '<div class="stratum-error-detail">' + esc(eng.error_detail || 'No reason recorded.') + '</div>';
    } else if (env.text) {
      html += '<div class="stratum-body measure">' + md(env.text) + '</div>';
    } else {
      html += '<div class="stratum-empty">No parsed text in this return.</div>';
    }
    // raw-always-reachable: the literal envelope value, one quiet click away
    var rawText = (env.raw !== undefined)
      ? (typeof env.raw === 'string' ? env.raw : JSON.stringify(env.raw, null, 2))
      : (eng.content || '');
    if (rawText) {
      html += '<button class="stratum-unparsed" data-unparsed="1">View unparsed</button>' +
        '<pre class="stratum-raw" hidden>' + esc(rawText) + '</pre>';
    }
    html += '</section>';

    // 3 — signals (the system's voice)
    html += renderSignals(eng, sources.length);

    // the sources door — the last layer, opening outward
    html += '<section class="stratum-block"><div class="stratum-label">Sources (' + sources.length + ')</div>';
    if (!sources.length) {
      html += '<div class="stratum-empty">No sources returned.</div>';
    } else {
      html += '<ol class="stratum-sources">' + sources.map(function (s) {
        var url = s.url || '';
        return '<li>' + (url
          ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(s.title || url) + '</a>'
          : esc(s.title || '(no link)')) +
          (url ? '<span class="src-domain">' + esc(domainOf(url)) + '</span>' : '') +
          (s.snippet ? '<div class="src-snippet">' + esc(s.snippet) + '</div>' : '') + '</li>';
      }).join('') + '</ol>';
    }
    html += '</section></div>';
    return html;
  }

  /* ── COVER architecture: one screen per onion layer, a back-stack between them ── */
  function backLink() { return '<a class="stratum-back" data-back="1">← Back</a>'; }
  function showCover()      { root.innerHTML = renderCover(lastData, lastCtx); }
  function showSynthesis()  { root.innerHTML = backLink() + '<div class="layer-screen">' + renderSynthesisDoc(lastData) + '</div>'; }
  function showClaims()     { root.innerHTML = backLink() + '<div class="layer-screen">' + renderStrataNav(lastData, lastCtx) + '</div>'; }
  function showEngines()    { root.innerHTML = backLink() + '<div class="layer-screen">' + renderFooter(lastData) + '</div>'; }
  function showProduction() { root.innerHTML = renderHeader(lastData, false) + renderProduction(lastData); }
  function showStratum(id)  { var eng = lastCtx && lastCtx.enginesByDispatch[id]; if (eng) root.innerHTML = renderStratumPage(eng); }

  var viewStack = [];
  function nav(thunk) { viewStack.push(thunk); thunk(); window.scrollTo(0, 0); }
  function back() { if (viewStack.length > 1) viewStack.pop(); (viewStack[viewStack.length - 1] || showCover)(); window.scrollTo(0, 0); }

  // Executive summary for the cover: prefer a summary-type/titled section, else the leading
  // section, else the synthesis's opening paragraphs. Prompts never appear here (Reg's ruling).
  function coverSummary(d) {
    var secs = d.sections || [];
    var pick = secs.filter(function (s) { return /summary|executive|answer|overview/i.test((s.section_type || "") + " " + (s.title || "")); })[0];
    if (pick) return nl2p(pick.content_md);
    if (secs.length) return nl2p(secs[0].content_md);
    var md = d.synthesis && d.synthesis.layer_1_synthesis_md;
    if (md) return nl2p(md.split(/\n{2,}/).slice(0, 2).join("\n\n"));
    return "";
  }

  // The cover (Eames WN 85926361): title · metadata · the questions · the answer · three doors.
  // No claims, citations, raw, join notes, or prompts — one click per layer, no mixing.
  function renderCover(d, ctx) {
    var committed = d.synthesis && d.synthesis.layer_1_synthesis_md;
    var html = '<div class="cover">' + renderHeader(d, committed);   // title + ratified metadata line
    var claimsByQ = groupBy(d.claims, 'question_id');
    html += '<div class="cover-block"><div class="cover-label">The questions</div><ol class="cover-questions">';
    (d.questions || []).forEach(function (q) {
      var cq = claimsByQ[q.id] || [];
      var state = answerState(cq);                       // same grammar as the claims layer
      var breakdown = rollupEnum(cq);
      // asked-of line from engine_dispatch.question_id — OMITTED (never dashed) until backfilled.
      var asked = (d.engines || []).filter(function (e) { return e.question_id && e.question_id === q.id; })
        .map(function (e) { return engineDisplayName(e.source_name); });
      html += '<li class="cover-q" data-jump="' + esc(q.id) + '">' +
        '<div class="cover-q-line">' +
          (qLabel(q.question_index) ? '<span class="q-label">' + esc(qLabel(q.question_index)) + '</span>' : '') +
          '<span class="cover-q-text">' + esc(q.question_text) + '</span>' +
        '</div>' +
        '<div class="cover-q-meta">' +
          (state.word ? '<span class="q-state ' + state.cls + '">' + esc(state.word) + '</span>' : '') +
          (breakdown ? '<span class="q-breakdown">' + esc(breakdown) + '</span>' : '') +
          (asked.length ? '<span class="cover-q-asked">asked of ' + esc(asked.join(', ')) + '</span>' : '') +
        '</div>' +
        '</li>';
    });
    html += '</ol></div>';
    var summary = coverSummary(d);
    if (summary) html += '<div class="cover-block"><div class="cover-label">The answer</div><div class="cover-answer synth-body">' + summary + '</div></div>';
    html += renderMaterialStatus(d);   // §"what can I use" — confidence_ratings_json, first-class
    html += '<div class="cover-doors">' +
      '<span class="cover-door" data-door="synthesis">Full synthesis</span>' +
      '<span class="cover-door" data-door="claims">Claims</span>' +
      '<span class="cover-door" data-door="engines">Engine returns</span>' +
      '</div></div>';
    return html;
  }

  /* ── render + boot ───────────────────────────────────────────── */
  function render(d) {
    var ctx = {
      enginesByDispatch: {}, citationsByClaim: groupBy(d.citations, 'claim_id'), sourcesByClaim: groupBy(d.claim_sources, 'claim_id'),
    };
    (d.engines || []).forEach(function (e) { ctx.enginesByDispatch[e.dispatch_id] = e; });
    lastData = d; lastCtx = ctx;
    var committed = d.synthesis && d.synthesis.layer_1_synthesis_md;
    viewStack = [];
    wireOnce();
    nav(committed ? showCover : showProduction);
  }

  var sid = qs('session');
  if (!sid) { root.innerHTML = '<div class="render-status">No session specified — append <code>?session=&lt;uuid&gt;</code> to the URL.</div>'; return; }
  fetchRender(sid).then(render).catch(function (e) {
    root.innerHTML = '<div class="render-error">Could not load this session: ' + esc(e.message) + '</div>';
  });
})();
