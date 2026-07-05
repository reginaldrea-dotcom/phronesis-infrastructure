# Markdown Bridge — forward render pipeline (Doc storage 4/4, baton d216b2fb).
#
# The forward half of the ratified Document Storage & Accessibility Standard (artifact 35e5049c §7),
# built to the architecture in SY_Theophrastus_DocxLatency_Synthesis (the "Markdown Bridge"):
#   single-pass Markdown  ->  Pandoc render to docx/pdf against a house reference template  ->  single upload.
#
# WHY A SEPARATE SERVICE (not a Supabase Edge Function): the dominant latency in the old flow was the
# iterative tool-call loop inside the Claude session (context re-inflation), NOT the render. The fix is
# to generate the whole document in ONE pass and assemble it deterministically OUTSIDE the session.
# Pandoc is a native binary + the docx path wants a real reference.docx, neither of which runs in a
# Deno Edge Function or a Cloudflare Worker — so this is a small container service the Prime calls once.
#
# DRIVE AUTH — OAuth USER delegation (not a service account). A service account has ZERO storage quota
# in a personal "My Drive" (storageQuotaExceeded on upload), and the SA-copy workaround fails too (a copy
# is owned by the SA that made it). So the service authenticates AS THE USER via a stored refresh token:
# rendered files are owned by the user and count against their 15GB — free, no Workspace. The one-time
# consent is done through /oauth/start -> /oauth/callback (below); the resulting refresh token is set as
# the GOOGLE_OAUTH_REFRESH_TOKEN secret.
#
# CONTRACT
#   POST /render   (auth: header  X-Bridge-Key == env BRIDGE_API_KEY, constant-time)
#     body: {
#       "markdown":   "<full document as one markdown string; YAML front-matter carries metadata>",
#       "stem":       "SY_Lineage_Subject_YYYY-MM",     # shared filename stem across formats (standard §4)
#       "formats":    ["docx", "pdf"],                   # subset; docx is primary
#       "drive_folder_id": "<google drive folder id>",   # client delivery folder; renderings live in Drive (§2)
#       "reference_docx_drive_id": "<id|null>"           # the house reference.docx (cached); null -> pandoc default
#     }
#     -> { "ok": true, "stem": "...", "renderings": [ {"format":"docx","drive_id":"...","name":"...","bytes":N}, ... ] }
#
# The caller maps each returned drive_id back to the canonical Markdown artifact via drive_assets
# (standard §3) — that index is the keeper's, not this service's. This service does the render + the
# SINGLE upload and returns the ids.

import hashlib
import hmac
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import RedirectResponse, PlainTextResponse
from pydantic import BaseModel
from google.oauth2.credentials import Credentials as UserCredentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

app = FastAPI(title="Markdown Bridge", version="1.1")

# docx is the primary path (uses the house reference.docx). pdf uses weasyprint as the pandoc engine —
# HTML/CSS based, no LaTeX/texlive — so the image stays lean and prose+table documents render well.
SUPPORTED_FORMATS = {"docx", "pdf"}
PDF_ENGINE = "weasyprint"

# House styling assets baked into the image (Eames design of record d96dcf7b):
#   - reference.css: the pdf/weasyprint house style (--reference-doc is docx-only, so pdf needs its own).
#   - pagebreak.lua: expands the one authoring token (::: page-break) into a real break per format
#     (raw OpenXML for docx; the .page-break class + reference.css handles pdf/html).
# .exists() guards keep the service running even if an asset is absent.
HOUSE_CSS = Path(__file__).parent / "reference.css"
PAGEBREAK_LUA = Path(__file__).parent / "pagebreak.lua"
# House reference.docx baked into the image (Eames, carries the four callout Word paragraph styles).
# Used as the docx --reference-doc by DEFAULT. Baked rather than Drive-fetched because the bridge's
# drive.file scope can't read a hand-uploaded file; a caller may still override via reference_docx_drive_id.
HOUSE_DOCX = Path(__file__).parent / "reference.docx"

DRIVE_MIME = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
}

# drive.file = the narrowest ("sensitive", not "restricted") Drive scope: per-file access to files the
# app creates. The SA smoke confirmed this scope accepts create-with-parent (it reached the quota check),
# so an OAuth user with the same scope can create the rendering in the target folder, owned by the user.
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
TOKEN_URI = "https://oauth2.googleapis.com/token"
# Where Google sends the consent redirect. Override via env if the app URL changes.
REDIRECT_URI = os.environ.get("OAUTH_REDIRECT_URI", "https://phronesis-markdown-bridge.fly.dev/oauth/callback")


class RenderRequest(BaseModel):
    markdown: str
    stem: str
    formats: list[str] = ["docx"]
    drive_folder_id: str
    reference_docx_drive_id: str | None = None


def _authorized(presented: str | None) -> bool:
    expected = os.environ.get("BRIDGE_API_KEY")
    if not expected or not presented:
        return False
    return hmac.compare_digest(
        hashlib.sha256(presented.encode()).digest(),
        hashlib.sha256(expected.encode()).digest(),
    )


def _oauth_client():
    cid = os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
    csec = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")
    if not (cid and csec):
        raise HTTPException(503, "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not configured")
    return cid, csec


