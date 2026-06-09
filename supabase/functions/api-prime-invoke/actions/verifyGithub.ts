// api-prime-invoke | action verify_github | GITHUB_TOKEN health check | 9 Jun 2026
//
// Zero-Prime-impact check that the GITHUB_TOKEN secret is valid + correctly scoped — run it
// after every token renewal (these expire on a cycle). Like verify_cut2/verify_capture, an action
// short-circuits before the wake path: no Prime session, no deltas, no Super-T.
//
// Probes both scopes the github tools rely on:
//   READ   — GET the repo''s contents root (Contents: Read)
//   WRITE  — preflight the repo metadata for push permission (Contents: Write) WITHOUT committing,
//            by reading the authenticated permissions on the repo. No file is written.
// Reports ok + the specific scope that failed, with the GitHub status — never the token itself.

import type { Action } from "./types.ts";
import { corsHeaders } from "../lib/http.ts";
import { GITHUB_OWNER, GITHUB_REPO, githubHeaders } from "../lib/github.ts";

export const verifyGithubAction: Action = {
  name: "verify_github",
  handle: async ({ body }) => {
    if (!Deno.env.get("GITHUB_TOKEN")) {
      return new Response(
        JSON.stringify({ ok: false, reason: "GITHUB_TOKEN secret is not set in the EF environment." }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    // Default to a file that reliably EXISTS at the repo root (CLAUDE.md), so a 404 means a real
    // read-scope problem, not a missing-file false negative. Override with body.path if needed.
    const path = typeof body?.path === "string" && body.path.trim() ? body.path.trim() : "CLAUDE.md";
    const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
    try {
      // READ probe — a real contents read, the same call read_github_file makes.
      const readRes = await fetch(`${base}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, { headers: githubHeaders() });
      const readOk = readRes.ok;

      // WRITE-scope probe — read the repo''s granted permissions (no commit). The repo object
      // returns a `permissions` block reflecting what THIS token may do; push:true => Contents:Write.
      const repoRes = await fetch(base, { headers: githubHeaders() });
      let canPush: boolean | null = null;
      let repoStatus = repoRes.status;
      if (repoRes.ok) {
        const repo = await repoRes.json();
        canPush = !!(repo?.permissions?.push);
      }

      return new Response(
        JSON.stringify({
          ok: readOk && canPush === true,
          repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
          read: { ok: readOk, status: readRes.status, path },
          write: { push_permission: canPush, repo_status: repoStatus },
          note: readOk && canPush === true
            ? "GITHUB_TOKEN is valid and has Contents read+write — the github tools will work."
            : "Token issue — see read.status / write.push_permission. 401/403 = token invalid or wrong scope; push_permission false = renewal dropped Contents:Write.",
        }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  },
};
