/* ── angelia-mst.js ── Supabase REST helper and MST content helpers ── */

/* ── Supabase REST ── */
async function supabaseRest(method, table, params, body) {
  const url = new URL(`${PRIME_CONFIG.supabaseUrl}/rest/v1/${table}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const headers = { 'apikey': PRIME_CONFIG.supabaseKey };
  if (body) headers['Content-Type'] = 'application/json';
  if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation';
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url.toString(), opts);
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  } catch { return null; }
}

/* ── MST content helpers ── */
function parseMst(content) {
  const csIdx = content.indexOf('CURRENT STATE');
  const alIdx = content.indexOf('AMENDMENTS LOG');
  const csText = (csIdx !== -1 && alIdx !== -1)
    ? content.slice(csIdx + 'CURRENT STATE'.length, alIdx).replace(/^\n+/, '').trim()
    : (csIdx !== -1 ? content.slice(csIdx + 'CURRENT STATE'.length).replace(/^\n+/, '').trim() : '');
  const alText = alIdx !== -1
    ? content.slice(alIdx + 'AMENDMENTS LOG'.length).replace(/^\n+/, '').trim()
    : '';
  const entries = alText ? alText.split(/\n{2,}/).filter(e => e.trim()).slice(-3) : [];
  return { currentState: csText, amendments: entries };
}

function assembleMstContent(q1, q2, q3, q4) {
  return 'REASONING MEMBRANE\n\n' + (q1 || '').trim() + '\n\n' + (q2 || '').trim() + '\n\n' + (q3 || '').trim() +
    '\n\nCURRENT STATE\n\n' + (q4 || '').trim() + '\n\nAMENDMENTS LOG\n';
}

function updateMstContent(existing, newCurrentState, dateEntry) {
  let c = existing;
  const csIdx = c.indexOf('CURRENT STATE');
  const alIdx = c.indexOf('AMENDMENTS LOG');
  if (csIdx !== -1 && alIdx !== -1) {
    c = c.slice(0, csIdx) + 'CURRENT STATE\n\n' + newCurrentState.trim() + '\n\n' + c.slice(alIdx);
  }
  return c.trimEnd() + '\n\n' + dateEntry + '\n';
}

function extractCurrentState(entry) {
  const clean = entry.replace(/^(WORLD-STATE UPDATE|REASONING REVISION):\s*/i, '').trim();
  const nsIdx = clean.toLowerCase().indexOf('next step');
  if (nsIdx !== -1) {
    const end = clean.indexOf('\n', nsIdx);
    return clean.slice(0, end !== -1 ? end : undefined).trim();
  }
  return ((clean.match(/[^.!?]+[.!?]+/g) || [clean]).slice(0, 2)).join(' ').trim();
}

function mstTitle(domain) {
  const slug = domain.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
  const d = new Date();
  const mon = d.toLocaleString('en-GB', { month: 'short' });
  return `MST_${slug}_${mon}${d.getFullYear()}`;
}
