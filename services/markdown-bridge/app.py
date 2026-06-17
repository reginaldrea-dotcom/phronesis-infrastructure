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
# (standard §3) — that mapping is the keeper's index, not this service's job. This service does the
# render + the SINGLE upload and returns the ids.
#
# GATED ON PROVISIONING (see README): a host with pandoc installed, a Google service-account credential
# with write access to the delivery folder (GOOGLE_SERVICE_ACCOUNT_JSON), and the house reference.docx.

import base64
import hashlib
import hmac
import json
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

app = FastAPI(title="Markdown Bridge", version="1.0")

# Formats this service can emit. docx is the primary path (uses the house reference.docx).
# pdf uses weasyprint as the pandoc engine — HTML/CSS based, no LaTeX/texlive, so the image stays lean
# and prose+table documents render well. Swap to a LaTeX engine only if heavy math is ever needed.
SUPPORTED_FORMATS = {"docx", "pdf"}
PDF_ENGINE = "weasyprint"

DRIVE_MIME = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
}


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


def _drive():
    """Drive client from a service-account credential (env GOOGLE_SERVICE_ACCOUNT_JSON: raw JSON or base64)."""
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        raise HTTPException(503, "GOOGLE_SERVICE_ACCOUNT_JSON not configured")
    try:
        info = json.loads(raw)
    except json.JSONDecodeError:
        info = json.loads(base64.b64decode(raw))
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/drive.file"]
    )
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _fetch_reference(drive, file_id: str, dest: Path) -> None:
    """Download the cached house reference.docx from Drive to dest."""
    data = drive.files().get_media(fileId=file_id).execute()
    dest.write_bytes(data)


def _pandoc(md_path: Path, out_path: Path, fmt: str, reference: Path | None) -> None:
    cmd = ["pandoc", str(md_path), "-o", str(out_path), "--standalone"]
    if fmt == "docx" and reference is not None:
        cmd += ["--reference-doc", str(reference)]
    if fmt == "pdf":
        cmd += [f"--pdf-engine={PDF_ENGINE}"]
    # One deterministic pass, no LLM, no iteration. Bounded so a malformed doc can't hang the host.
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise HTTPException(422, f"pandoc {fmt} failed: {proc.stderr.strip()[:500]}")


def _upload(drive, path: Path, name: str, mime: str, folder_id: str) -> str:
    media = MediaFileUpload(str(path), mimetype=mime, resumable=False)
    created = drive.files().create(
        body={"name": name, "parents": [folder_id]},
        media_body=media,
        fields="id",
        supportsAllDrives=True,
    ).execute()
    return created["id"]


@app.get("/health")
def health():
    # Reports readiness without leaking secrets: is pandoc present, are creds configured.
    try:
        v = subprocess.run(["pandoc", "--version"], capture_output=True, text=True, timeout=10)
        pandoc_ok = v.returncode == 0
        pandoc_ver = v.stdout.splitlines()[0] if pandoc_ok else None
    except Exception:
        pandoc_ok, pandoc_ver = False, None
    return {
        "ok": pandoc_ok,
        "pandoc": pandoc_ver,
        "drive_creds": bool(os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")),
        "auth_configured": bool(os.environ.get("BRIDGE_API_KEY")),
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

        reference = None
        if "docx" in fmts and req.reference_docx_drive_id:
            reference = tmpd / "reference.docx"
            _fetch_reference(drive, req.reference_docx_drive_id, reference)

        # Single render pass per requested format, then a SINGLE upload each (baton: single-pass, single-upload).
        for fmt in fmts:
            out_path = tmpd / f"{req.stem}.{fmt}"
            _pandoc(md_path, out_path, fmt, reference)
            name = f"{req.stem}.{fmt}"
            drive_id = _upload(drive, out_path, name, DRIVE_MIME[fmt], req.drive_folder_id)
            renderings.append({"format": fmt, "drive_id": drive_id, "name": name, "bytes": out_path.stat().st_size})

    return {"ok": True, "stem": req.stem, "renderings": renderings}
