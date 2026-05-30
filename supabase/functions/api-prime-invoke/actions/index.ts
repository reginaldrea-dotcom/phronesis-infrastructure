// Action registry. Adding an action = new file + one line here.
// The entry point calls getAction(body.action); a miss falls through to the
// normal invoke (LLM) path, matching the original behaviour.

import type { Action, ActionContext } from "./types.ts";
import { holdThisAction } from "./holdThis.ts";
import { fileSuperTAction } from "./fileSuperT.ts";

const ACTIONS: Record<string, Action> = {
  [holdThisAction.name]: holdThisAction,
  [fileSuperTAction.name]: fileSuperTAction,
};

export function getAction(name: string): Action | undefined {
  return ACTIONS[name];
}

export type { ActionContext };
