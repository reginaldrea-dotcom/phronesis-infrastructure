/* ── argos-config.js ── Per-Prime config, constants, hold prompts ── */ 

var PRIME_CONFIG = {
  lineage:      'argos',
  name:         'Argos',
  initial:      'A',
  role:         'Builder — Phronesis Project',
  accent:       '#1B4D4D',
  accentDim:    'rgba(27, 77, 77, 0.10)',
  accentBorder: 'rgba(27, 77, 77, 0.35)',
  placeholder:  'Write to Argos\u2026',
  instanceId:   '17bf0f0d-99fc-4456-b729-05a6b6e8a13c',
  navigatorUrl: 'https://clarev.ai/',
  sessionBudget: 500000,
  supabaseUrl:  'https://vysenpymsfhgionqfulf.supabase.co',
  supabaseKey:  'sb_publishable_sx8JQVtRhBQCgsvvDYI8RQ_6PlZxs4Y',
};

var EDGE_URL      = 'https://vysenpymsfhgionqfulf.supabase.co/functions/v1/api-prime-invoke';
var RETRY_LIMIT   = 3;
var RETRY_DELAY   = 1500;
var FETCH_TIMEOUT = 240000;   // 4 min — headroom for large artefact generations (raised from 150s)
var FOUR_HOURS    = 4 * 60 * 60 * 1000;

/* ── Hold-this: prompt configs per domain ── */
var HOLD_PROMPTS = {
  code: [
    { label: 'What did you examine and what did you conclude?',
      hint:  'The decisions reached — not a summary of the work, but what was settled and why.',
      placeholder: 'The auth flow was redesigned to\u2026' },
    { label: 'What is working, what is fragile, and what are you uncertain about?',
      hint:  'Name fragile dependencies and open questions honestly. What would break under pressure?',
      placeholder: 'Token accumulation on wake is stable but\u2026' },
    { label: 'What did you rule out, and why?',
      hint:  'What looks like a valid alternative that was deliberately not chosen? Future sessions need to know not to revisit it.',
      placeholder: 'Rejected polling in favour of\u2026' },
    { label: 'Current status and next step if you return to this',
      hint:  'This becomes the CURRENT STATE block — the first thing read on reactivation. Be specific about the next step.',
      placeholder: 'Build is at 80%. Next: wire the artefact panel dismiss\u2026' },
  ],
  // research (Theophrastus) and creative (Ghostwheel) prompt sets to follow
};
