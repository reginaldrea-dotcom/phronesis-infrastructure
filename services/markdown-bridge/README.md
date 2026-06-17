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

## Run locally

```bash
docker build -t markdown-bridge services/markdown-bridge
docker run -p 8080:8080 \
  -e BRIDGE_API_KEY=dev-secret \
  -e GOOGLE_SERVICE_ACCOUNT_JSON="$(cat sa.json)" \
  markdown-bridge
curl localhost:8080/health
```

## Deploy (host-agnostic — pick one)

- **Cloud Run** (recommended; serverless, scales to zero, ~free at this volume):
  `gcloud run deploy markdown-bridge --source services/markdown-bridge --region <r> --no-allow-unauthenticated`
  set env `BRIDGE_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`.
- **Fly.io / Railway**: `fly launch` / Railway from the Dockerfile; set the same two env vars.
- **Hetzner VPS (£3–5/mo, per the synthesis)**: `docker run` behind a reverse proxy.

## GATED ON PROVISIONING (the build is done; these are Reg's to supply)

1. **A host** — Cloud Run / Fly / Railway / VPS (decision + account). Recommendation: Cloud Run.
2. **Drive credentials** — a Google **service account** with write access to the delivery folder,
   as `GOOGLE_SERVICE_ACCOUNT_JSON` (raw JSON or base64). Share the delivery folder with the SA email.
3. **The house `reference.docx`** — the styled Word template (house style). A design asset (Eames / Reg).
   Until it exists, docx renders against pandoc's default reference; the wiring already accepts a real one
   via `reference_docx_drive_id`.

Once those land: deploy, set `BRIDGE_API_KEY` + the service URL into the EF env so a Prime tool
(`render_document`, a thin follow-on) can POST to `/render`, then smoke a real MD → docx → Drive round-trip.

## Caller side (follow-on, not in this baton)

A Prime hands off by posting `{markdown, stem, formats, drive_folder_id, reference_docx_drive_id}` to
`/render` — either via a thin `render_document` api-prime-invoke tool (service URL + `BRIDGE_API_KEY`
in EF env) or directly from the navigator. The single-pass generation discipline (one Markdown output,
no mid-generation tool calls) is the prompt/Prime side of the bridge.
