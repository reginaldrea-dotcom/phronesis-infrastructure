# Markdown Bridge — forward render pipeline (Doc storage 4/4)

Baton **d216b2fb**. The forward half of the Document Storage & Accessibility Standard
(artifact `35e5049c` §7), built to the architecture in `SY_Theophrastus_DocxLatency_Synthesis`.

## What it is

A small, host-agnostic container service that does the **assembly** half of the Markdown Bridge:

```
single-pass Markdown  ->  Pandoc render to docx/pdf against a house reference template  ->  single Drive upload
```

The Prime generates the whole document as **one** Markdown string (single pass, YAML front-matter
carries metadata) — that eliminates the iterative tool-call loop that was the dominant latency
(`DocxLatency` finding). This service then renders + uploads deterministically, with no LLM in the loop.
Expected assembly time: ~10–30s.

It is **not** a Supabase Edge Function: pandoc is a native binary and the docx path needs a real
`reference.docx`, neither of which runs in Deno Deploy or a Cloudflare Worker. It is a Docker container
that runs on any container host.

## API

`POST /render` — header `X-Bridge-Key: <BRIDGE_API_KEY>` (constant-time checked).

```jsonc
{
  "markdown": "<full document as one markdown string>",
  "stem": "SY_Lineage_Subject_YYYY-MM",          // shared filename stem across formats (standard §4)
  "formats": ["docx", "pdf"],                      // docx is primary; pdf via weasyprint
  "drive_folder_id": "<client delivery folder id>",
  "reference_docx_drive_id": "<id | null>"         // the house reference.docx (cached); null -> pandoc default
}
```

Returns `{ "ok": true, "stem": "...", "renderings": [ {"format","drive_id","name","bytes"}, ... ] }`.
The caller maps each `drive_id` back to the canonical Markdown artifact via `drive_assets` (standard §3) —
that index is the keeper's, not this service's.

`GET /health` — reports pandoc presence + whether creds/auth are configured (no secrets leaked).

## Deployment

Hosted on **Fly.io** (`phronesis-markdown-bridge`); Fly builds the image on its remote builder from the
`Dockerfile`, so no local Docker is needed.

```bash
fly deploy -c services/markdown-bridge/fly.toml     # with FLY_API_TOKEN set
```

### Secrets (set via `fly secrets set -a phronesis-markdown-bridge`, never in the repo)

- `BRIDGE_API_KEY` — the `/render` (and `/oauth/start`) auth key.
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` — the OAuth client (Google Cloud Console).
- `GOOGLE_OAUTH_REFRESH_TOKEN` — minted once via the consent flow below.

## Drive auth — OAuth USER delegation (free, no Workspace)

A **service account has zero storage quota in a personal My Drive** (`storageQuotaExceeded` on upload),
and the SA-copy workaround fails too (a copy is owned by the SA that made it). So the service uploads
**as the user**: rendered files are owned by the user and count against their 15 GB.

One-time consent (mint the refresh token from the browser — no local Python):

1. **Google Cloud Console** (project `phronesis-markdown-bridge`):
   - OAuth consent screen → **External**, publishing status **Production** (so the refresh token doesn't
     expire after 7 days; `drive.file` is a *sensitive* — not *restricted* — scope, so unverified
     self-use is fine), add the Drive-owning account as a user.
   - Credentials → create **OAuth client ID** → type **Web application** →
     authorized redirect URI `https://phronesis-markdown-bridge.fly.dev/oauth/callback`.
   - Set the client id/secret as the two Fly secrets above; deploy.
2. Visit `https://phronesis-markdown-bridge.fly.dev/oauth/start?k=<BRIDGE_API_KEY>` in the owning
   account's browser → consent → `/oauth/callback` shows the refresh token.
3. `fly secrets set GOOGLE_OAUTH_REFRESH_TOKEN=<token> -a phronesis-markdown-bridge`. Done — uploads now
   land in any My Drive folder you point `/render` at, owned by you.

The house **`reference.docx`** stays optional (a design asset, Eames/Reg); until it exists docx renders
against pandoc's default reference, and the wiring already accepts a real one via `reference_docx_drive_id`.

## Caller side (follow-on, not in this baton)

A Prime hands off by posting `{markdown, stem, formats, drive_folder_id, reference_docx_drive_id}` to
`/render` — either via a thin `render_document` api-prime-invoke tool (service URL + `BRIDGE_API_KEY`
in EF env) or directly from the navigator. The single-pass generation discipline (one Markdown output,
no mid-generation tool calls) is the prompt/Prime side of the bridge.
