// api-prime-invoke | sandbox | B1 (conf 1151109e, MR fdc37ee8) | 7 Jun 2026
//
// Parent-side runner for a Prime-authored script. Spawns the sandbox Worker
// (deny-by-default, pure compute — see sandbox_worker.ts), then mediates every
// tool_call the script makes: the Worker can only ASK, the parent ACTS. Each
// request is run through `onToolCall` (which executes the binding under the
// Prime's scoped identity AND writes the ledger row — supplied by the caller),
// and the result is posted back. The script is blind to that ledger write by
// construction; transparency comes AFTER, via read_execution_ledger (Theo's R2).
//
// Guards that fall out here, not in the script: a wall-clock timeout (Worker is
// terminated on expiry — a runaway loop cannot hang the EF) and a per-run
// tool-call budget (a script cannot fan out unboundedly past the $50/day guard).

export interface SandboxRunResult {
  ok: boolean;
  returnValue?: unknown;   // the script's resolved value (whatever it returned)
  error?: string;          // set when ok=false (throw inside script, timeout, or worker fault)
  logs: string[];          // log() breadcrumbs, in order
  callCount: number;       // tool calls actually dispatched this run
}

export interface SandboxOptions {
  // Execute one binding the script asked for. The caller does the scoped-identity
  // execution AND the ledger write inside this callback — the sandbox never touches
  // the DB itself. Returns the tool's result string (ok) or an error to surface to
  // the script. Must not throw for ordinary tool errors; a throw is treated as a fault.
  onToolCall: (tool: string, input: unknown) => Promise<{ ok: boolean; result?: string; error?: string }>;
  timeoutMs?: number; // wall-clock cap; Worker terminated on expiry. Default 30s.
  maxCalls?: number;  // hard cap on tool calls per run. Default 50.
}

const DEFAULT_TIMEOUT_MS = 30_000; // well under the EF's ~150s 504 ceiling
const DEFAULT_MAX_CALLS = 50;

export function runScriptInSandbox(script: string, opts: SandboxOptions): Promise<SandboxRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  const logs: string[] = [];
  let callCount = 0;

  return new Promise<SandboxRunResult>((resolve) => {
    let settled = false;

    // permissions: "none" → no net / env / fs / read / write / run. The cast is
    // because the lib.dom WorkerOptions type has no `deno` field; the Deno runtime reads it.
    const worker = new Worker(
      new URL("./sandbox_worker.ts", import.meta.url).href,
      { type: "module", deno: { permissions: "none" } } as unknown as WorkerOptions,
    );

    const finish = (r: SandboxRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* already gone */ }
      resolve(r);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: `script exceeded ${timeoutMs}ms wall-clock limit`, logs, callCount }),
      timeoutMs,
    );

    worker.onmessage = async (e: MessageEvent) => {
      const msg = e.data;

      if (msg?.type === "log") { logs.push(String(msg.message)); return; }

      if (msg?.type === "tool_call") {
        if (++callCount > maxCalls) {
          worker.postMessage({ type: "tool_result", id: msg.id, ok: false, error: `tool-call budget exhausted (${maxCalls} per run)` });
          return;
        }
        try {
          const out = await opts.onToolCall(String(msg.tool), msg.input);
          worker.postMessage({ type: "tool_result", id: msg.id, ok: out.ok, result: out.result, error: out.error });
        } catch (err) {
          // A throw from the executor is a harness fault, not a tool error — surface it
          // to the script as a failed call rather than wedging the run.
          worker.postMessage({ type: "tool_result", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (msg?.type === "done") { finish({ ok: true, returnValue: msg.returnValue, logs, callCount }); return; }
      if (msg?.type === "error") { finish({ ok: false, error: String(msg.error ?? "script error"), logs, callCount }); return; }
    };

    worker.onerror = (e) => finish({ ok: false, error: `worker fault: ${(e as ErrorEvent).message ?? "unknown"}`, logs, callCount });

    worker.postMessage({ type: "run", script });
  });
}
