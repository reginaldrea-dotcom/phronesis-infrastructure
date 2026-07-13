// Env validation (mirror of theo-dispatch-worker/lib/env.ts).

import { EXPECTED_ENV, REQUIRED_ENV } from "./config.ts";

export function assertEnv(): void {
  const missing: string[] = [];
  for (const name of REQUIRED_ENV) {
    if (!Deno.env.get(name)) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`grounding-worker missing required env: ${missing.join(", ")}`);
  }
  const missingExpected: string[] = [];
  for (const name of EXPECTED_ENV) {
    if (!Deno.env.get(name)) missingExpected.push(name);
  }
  if (missingExpected.length > 0) {
    console.warn(`grounding-worker missing expected env: ${missingExpected.join(", ")}`);
  }
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`env ${name} not set`);
  return v;
}
