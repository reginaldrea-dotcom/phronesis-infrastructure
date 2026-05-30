import type { Tool } from "./types.ts";

export const deliverArtefactTool: Tool = {
  definition: {
    name: "deliver_artefact",
    description: "Deliver content directly to the user's artefact panel. Use this for ALL large content delivery — database documents, code files, HTML. For DB content: provide a SQL query and the edge function fetches it directly. For content already in context (e.g. from GitHub): provide the content field directly. Never reproduce large content in your response text — use this tool instead.",
    input_schema: {
      type: "object",
      properties: {
        title:         { type: "string", description: "Filename or title for the artefact (e.g. 'super-t.md', 'argos.html')" },
        query:         { type: "string", description: "SQL query to fetch content from DB. First row's content_field is used." },
        content:       { type: "string", description: "Direct content to deliver (for content already in context, e.g. from GitHub MCP)" },
        content_field: { type: "string", description: "Field to extract from SQL result. Default: content" },
        type:          { type: "string", description: "Content type hint: html, markdown, typescript, document. Default: document" },
      },
      required: ["title"],
    },
  },
  summarize: (input) => `deliver_artefact: "${input?.title ?? ""}"`,
  run: async (input, { supabase, directArtefacts }) => {
    try {
      const { title, query, content, type = "document" } = input;
      const contentField: string = input.content_field ?? "content";
      let artefactContent: string | null = null;

      if (query) {
        const { data: sqlData, error: sqlError } = await supabase.rpc("execute_raw_sql", { query });
        if (sqlError) throw new Error(sqlError.message);
        const rows: any[] = Array.isArray(sqlData) ? sqlData : [];
        artefactContent = rows.length > 0 ? (rows[0][contentField] ?? null) : null;
      } else if (content) {
        artefactContent = content;
      }

      if (artefactContent) {
        directArtefacts.push({ title, content: artefactContent, type, version: 1 });
        return `Artefact delivered: "${title}" (${artefactContent.length} chars). It is now in the user's artefact panel — do not reproduce this content in your response.`;
      }
      return `No content found for artefact "${title}". Check query or content field.`;
    } catch (err) {
      return `Artefact delivery error: ${String(err)}`;
    }
  },
};
