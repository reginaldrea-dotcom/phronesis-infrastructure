/* ── angelia-config.js ── Per-Prime config, constants, hold prompts ──
 * Angelia — the soft-instructions Prime (formerly Hermes). Chat seat cloned from
 * the Connie shell; the modules read lineage/name/colour from PRIME_CONFIG, so
 * this file is the only per-Prime surface. Served behind Cloudflare Access;
 * talks to api-prime-invoke with the publishable key only.
 *
 * Palette: Eames-finalised deep steel blue (baton f012315c, MST 9fb8481e,
 * Reg-confirmed 10 Jun). Distinct from Theo cobalt #1F3D6B — a sibling signal.
 */

var PRIME_CONFIG = {
  lineage:      'angelia',
  name:         'Angelia',
  initial:      'A',
  role:         'Research Prime — Phronesis Project',   // provisional display role; confirm with Reg/Eames
  accent:       '#2A4A5C',                               // Eames-finalised deep steel blue (baton f012315c, MST 9fb8481e; Reg-confirmed)
  accentDim:    'rgba(42, 74, 92, 0.10)',
  accentBorder: 'rgba(42, 74, 92, 0.35)',
  placeholder:  'Write to Angelia…',
  instanceId:   '12731944-fd25-4e83-a961-466f01785e51',
  navigatorUrl: 'https://phronesis-infrastructure.onrender.com/',
  sessionBudget: 500000,
  supabaseUrl:  'https://vysenpymsfhgionqfulf.supabase.co',
  supabaseKey:  'sb_publishable_sx8JQVtRhBQCgsvvDYI8RQ_6PlZxs4Y',
};

var EDGE_URL      = 'https://vysenpymsfhgionqfulf.supabase.co/functions/v1/api-prime-invoke';
var RETRY_LIMIT   = 3;
var RETRY_DELAY   = 1500;
var FETCH_TIMEOUT = 240000;   // 4 min — headroom for large artefact generations
var FOUR_HOURS    = 4 * 60 * 60 * 1000;

/* ── Hold-this: prompt configs per domain ── (inherited from the Connie shell; generic) */
var HOLD_PROMPTS = {
  code: [
    { label: 'What did you examine and what did you conclude?',
      hint:  'The decisions reached — not a summary of the work, but what was settled and why.',
      placeholder: 'The approach was decided…' },
    { label: 'What is working, what is fragile, and what are you uncertain about?',
      hint:  'Name fragile dependencies and open questions honestly. What would break under pressure?',
      placeholder: 'The dispatch path is stable but…' },
    { label: 'What did you rule out, and why?',
      hint:  'What looks like a valid alternative that was deliberately not chosen? Future sessions need to know not to revisit it.',
      placeholder: 'Rejected the single-engine route in favour of…' },
    { label: 'Current status and next step if you return to this',
      hint:  'This becomes the CURRENT STATE block — the first thing read on reactivation. Be specific about the next step.',
      placeholder: 'Drafted. Next: …' },
  ],
};
