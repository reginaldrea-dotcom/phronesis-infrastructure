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
import { setCaptureTarget } from "../lib/captureTarget.ts";

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
  "openai-o3-deep-research",        // OpenAI deep_research — now gpt-5.5 @ 1M TPM (Reg 16 Jun); the model field in
                                    // the worker config is authoritative. (openai-o4-mini-deep-research RETIRED: gpt-5.4 base not on the project.)
  "openai-gpt-5-search",
  "openai-gpt-4o-search",
  "anthropic-claude-opus-4-8",
  "anthropic-claude-sonnet-4-6",
]);

const VALID_ROLES = new Set(["deep_source", "deep_research", "current_web", "synthesist"]);

// Aegis ruling e5cd623f (Q4): autonomous dispatch — a Prime starting a real job with no human in
// the conversation — is higher-trust than a human-in-the-loop dispatch, so it is NOT open to any
// provisioned lineage. Restricted to a NAMED SET; others added only by explicit future ruling.
const AUTONOMOUS_DISPATCH_LINEAGES = new Set(["angelia", "theophrastus"]);

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
      "Valid engine_name values: perplexity-sonar-deep-research, perplexity-sonar-pro, perplexity-sonar-reasoning-pro, gemini-deep-research, gemini-3-1-pro, gemini-2-5-pro, openai-o3-deep-research, openai-gpt-5-search, openai-gpt-4o-search, anthropic-claude-opus-4-8, anthropic-claude-sonnet-4-6. " +
      "The deep_research role is served by Perplexity (perplexity-sonar-deep-research), Gemini (gemini-deep-research), and OpenAI (openai-o3-deep-research, now gpt-5.5 @ 1M TPM). Search role (openai-gpt-5-search) runs gpt-5.4-mini + Responses-API web_search (2M TPM), not the 45k-capped gpt-5-search-api. " +
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
              prompt: { type: "string", description: "The fully-rendered prompt to send to this engine for this question. Already includes any vendor-data labels, source caveats, etc. For a deep_research engine, FRAME IT AS A RESEARCH TASK and explicitly ask the engine to cite its sources with URLs (e.g. 'research X using current web sources and cite every figure with its source URL'). A prompt that hands the engine the facts and asks it to 'organise/describe' them yields an answer with web searches run but ZERO citations surfaced (A1b 4c1b7fb9: dispatch 586dc5a7 ran 10 searches, returned 0 citations; the same engine returned 16 when the prompt asked for sources) — and the A1a zero-source guard then correctly holds it as ungrounded/partial." },
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
    // Identity is resolved AFTER validation, dual-path: an end-user JWT resolves to their
    // app_user (the human-mediated path); NO end-user (an autonomous API researcher such as
    // Angelia, woken with no browser user) resolves to the designated autonomous-research
    // service identity. See the resolution block below — an autonomous Prime is no longer
    // blocked at the door for lacking a human in the loop.

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

    // Resolve the owning app_user.id (dual-path) ─────────────────────────
    // theo_session.user_id + conversation_id are NOT NULL, so every dispatch must attach to a
    // real app_user + conversation. Two ways in:
    //  (A) END-USER: ctx.userId is the JWT sub = auth_user_id; resolve their app_user.id
    //      (conversation/theo_session FK to app_user.id, not auth_user_id — the user-id bug fix).
    //  (B) AUTONOMOUS: no end-user JWT (an autonomous API researcher, e.g. Angelia). The dispatch
    //      is owned by the designated AUTONOMOUS-RESEARCH SERVICE IDENTITY — a non-auth app_user
    //      (auth_user_id NULL) marked role_context='autonomous_research', with a standing open
    //      conversation. INTERNAL/org scope only; client-scoped autonomous research stays gated on
    //      Aegis Phase 0. The service identity must be provisioned (Aegis-ruled, Connie-cut) — if
    //      absent we fail LOUDLY (no silent stall, no stray ownership).
    let appUserId: string;
    if (ctx.userId) {
      const appUser = await ctx.supabase
        .from("app_user").select("id").eq("auth_user_id", ctx.userId).maybeSingle();
      if (appUser.error) return fail(`app_user lookup failed: ${appUser.error.message}`);
      if (!appUser.data?.id) return fail(`no app_user profile for the authenticated user (auth_user_id ${ctx.userId}); cannot attach the dispatch.`);
      appUserId = appUser.data.id as string;
    } else {
      // Aegis ruling e5cd623f (Q4): the autonomous path is restricted to the named set — fail loud
      // for any other lineage (a dispatch with no human in the loop needs an approved researcher).
      if (!AUTONOMOUS_DISPATCH_LINEAGES.has(ctx.lineageName)) {
        return fail(`lineage '${ctx.lineageName}' is not approved for autonomous dispatch (approved set: angelia, theophrastus — Aegis ruling e5cd623f). A dispatch without an end-user requires an approved autonomous-research lineage.`);
      }
      const svc = await ctx.supabase
        .from("app_user").select("id").eq("role_context", "autonomous_research").maybeSingle();
      if (svc.error) return fail(`autonomous-research identity lookup failed (role_context='autonomous_research'): ${svc.error.message}`);
      if (!svc.data?.id) return fail("no end-user on this call and no autonomous-research identity is provisioned (app_user role_context='autonomous_research' + a standing open conversation). An autonomous researcher cannot dispatch until that identity exists — Aegis-ruled, Connie to cut.");
      appUserId = svc.data.id as string;
    }

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
        // created_by_lineage attributes the session to the composing Prime (the autonomous-research
        // app_user is SHARED across API-Primes, so user_id cannot disambiguate). Drives the wake
        // capture-landing (loadOrientation) so a re-invoked Prime sees ITS OWN open captures. (572e0a63)
        created_by_lineage: ctx.lineageName,
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

    // Auto-declare this fresh capture session as the run's write-target if none declared yet
    // (a90e1410 inst 3, Connie 6d3fab47): the common create-then-capture flow is guarded without an
    // explicit declare_capture_target call. onlyIfAbsent so an explicit prior declaration (e.g. an
    // arc-read run that adopted the arc) is never overridden. Best-effort — never breaks the dispatch.
    if (ctx.sessionId) {
      const dec = await setCaptureTarget(ctx.supabase, ctx.sessionId, theoSessionId, ctx.lineageName,
        { onlyIfAbsent: true, note: "auto: created via enqueue_dispatch" });
      if ("err" in dec) console.error("auto-declare capture target failed (6d3fab47):", dec.err);
    }

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
      state: "dispatched",
      // Echo the full rows (not just ids) so you can verify the ASSIGNMENT landed
      // as intended — which engine got which role — not merely that N rows exist.
      engine_dispatch: dispatchRows.map(r => ({ id: r.id, engine_name: r.engine_name, role: r.role_in_dispatch })),
      queued: dispatchRows.length,
      "[SYSTEM]": "dispatch enqueued — the worker will fire engines on its next tick (cron ~30s once enabled; manual invoke for now). The engine_dispatch list above is the authoritative record of what was queued: check the engine/role assignment matches your intent. A completion wake_delta will arrive when all engines reach terminal status. Read results with read_dispatch_results.",
    });
  },
};
