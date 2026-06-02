// Fail-fast env validation. Imported once at EF startup.

import { REQUIRED_ENV } from "./config.ts";

export function assertEnv(): void {
  const missing: string[] = [];
  for (const name of REQUIRED_ENV) {
    if (!Deno.env.get(name)) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`theo-dispatch-worker missing env: ${missing.join(", ")}`);
  }
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`env ${name} not set`);
  return v;
}
