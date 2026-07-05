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
      "Render a FINISHED Markdown document to docx and/or pdf against the house template (markdown-bridge) and upload it to a Google Drive folder in one pass. Supply the document EITHER inline via `markdown`, OR by reference via `markdown_artifact_id` — with the id, the tool fetches the artifact's content itself, so a long document never has to transit a chat window (the author files it as an artifact and hands over just the id; the canonical-markdown-artifact pattern). Use the house convention blocks — a callout is ::: {.callout-volatile custom-style=\"Callout Volatile\"} (four types: callout-single-source / callout-volatile / confirm-box / panel-questions), and a hard layer break is ::: page-break. docx uses the baked house reference.docx; pdf uses the baked house CSS. Returns the Drive ids of the renderings. If authoring inline, do it in a SINGLE pass — no other tool calls mid-generation.",
    input_schema: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "The full document as one markdown string (YAML front-matter for metadata; house convention blocks). Provide this OR markdown_artifact_id." },
        markdown_artifact_id: { type: "string", description: "Alternative to markdown: the id of an artifact whose content IS the finished markdown. The tool fetches it server-side — use this to render a document filed as an artifact without pasting it. If stem is omitted it is derived from the artifact title." },
        stem: { type: "string", description: "Shared filename stem across formats, e.g. 'SY_Lineage_Subject_YYYY-MM' (standard §4). Optional when markdown_artifact_id is given (derived from the artifact title)." },
        formats: { type: "array", items: { type: "string", enum: ["docx", "pdf"] }, description: "Subset of docx/pdf. Default: both." },
        drive_folder_id: { type: "string", description: "Google Drive folder id for delivery — the renderings are uploaded here." },
        reference_docx_drive_id: { type: "string", description: "Optional and rarely used: Drive id of a reference.docx to override the baked house doc. Leave unset (the bridge's drive.file scope can't read a hand-uploaded file; the house doc is baked in)." },
      },
      required: ["drive_folder_id"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const i = input as { stem?: unknown; formats?: unknown };
    const fmts = Array.isArray(i?.formats) ? (i.formats as unknown[]).join(",") : "docx,pdf";
    return `render_document: ${String(i?.stem ?? "").slice(0, 40)} [${fmts}]`;
  },

  run: async (input, ctx) => {
    const i = input as { markdown?: unknown; stem?: unknown; formats?: unknown; drive_folder_id?: unknown; reference_docx_drive_id?: unknown; markdown_artifact_id?: unknown };
    let markdown = typeof i?.markdown === "string" ? i.markdown : "";
    let stem = typeof i?.stem === "string" ? i.stem.trim() : "";
    const driveFolderId = typeof i?.drive_folder_id === "string" ? i.drive_folder_id.trim() : "";
    const artId = typeof i?.markdown_artifact_id === "string" && i.markdown_artifact_id.trim() ? i.markdown_artifact_id.trim() : null;
    if (!driveFolderId) return fail("drive_folder_id is required (the Drive delivery folder).");
    if (!markdown.trim() && !artId) return fail("provide either markdown (inline) or markdown_artifact_id (the doc is fetched from the artifacts table). Neither was given.");

    // By-reference path: fetch the finished markdown from an artifact. A long document then never has to
    // transit a chat window — the author (e.g. a .ai Prime) files it as an artifact and hands over just the id.
    if (artId) {
      if (!/^[0-9a-f-]{8,36}$/i.test(artId)) return fail(`markdown_artifact_id must be an artifact UUID. Got: ${artId.slice(0, 40)}`);
      const art = await ctx.supabase.from("artifacts").select("id, title, content").eq("id", artId).maybeSingle();
      if (art.error) return fail(`artifact lookup failed: ${art.error.message}`);
      if (!art.data) return fail(`no artifact with id ${artId}.`);
      const content = (art.data as { content?: string | null }).content ?? "";
      if (!content.trim()) return fail(`artifact ${artId} has empty content — nothing to render.`);
      markdown = content;   // the fetched artifact is the render source
      if (!stem) {
        const title = ((art.data as { title?: string | null }).title ?? "").trim();
        stem = title ? title.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) : "";
      }
    }
    if (!stem) return fail("stem is required (or pass a markdown_artifact_id whose title can seed the filename stem).");

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
