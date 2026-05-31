/* ── connie-config.js ── Per-Prime config, constants, hold prompts ── */

var PRIME_CONFIG = {
  lineage:      'constantinople',
  name:         'Constantinople',
  initial:      'C',
  role:         'Substrate Prime — Phronesis Project',
  accent:       '#2C3E6E',
  accentDim:    'rgba(44, 62, 110, 0.10)',
  accentBorder: 'rgba(44, 62, 110, 0.35)',
  placeholder:  'Write to Constantinople…',
  instanceId:   '9293772f-85ab-4aaf-8c6c-8c00515bd6f2',
  navigatorUrl: 'https://phronesis-infrastructure.onrender.com/',
  sessionBudget: 500000,
  supabaseUrl:  'https://vysenpymsfhgionqfulf.supabase.co',
  supabaseKey:  'sb_publishable_sx8JQVtRhBQCgsvvDYI8RQ_6PlZxs4Y',
};

var EDGE_URL      = 'https://vysenpymsfhgionqfulf.supabase.co/functions/v1/api-prime-invoke';
var RETRY_LIMIT   = 3;
var RETRY_DELAY   = 1500;
var FETCH_TIMEOUT = 150000;
var FOUR_HOURS    = 4 * 60 * 60 * 1000;

/* ── Hold-this: prompt configs per domain ── */
var HOLD_PROMPTS = {
  code: [
    { label: 'What did you examine and what did you conclude?',
      hint:  'The decisions reached — not a summary of the work, but what was settled and why.',
      placeholder: 'The schema change was decided…' },
    { label: 'What is working, what is fragile, and what are you uncertain about?',
      hint:  'Name fragile dependencies and open questions honestly. What would break under pressure?',
      placeholder: 'The wake-deltas join is stable but…' },
    { label: 'What did you rule out, and why?',
      hint:  'What looks like a valid alternative that was deliberately not chosen? Future sessions need to know not to revisit it.',
      placeholder: 'Rejected per-table audit triggers in favour of…' },
    { label: 'Current status and next step if you return to this',
      hint:  'This becomes the CURRENT STATE block — the first thing read on reactivation. Be specific about the next step.',
      placeholder: 'Migration drafted. Next: apply to staging…' },
  ],
};
