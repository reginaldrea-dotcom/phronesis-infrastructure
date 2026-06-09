// api-prime-invoke | sandbox_worker | B1 (conf 1151109e, MR fdc37ee8) | 7 Jun 2026
//
// Runs INSIDE a Deno Worker spawned with `deno: { permissions: "none" }` — PURE COMPUTE:
// no net, no Deno.env, no filesystem, no parent context (Aegis PQ1 ruling). The Prime's
// script has exactly ONE affordance: call(tool, input). Every effect leaves this Worker
// as a postMessage to the parent EF, which executes the binding under the Prime's scoped
// identity, writes the execution-ledger row in the gap this Worker cannot see, and posts
// the result back. OPACITY DURING execution is structural here: the script has no handle
// to the ledger, the DB, or the network — it can only ask the parent to act and wait.

interface Pending { resolve: (v: unknown) => void; reject: (e: unknown) => void; }

const pending = new Map<number, Pending>();
let nextId = 1;

// The script's sole affordance. Posts a tool_call to the parent and resolves when the
// parent posts back the matching tool_result. The script cannot bypass this — there is
// no other route to an effect from inside a no-permissions Worker.
function call(tool: string, input: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    (self as unknown as Worker).postMessage({ type: "tool_call", id, tool, input });
  });
}

// Diagnostic breadcrumb — surfaced to the Prime in the run result, never a side effect.
function log(message: unknown): void {
  (self as unknown as Worker).postMessage({ type: "log", message: String(message) });
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg?.type === "tool_result") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "tool call failed"));
    return;
  }

  if (msg?.type === "run") {
    try {
      // Compile the Prime's script as an async function body with call()/log() in scope.
      // eval/Function are language features, not permissions — allowed in a no-permission
      // Worker, and harmless: the only effectful binding handed in is call(), which is
      // itself mediated by the parent.
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
        new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
      const fn = new AsyncFunction("call", "log", msg.script);
      const returnValue = await fn(call, log);
      (self as unknown as Worker).postMessage({ type: "done", returnValue });
    } catch (err) {
      (self as unknown as Worker).postMessage({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