def _drive():
    """Drive client from the stored OAuth USER refresh token (uploads owned by the user, against their quota)."""
    rt = os.environ.get("GOOGLE_OAUTH_REFRESH_TOKEN")
    if not rt:
        raise HTTPException(503, "GOOGLE_OAUTH_REFRESH_TOKEN not configured — run the /oauth/start consent once")
    cid, csec = _oauth_client()
    creds = UserCredentials(
        token=None, refresh_token=rt, client_id=cid, client_secret=csec,
        token_uri=TOKEN_URI, scopes=SCOPES,
    )
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _flow() -> Flow:
    cid, csec = _oauth_client()
    return Flow.from_client_config(
        {"web": {"client_id": cid, "client_secret": csec,
                 "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                 "token_uri": TOKEN_URI, "redirect_uris": [REDIRECT_URI]}},
        scopes=SCOPES, redirect_uri=REDIRECT_URI,
    )


def _fetch_reference(drive, file_id: str, dest: Path) -> None:
    """Download the cached house reference.docx from Drive to dest."""
    dest.write_bytes(drive.files().get_media(fileId=file_id).execute())


def _pandoc(md_path: Path, out_path: Path, fmt: str, reference: Path | None) -> None:
    cmd = ["pandoc", str(md_path), "-o", str(out_path), "--standalone"]
    # Page-break filter for both formats — it only emits the OpenXML break when writing docx;
    # for pdf/html the div carries the .page-break class and reference.css does the break.
    if PAGEBREAK_LUA.exists():
        cmd += ["--lua-filter", str(PAGEBREAK_LUA)]
    if fmt == "docx" and reference is not None:
        cmd += ["--reference-doc", str(reference)]
    if fmt == "pdf":
        cmd += [f"--pdf-engine={PDF_ENGINE}"]
        # House CSS for the weasyprint path (callout boxes, fonts, page-break class).
        if HOUSE_CSS.exists():
            cmd += ["--css", str(HOUSE_CSS)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise HTTPException(422, f"pandoc {fmt} failed: {proc.stderr.strip()[:500]}")


def _upload(drive, path: Path, name: str, mime: str, folder_id: str) -> str:
    media = MediaFileUpload(str(path), mimetype=mime, resumable=False)
    created = drive.files().create(
        body={"name": name, "parents": [folder_id]},
        media_body=media, fields="id", supportsAllDrives=True,
    ).execute()
    return created["id"]


# ── One-time OAuth consent (mint the user refresh token) ────────────────────────────────────────────
# Visit /oauth/start?k=<BRIDGE_API_KEY> in the OWNING user's browser, consent, and /oauth/callback shows
# the refresh token to set as the GOOGLE_OAUTH_REFRESH_TOKEN secret. /start is gated by the bridge key so
# a random visitor can't kick it off; /callback only ever yields the consenter their OWN token.
@app.get("/oauth/start")
def oauth_start(k: str = Query(default="")):
    if not _authorized(k):
        raise HTTPException(401, "bad or missing ?k=<BRIDGE_API_KEY>")
    flow = _flow()
    url, _ = flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="true")
    return RedirectResponse(url)


@app.get("/oauth/callback")
def oauth_callback(code: str = Query(default="")):
    if not code:
        raise HTTPException(400, "missing ?code")
    flow = _flow()
    flow.fetch_token(code=code)
    rt = flow.credentials.refresh_token
    if not rt:
        return PlainTextResponse(
            "No refresh token returned. Re-run /oauth/start (it forces prompt=consent); if this persists, "
            "revoke the app's access at myaccount.google.com/permissions and try again.\n", status_code=400)
    return PlainTextResponse(
        "Consent OK. Set this as the Fly secret GOOGLE_OAUTH_REFRESH_TOKEN, then close this tab:\n\n"
        f"{rt}\n")


@app.get("/health")
def health():
    try:
        v = subprocess.run(["pandoc", "--version"], capture_output=True, text=True, timeout=10)
        pandoc_ok = v.returncode == 0
        pandoc_ver = v.stdout.splitlines()[0] if pandoc_ok else None
    except Exception:
        pandoc_ok, pandoc_ver = False, None
    return {
        "ok": pandoc_ok,
        "pandoc": pandoc_ver,
        "auth_configured": bool(os.environ.get("BRIDGE_API_KEY")),
        "oauth_client_configured": bool(os.environ.get("GOOGLE_OAUTH_CLIENT_ID") and os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")),
        "oauth_refresh_token_set": bool(os.environ.get("GOOGLE_OAUTH_REFRESH_TOKEN")),
    }


@app.post("/render")
def render(req: RenderRequest, x_bridge_key: str | None = Header(default=None)):
    if not _authorized(x_bridge_key):
        raise HTTPException(401, "bad or missing X-Bridge-Key")

    fmts = [f for f in req.formats if f in SUPPORTED_FORMATS]
    if not fmts:
        raise HTTPException(400, f"no supported formats in {req.formats}; supported: {sorted(SUPPORTED_FORMATS)}")
    if not req.markdown.strip():
        raise HTTPException(400, "markdown is empty")

    drive = _drive()
    renderings = []
    with tempfile.TemporaryDirectory() as tmp:
        tmpd = Path(tmp)
        md_path = tmpd / "input.md"
        md_path.write_text(req.markdown, encoding="utf-8")

        # docx reference-doc: an explicit Drive id wins (override); otherwise the baked house doc.
        reference = None
        if "docx" in fmts:
            if req.reference_docx_drive_id:
                reference = tmpd / "reference.docx"
                _fetch_reference(drive, req.reference_docx_drive_id, reference)
            elif HOUSE_DOCX.exists():
                reference = HOUSE_DOCX

        # Single render pass per format, then a SINGLE upload each (baton: single-pass, single-upload).
        for fmt in fmts:
            out_path = tmpd / f"{req.stem}.{fmt}"
            _pandoc(md_path, out_path, fmt, reference)
            name = f"{req.stem}.{fmt}"
            drive_id = _upload(drive, out_path, name, DRIVE_MIME[fmt], req.drive_folder_id)
            renderings.append({"format": fmt, "drive_id": drive_id, "name": name, "bytes": out_path.stat().st_size})

    return {"ok": True, "stem": req.stem, "renderings": renderings}
