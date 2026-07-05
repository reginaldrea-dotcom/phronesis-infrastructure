// render_document — hand a FINISHED Markdown document to the markdown-bridge (/render) for
// deterministic assembly to docx/pdf against the house template, uploaded to Drive in one pass.
// The bridge is a separate container service (pandoc 3.6.1 + weasyprint + the house reference.docx /
// reference.css) — see services/markdown-bridge. This tool is the api-prime-invoke caller half that the
// bridge README flagged as the follow-on. Design of record for the styling/convention: Eames d96dcf7b.
//
// SINGLE-PASS DISCIPLINE: the whole document must be ONE finished markdown string (YAML front-matter for
// metadata; house convention blocks: ::: {.callout-volatile custom-style="Callout Volatile"} etc.,
// ::: page-break at layer boundaries). No mid-generation tool calls — that single pass is the latency
// win the bridge exists for.
//
// ENV: BRIDGE_API_KEY (required — the /render auth key, same value as the bridge's Fly secret);
//      MARKDOWN_BRIDGE_URL (optional — defaults to the Fly app URL).

import type { Tool } from "./types.ts";

const DEFAULT_BRIDGE_URL = "https://phronesis-markdown-bridge.fly.dev";
const VALID_FORMATS = new Set(["docx", "pdf"]);

function fail(msg: string): string {
  return `render_document error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const renderDocumentTool: Tool = {
  definition: {
    name: "render_document",
    description:
      "Render a FINISHED Markdown document to docx and/or pdf against the house template (markdown-bridge) and upload it to a Google Drive folder in one pass. Pass the WHOLE document as one markdown string: YAML front-matter carries metadata; use the house convention blocks — a callout is ::: {.callout-volatile custom-style=\"Callout Volatile\"} (swap class+custom-style for the four types: callout-single-source / callout-volatile / confirm-box / panel-questions), and a hard layer break is ::: page-break. docx uses the house reference.docx (pass reference_docx_drive_id); pdf uses the house weasyprint CSS baked into the service. Returns the Drive ids of the renderings. Author the document in a SINGLE pass — do not call other tools mid-generation.",
    input_schema: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "The full document as one markdown string (YAML front-matter for metadata; house convention blocks)." },
        stem: { type: "string", description: "Shared filename stem across formats, e.g. 'SY_Lineage_Subject_YYYY-MM' (standard §4)." },
        formats: { type: "array", items: { type: "string", enum: ["docx", "pdf"] }, description: "Subset of docx/pdf. Default: both." },
        drive_folder_id: { type: "string", description: "Google Drive folder id for delivery — the renderings are uploaded here." },
        reference_docx_drive_id: { type: "string", description: "Optional: Drive id of the house reference.docx (docx styling). Omit to fall back to pandoc's default reference." },
      },
      required: ["markdown", "stem", "drive_folder_id"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const i = input as { stem?: unknown; formats?: unknown };
    const fmts = Array.isArray(i?.formats) ? (i.formats as unknown[]).join(",") : "docx,pdf";
    return `render_document: ${String(i?.stem ?? "").slice(0, 40)} [${fmts}]`;
  },

  run: async (input) => {
    const i = input as { markdown?: unknown; stem?: unknown; formats?: unknown; drive_folder_id?: unknown; reference_docx_drive_id?: unknown };
    const markdown = typeof i?.markdown === "string" ? i.markdown : "";
    const stem = typeof i?.stem === "string" ? i.stem.trim() : "";
    const driveFolderId = typeof i?.drive_folder_id === "string" ? i.drive_folder_id.trim() : "";
    if (!markdown.trim()) return fail("markdown is empty.");
    if (!stem) return fail("stem is required (the shared filename stem across formats).");
    if (!driveFolderId) return fail("drive_folder_id is required (the Drive delivery folder).");

    let formats = Array.isArray(i?.formats)
      ? (i.formats as unknown[]).map((f) => String(f)).filter((f) => VALID_FORMATS.has(f))
      : [];
    if (formats.length === 0) formats = ["docx", "pdf"];

    const refDocx = typeof i?.reference_docx_drive_id === "string" && i.reference_docx_drive_id.trim()
      ? i.reference_docx_drive_id.trim() : null;

    const bridgeUrl = (Deno.env.get("MARKDOWN_BRIDGE_URL") || DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
    const bridgeKey = Deno.env.get("BRIDGE_API_KEY");
    if (!bridgeKey) return fail("BRIDGE_API_KEY is not configured in this function's env — cannot authenticate to the render service.");

    try {
      const res = await fetch(`${bridgeUrl}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Key": bridgeKey },
        body: JSON.stringify({
          markdown,
          stem,
          formats,
          drive_folder_id: driveFolderId,
          reference_docx_drive_id: refDocx,
        }),
      });
      const text = await res.text();
      if (!res.ok) return fail(`render service ${res.status}: ${text.slice(0, 500)}`);
      let data: { ok?: boolean; stem?: string; renderings?: Array<{ format: string; drive_id: string; name: string; bytes: number }> };
      try { data = JSON.parse(text); } catch { return fail(`render service returned non-JSON: ${text.slice(0, 300)}`); }
      const renderings = Array.isArray(data?.renderings) ? data.renderings : [];
      return JSON.stringify({
        ok: true,
        stem: data?.stem ?? stem,
        renderings, // [{format, drive_id, name, bytes}]
        "[SYSTEM]": `Rendered ${renderings.length} file(s) via the markdown-bridge and uploaded to Drive folder ${driveFolderId}. Drive ids: ${renderings.map((r) => `${r.format}=${r.drive_id}`).join(", ") || "none"}. Map each drive_id back to the canonical markdown artifact via drive_assets (standard §3).`,
      });
    } catch (err) {
      return fail(`render request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
