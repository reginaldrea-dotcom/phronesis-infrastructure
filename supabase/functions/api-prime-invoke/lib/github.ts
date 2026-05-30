// GitHub repo config and auth headers for the github_* tools.

export const GITHUB_OWNER = "reginaldrea-dotcom";
export const GITHUB_REPO  = "phronesis-infrastructure";

export function githubHeaders(): Record<string, string> {
  return {
    Authorization: `token ${Deno.env.get("GITHUB_TOKEN")}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "phronesis-argos",
  };
}
