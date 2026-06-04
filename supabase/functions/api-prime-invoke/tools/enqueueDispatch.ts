// enqueue_dispatch — Theo's tool for handing a research dispatch to the worker.
//
// Theo composes the refinement (questions × engine assignments + research intent)
// then calls this tool to:
//   1. Create theo_session (state='dispatched')
//   2. Create engine_dispatch rows (status='pending', one per question)
//   3. File a start-of-job wake_delta (ref_type='theo_session', ref_id=session_id)
// The worker drains pending rows on its next tick. A completion wake_delta
// arrives when all engines reach terminal status.
//
// Caller must have a userId in ToolContext (the JWT sub = auth_user_id, extracted
// in index.ts). conversation.user_id and theo_session.user_id FK to app_user.id,
// NOT auth_user_id, so this resolves app_user.id first. Caller must also have a
// matching open `conversation` row. Phase 1 errors if no open conversation exists.

import type { Tool, ToolContext } from "./types.ts";

// Mirror of theo-dispatch-worker/lib/config.ts ENGINES keys. Kept hardcoded here
// (tool and worker are different EFs; can't import). When adding an engine to
// the worker's registry, mirror it here.
const VALID_ENGINES = new Set([
  "perplexity-sonar-deep-research",
  "perplexity-sonar-pro",
  "perplexity-sonar-reasoning-pro",
  "gemini-deep-research",
  "gemini-3-1-pro",
  "gemini-2-5-pro",
  "openai-o3-deep-research",
  "openai-o4-mini-deep-research",
  "openai-gpt-5-search",
  "openai-gpt-4o-search",
  "anthropic-claude-opus-4-8",
  "anthropic-claude-sonnet-4-6",
]);

const VALID_ROLES = new Set(["deep_source", "deep_research", "current_web", "synthesist"]);

interface QuestionInput {
  prompt?: unknown;
  engine_name?: unknown;
  role?: unknown;
  role_description?: unknown;
}

interface EnqueueInput {
  original_brief?: unknown;
  refined_prompt?: unknown;
  engine_selection_rationale?: unknown;
  anonymisation_mode?: unknown;
  entity_verification_note?: unknown;
  questions?: unknown;
}

