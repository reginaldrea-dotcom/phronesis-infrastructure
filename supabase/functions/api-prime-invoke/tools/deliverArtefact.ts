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
        // Delivery confirmation, not a durable handle: this goes to the in-memory
        // artefact panel, not a table, so the ground truth available is the title
        // and the byte count actually delivered.
        return `Artefact delivered: "${title}" (${artefactContent.length} chars). It is now in the user's artefact panel — do not reproduce this content in your response.\n[SYSTEM: delivered. This is the authoritative confirmation; do not re-deliver.]`;
      }
      // Explicit failure — previously a soft string that read like a normal return,
      // so a Prime could believe it delivered when it delivered nothing.
      return `deliver_artefact: NO content found for "${title}" — nothing was delivered.${query ? " The SQL query returned no row, or the content_field was empty/misnamed." : " The content field was empty."}\n[SYSTEM: this is a FAILURE, not a delivery. Do not tell Reg the artefact was delivered. Fix the query/content_field or report the gap.]`;
    } catch (err) {
      return `deliver_artefact error: ${String(err)}\n[SYSTEM: this is a FAILURE — nothing was delivered. Surface to Reg, do not retry blindly.]`;
    }
  },
};
