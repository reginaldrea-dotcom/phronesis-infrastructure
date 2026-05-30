import type { Tool } from "./types.ts";
import { GITHUB_OWNER, GITHUB_REPO, githubHeaders } from "../lib/github.ts";

export const readGithubFileTool: Tool = {
  definition: {
    name: "read_github_file",
    description: "Read a file from the Phronesis GitHub repository. Returns the file content as a string. Path is relative to repository root.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path within the repository (e.g. 'navigator/primes/argos-config.js')" },
      },
      required: ["path"],
    },
  },
  summarize: (input) => `read_github_file: ${input?.path ?? ""}`,
  run: async (input) => {
    try {
      const filePath = String(input.path ?? "").replace(/^\//, "");
      const ghRes = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
        { headers: githubHeaders() }
      );
      if (!ghRes.ok) {
        const errText = await ghRes.text();
        return `GitHub error ${ghRes.status}: ${errText}`;
      }
      const fileData = await ghRes.json();
      return atob((fileData.content as string).replace(/\n/g, ""));
    } catch (err) {
      return `read_github_file error: ${String(err)}`;
    }
  },
};

export const writeGithubFileTool: Tool = {
  definition: {
    name: "write_github_file",
    description: "Write or update a file in the Phronesis GitHub repository. REQUIRES explicit Reg authorisation per PI before each use. Scoped to prompts/ directory only unless explicitly authorised otherwise.",
    input_schema: {
      type: "object",
      properties: {
        path:    { type: "string", description: "File path within the repository" },
        content: { type: "string", description: "Full file content to write" },
        message: { type: "string", description: "Commit message" },
      },
      required: ["path", "content", "message"],
    },
  },
  summarize: (input) => `write_github_file: ${input?.path ?? ""}`,
  run: async (input) => {
    try {
      const filePath = String(input.path ?? "").replace(/^\//, "");
      const shaRes = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
        { headers: githubHeaders() }
      );
      const sha: string | undefined = shaRes.ok ? ((await shaRes.json()).sha as string) : undefined;
      const writeRes = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
        {
          method: "PUT",
          headers: { ...githubHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            message: input.message,
            content: btoa(unescape(encodeURIComponent(input.content))),
            ...(sha ? { sha } : {}),
          }),
        }
      );
      if (!writeRes.ok) {
        const errText = await writeRes.text();
        return `GitHub write error ${writeRes.status}: ${errText}`;
      }
      const writeData = await writeRes.json();
      return `File written: ${filePath} — commit ${(writeData.commit?.sha as string)?.slice(0, 7) ?? "unknown"}`;
    } catch (err) {
      return `write_github_file error: ${String(err)}`;
    }
  },
};

export const listGithubDirectoryTool: Tool = {
  definition: {
    name: "list_github_directory",
    description: "List files and directories at a path in the Phronesis GitHub repository.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path within the repository. Use empty string for root." },
      },
      required: ["path"],
    },
  },
  summarize: (input) => `list_github_directory: ${input?.path ?? ""}`,
  run: async (input) => {
    try {
      const dirPath = String(input.path ?? "").replace(/^\//, "");
      const ghRes = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${dirPath}`,
        { headers: githubHeaders() }
      );
      if (!ghRes.ok) {
        const errText = await ghRes.text();
        return `GitHub error ${ghRes.status}: ${errText}`;
      }
      const dirData = await ghRes.json();
      const items: any[] = Array.isArray(dirData) ? dirData : [dirData];
      const listing = items
        .map((item: any) => `${item.type === "dir" ? "dir " : "file"} ${item.name}  ${item.path}`)
        .join("\n");
      return listing || "(empty directory)";
    } catch (err) {
      return `list_github_directory error: ${String(err)}`;
    }
  },
};
