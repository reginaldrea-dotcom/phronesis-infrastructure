// Env validation.
// REQUIRED: throw at startup if missing (worker cannot function).
// EXPECTED: warn at startup if missing; the per-provider env() call throws
// only when the relevant adapter is actually invoked.

import { EXPECTED_ENV, REQUIRED_ENV } from "./config.ts";

export function assertEnv(): void {
  const missingRequired: string[] = [];
  for (const name of REQUIRED_ENV) {
    if (!Deno.env.get(name)) missingRequired.push(name);
  }
  if (missingRequired.length > 0) {
    throw new Error(`theo-dispatch-worker missing required env: ${missingRequired.join(", ")}`);
  }

  const missingExpected: string[] = [];
  for (const name of EXPECTED_ENV) {
    if (!Deno.env.get(name)) missingExpected.push(name);
  }
  if (missingExpected.length > 0) {
    console.warn(`theo-dispatch-worker missing expected env (adapters will fail when called): ${missingExpected.join(", ")}`);
  }
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`env ${name} not set`);
  return v;
}