function fail(msg: string): string {
  return `enqueue_dispatch error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

export const enqueueDispatchTool: Tool = {
  definition: {
    name: "enqueue_dispatch",
    description:
      "Hand a composed research dispatch to the async worker. Use AFTER you have refined the brief and decided which engines will handle which questions — this writes the theo_session + engine_dispatch rows the worker drains, and files a start-of-job wake_delta. The worker fires the engines past the 150s wall and files a completion wake_delta when done. Required: original_brief, refined_prompt, engine_selection_rationale, questions[] (each with prompt, engine_name, role). " +
      "Valid engine_name values: perplexity-sonar-deep-research, perplexity-sonar-pro, perplexity-sonar-reasoning-pro, gemini-deep-research, gemini-3-1-pro, gemini-2-5-pro, openai-o3-deep-research, openai-o4-mini-deep-research, openai-gpt-5-search, openai-gpt-4o-search, anthropic-claude-opus-4-8, anthropic-claude-sonnet-4-6. " +
      "Valid role values: deep_source, deep_research, current_web, synthesist.",
    input_schema: {
      type: "object",
      properties: {
        original_brief: { type: "string", description: "The user's brief — the original ask, captured verbatim." },
        refined_prompt: { type: "string", description: "Your refinement: the question beneath the question, in one sentence a stranger would understand." },
        engine_selection_rationale: { type: "string", description: "Brief paragraph explaining why each engine was assigned to its question(s). Worker stores this in theo_session.engine_selection_rationale." },
        anonymisation_mode: { type: "string", description: "Optional: anonymisation applied to the prompts (e.g. 'none', 'pseudonymised', 'generalised')." },
        entity_verification_note: { type: "string", description: "Optional: note on entity verification done before dispatch." },
        questions: {
          type: "array",
          minItems: 1,
          description: "One row per question × engine assignment. The same question may appear multiple times under different engines if you want cross-engine divergence.",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "The fully-rendered prompt to send to this engine for this question. Already includes any vendor-data labels, source caveats, etc." },
              engine_name: { type: "string", description: "Canonical engine name. See tool description for valid values." },
              role: { type: "string", enum: ["deep_source", "deep_research", "current_web", "synthesist"], description: "Semantic role this engine plays for this question." },
              role_description: { type: "string", description: "Optional free-form clarification of the role for this specific question." },
            },
            required: ["prompt", "engine_name", "role"],
          },
        },
      },
      required: ["original_brief", "refined_prompt", "engine_selection_rationale", "questions"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const n = Array.isArray((input as EnqueueInput)?.questions) ? (input as { questions: unknown[] }).questions.length : 0;
    return `enqueue_dispatch: ${n} question/engine row(s)`;
  },

  run: async (input: EnqueueInput, ctx: ToolContext) => {
    if (!ctx.userId) return fail("no userId on ToolContext — caller must be authenticated. This call has no end-user identity to attach.");

    // Validate inputs ─────────────────────────────────────────────────────
    const originalBrief = typeof input?.original_brief === "string" ? input.original_brief.trim() : "";
    const refinedPrompt = typeof input?.refined_prompt === "string" ? input.refined_prompt.trim() : "";
    const rationale = typeof input?.engine_selection_rationale === "string" ? input.engine_selection_rationale.trim() : "";
    if (!originalBrief) return fail("original_brief is required (non-empty string).");
    if (!refinedPrompt) return fail("refined_prompt is required (non-empty string).");
    if (!rationale) return fail("engine_selection_rationale is required (non-empty string).");
    if (!Array.isArray(input?.questions) || input.questions.length === 0) return fail("questions must be a non-empty array.");

    const questions = input.questions as QuestionInput[];
    const rows: Array<{ prompt: string; engine_name: string; role: string; role_description: string | null }> = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const prompt = typeof q?.prompt === "string" ? q.prompt.trim() : "";
      const engine = typeof q?.engine_name === "string" ? q.engine_name.trim() : "";
      const role = typeof q?.role === "string" ? q.role.trim() : "";
      const roleDesc = typeof q?.role_description === "string" ? q.role_description : null;
      if (!prompt) return fail(`questions[${i}].prompt is required.`);
      if (!engine) return fail(`questions[${i}].engine_name is required.`);
      if (!VALID_ENGINES.has(engine)) return fail(`questions[${i}].engine_name is not a recognised engine: '${engine}'. See tool description for valid values.`);
      if (!role) return fail(`questions[${i}].role is required.`);
      if (!VALID_ROLES.has(role)) return fail(`questions[${i}].role is not valid: '${role}'. Use deep_source, deep_research, current_web, or synthesist.`);
      rows.push({ prompt, engine_name: engine, role, role_description: roleDesc });
    }

    // Resolve app_user.id ─────────────────────────────────────────────────
    // ctx.userId is the JWT sub = auth_user_id. conversation.user_id and
    // theo_session.user_id FK to app_user.id, not auth_user_id — resolve it here
    // (the known enqueue_dispatch user-id bug). rate_limit_usage legitimately
    // keys on auth_user_id, so ctx.userId is left untouched elsewhere.
    const appUser = await ctx.supabase
      .from("app_user")
      .select("id")
      .eq("auth_user_id", ctx.userId)
      .maybeSingle();
    if (appUser.error) return fail(`app_user lookup failed: ${appUser.error.message}`);
    if (!appUser.data?.id) return fail(`no app_user profile for the authenticated user (auth_user_id ${ctx.userId}); cannot attach the dispatch.`);
    const appUserId = appUser.data.id as string;

    // Find caller's open conversation ─────────────────────────────────────
    const convo = await ctx.supabase
      .from("conversation")
      .select("id")
      .eq("user_id", appUserId)
      .eq("status", "open")
      .order("last_active_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (convo.error) return fail(`conversation lookup failed: ${convo.error.message}`);
    if (!convo.data?.id) return fail("no open conversation found for this user; cannot enqueue. Interface must create the conversation row before dispatch.");
    const conversationId = convo.data.id as string;

    // Create theo_session ────────────────────────────────────────────────
    const sessionInsert = await ctx.supabase
      .from("theo_session")
      .insert({
        conversation_id: conversationId,
        user_id: appUserId,
        state: "dispatched",
        original_brief: originalBrief,
        refined_prompt: refinedPrompt,
        refined_prompt_user_confirmed_at: new Date().toISOString(),
        engine_selection_rationale: rationale,
        anonymisation_mode: typeof input.anonymisation_mode === "string" ? input.anonymisation_mode : null,
        entity_verification_note: typeof input.entity_verification_note === "string" ? input.entity_verification_note : null,
      })
      .select("id")
      .single();
    if (sessionInsert.error) return fail(`theo_session insert failed: ${sessionInsert.error.message}`);
    const theoSessionId = sessionInsert.data.id as string;

    // Create engine_dispatch rows ────────────────────────────────────────
    const dispatchInsert = await ctx.supabase
      .from("engine_dispatch")
      .insert(rows.map(r => ({
        theo_session_id: theoSessionId,
        engine_name: r.engine_name,
        role_in_dispatch: r.role,
        role_description: r.role_description,
        prompt_sent: r.prompt,
        status: "pending",
      })))
      .select("id, engine_name, role_in_dispatch");
    if (dispatchInsert.error) {
      // Best-effort rollback: delete the theo_session we just created so the
      // worker doesn't pick up an empty session.
      await ctx.supabase.from("theo_session").delete().eq("id", theoSessionId);
      return fail(`engine_dispatch insert failed (theo_session rolled back): ${dispatchInsert.error.message}`);
    }
    const dispatchRows = dispatchInsert.data ?? [];

    // Start-of-job wake_delta ────────────────────────────────────────────
    // Filed to the caller's own lineage as an in-flight audit marker. Persists
    // until consumed; visible in read_wake_deltas / Reg's audit queries.
    await ctx.supabase.from("wake_deltas").insert({
      to_lineage: ctx.lineageName,
      from_lineage: ctx.lineageName,
      note: `dispatch started: ${dispatchRows.length} engines pending — session ${theoSessionId}`,
      ref_type: "theo_session",
      ref_id: theoSessionId,
    });

    return JSON.stringify({
      theo_session_id: theoSessionId,
      conversation_id: conversationId,
      engine_dispatch_ids: dispatchRows.map(r => r.id),
      queued: dispatchRows.length,
      "[SYSTEM]": "dispatch enqueued — the worker will fire engines on its next tick (cron ~30s once enabled; manual invoke for now). A completion wake_delta will arrive when all engines reach terminal status. Read results with read_dispatch_results.",
    });
  },
};
