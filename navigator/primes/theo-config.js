/* ── theo-config.js ── Config for the Display/Verify render (Eames spec 2835520b) ──
 * Served behind Cloudflare Access at clarev.ai/primes/theo.html (auto-deploy on push).
 * Talks to Supabase with the publishable key only — Cloudflare gates the surface.
 */

var RENDER_CONFIG = {
  supabaseUrl:   'https://vysenpymsfhgionqfulf.supabase.co',
  supabaseKey:   'sb_publishable_sx8JQVtRhBQCgsvvDYI8RQ_6PlZxs4Y',
  renderDataUrl: 'https://vysenpymsfhgionqfulf.supabase.co/functions/v1/theo-render-data',
  // interactive=false: read-only (Napoleon's reading-first). The action affordances
  // (Confirm and dispatch / Commit synthesis / Retry) render as historical records.
  // Flip to true when the write path is wired into the surface (Eames §9).
  interactive:   false,
};

// Engine display names — config, not hardcoded in the renderer (Eames §4b).
var ENGINE_DISPLAY = {
  'perplexity-sonar-pro':           'Perplexity Sonar Pro',
  'perplexity-sonar-deep-research': 'Perplexity Sonar Deep Research',
  'perplexity-sonar-reasoning-pro': 'Perplexity Sonar Reasoning Pro',
  'gemini-deep-research':           'Gemini Deep Research',
  'gemini-3-1-pro':                 'Gemini 3.1 Pro',
  'gemini-2-5-pro':                 'Gemini 2.5 Pro',
  'openai-o3-deep-research':        'OpenAI o3 Deep Research',
  'openai-o4-mini-deep-research':   'OpenAI o4-mini Deep Research',
  'openai-gpt-5-search':            'OpenAI GPT-5 Search',
  'openai-gpt-4o-search':           'OpenAI GPT-4o Search',
  'anthropic-claude-opus-4-8':      'Claude Opus 4.8',
  'anthropic-claude-sonnet-4-6':    'Claude Sonnet 4.6',
};
function engineDisplayName(key) { return ENGINE_DISPLAY[key] || key; }

// Type labels — version-stable family name (Eames note bfa3c7bb, issue 2): the PRIMARY
// attribution line, over the model string (source_name) as the quiet secondary line.
// Eames owns the exact labels — easy to refine here.
var ENGINE_TYPE = {
  'perplexity-sonar-pro':           'Perplexity Sonar',
  'perplexity-sonar-deep-research': 'Perplexity Deep Research',
  'perplexity-sonar-reasoning-pro': 'Perplexity Sonar Reasoning',
  'gemini-deep-research':           'Gemini Deep Research',
  'gemini-3-1-pro':                 'Gemini 3 Pro',
  'gemini-2-5-pro':                 'Gemini 2.5 Pro',
  'openai-o3-deep-research':        'OpenAI o3 Deep Research',
  'openai-o4-mini-deep-research':   'OpenAI o4-mini Deep Research',
  'openai-gpt-5-search':            'OpenAI GPT-5',
  'openai-gpt-4o-search':           'OpenAI GPT-4o',
  'anthropic-claude-opus-4-8':      'Claude Opus',
  'anthropic-claude-sonnet-4-6':    'Claude Sonnet',
};
function engineType(key) { return ENGINE_TYPE[key] || engineDisplayName(key); }
