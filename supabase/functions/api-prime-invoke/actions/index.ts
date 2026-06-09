// Action registry. Adding an action = new file + one line here.
// The entry point calls getAction(body.action); a miss falls through to the
// normal invoke (LLM) path, matching the original behaviour.

import type { Action, ActionContext } from "./types.ts";
import { holdThisAction } from "./holdThis.ts";
import { fileSuperTAction } from "./fileSuperT.ts";
import { verifyCut2Action } from "./verifyCut2.ts";
import { verifyCaptureAction } from "./verifyCapture.ts";
import { verifyGithubAction } from "./verifyGithub.ts";

const ACTIONS: Record<string, Action> = {
  [holdThisAction.name]: holdThisAction,
  [fileSuperTAction.name]: fileSuperTAction,
  [verifyCut2Action.name]: verifyCut2Action,
  [verifyCaptureAction.name]: verifyCaptureAction,
  [verifyGithubAction.name]: verifyGithubAction,
};

export function getAction(name: string): Action | undefined {
  return ACTIONS[name];
}

export type { ActionContext };
