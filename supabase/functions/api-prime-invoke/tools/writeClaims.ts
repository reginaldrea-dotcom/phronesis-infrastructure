// write_claims — write-path v2: land the authored CLAIM LAYER for a session's
// synthesis (Conf 089858ad D5, MR 1ad5b49e). Separate from commit_synthesis by
// design: claims are authored in their own deliberate step, so the commit stays
// atomic and the claim layer can be re-authored without re-committing.
//
// Writes four organs from the synthesist's authored structure:
//   research_question  — the navigation spine + the gap's home
//   synthesis_claim    — load-bearing claims (NOT every sentence)
//   claim_source       — claim → engine_dispatch provenance (drives descend-to-raw)
//   claim_citation     — the truth layer: the independently-verifiable source,
//                        resolution defaults 'unchecked' (claimed-until-checked)
//
// GUARD — provenance integrity (the forgery floor applied to claims): every
// claim_source / claim_citation must carry a REAL dispatch_id for THIS session.
// Callers pass dispatch_id directly, or an engine_name that resolves to exactly
// ONE dispatch; an engine that ran for multiple questions is ambiguous and MUST
// be given by dispatch_id. A claim can never be sourced to an engine that did
// not run. Enums are validated; bad values fail clearly rather than coercing.
//
// Authored at synthesis time, never derived from prose at render time. The render
// views (render_claim_v1) read these rows; the render is a SELECT, not a story.
//
// pass replace=true to re-author cleanly: existing questions + claims for the
// session/synthesis are deleted first (claim_source/claim_citation cascade).
//
// Parameterised writes via the service-role client (the v2 organs are RLS-sealed
// deny-all, like the synthesis family).

import type { Tool, ToolContext } from "./types.ts";

const ID_RE = /^[0-9a-f-]{4,36}$/i;
const CLAIM_STATUS = new Set(["convergent", "divergent", "single_source", "synthesis_inference", "gap"]);
const DIVERGENCE_STATUS = new Set(["open", "resolved"]);
const STANCE = new Set(["supports", "diverges"]);
const Q_STATUS = new Set(["open", "answered", "gap", "withdrawn"]);

function fail(msg: string): string {
  return `write_claims error: ${msg}\n[SYSTEM: surface to Reg, do not retry.]`;
}

interface SourceIn { dispatch_id?: unknown; engine_name?: unknown; stance?: unknown; }
interface CitationIn { dispatch_id?: unknown; engine_name?: unknown; url?: unknown; title?: unknown; source_date?: unknown; note?: unknown; }
interface ClaimIn {
  claim_text?: unknown; claim_status?: unknown; scope?: unknown;
  divergence_status?: unknown; resolution_note?: unknown;
  question_index?: unknown; section_index?: unknown;
  sources?: unknown; citations?: unknown;
}
interface QuestionIn { question_index?: unknown; question_text?: unknown; status?: unknown; }

export const writeClaimsTool: Tool = {
  definition: {
    name: "write_claims",
    description:
      "Write the authored claim layer for a theo_session's synthesis: research_question rows (the navigation spine), synthesis_claim rows (load-bearing claims, not every sentence), claim_source (claim→engine provenance) and claim_citation (the independently-verifiable source; resolution defaults 'unchecked'). Author this AFTER the synthesis exists (write_synthesis_section). Every source/citation must carry a real dispatch_id for this session — pass dispatch_id, or an engine_name that resolves to exactly one dispatch (ambiguous engines must use dispatch_id). claim_status: convergent/divergent/single_source/synthesis_inference/gap. stance: supports/diverges. Pass replace=true to re-author cleanly (deletes existing questions+claims first).",
    input_schema: {
      type: "object",
      properties: {
        theo_session_id: { type: "string", description: "Session id — full UUID or a leading hex prefix." },
        replace: { type: "boolean", description: "If true, delete existing research_question + synthesis_claim (sources/citations cascade) for this session/synthesis before writing. Default false (append)." },
        questions: {
          type: "array",
          description: "research_question rows — the navigation spine and the home of gaps.",
          items: {
            type: "object",
            properties: {
              question_index: { type: "integer", description: "0-based position; unique per session." },
              question_text: { type: "string" },
              status: { type: "string", enum: ["open", "answered", "gap", "withdrawn"], description: "Default 'answered'." },
            },
            required: ["question_index", "question_text"],
          },
        },
        claims: {
          type: "array",
          minItems: 1,
          description: "The load-bearing claims.",
          items: {
            type: "object",
            properties: {
              claim_text: { type: "string" },
              claim_status: { type: "string", enum: ["convergent", "divergent", "single_source", "synthesis_inference", "gap"] },
              scope: { type: "string", description: "Convergence texture, e.g. multi-source-within-engine, cross-engine-complementary." },
              divergence_status: { type: "string", enum: ["open", "resolved"], description: "For divergent claims: is the disagreement resolved?" },
              resolution_note: { type: "string", description: "How a divergence was resolved (or why it stays open)." },
              question_index: { type: "integer", description: "Link to a question in this call's questions[] (or an existing research_question)." },
              section_index: { type: "integer", description: "Link to an existing synthesis_section by its section_index." },
              sources: {
                type: "array",
                description: "Provenance: which engine returns support/diverge on this claim. Each MUST resolve to a real dispatch for this session.",
                items: {
                  type: "object",
                  properties: {
                    dispatch_id: { type: "string", description: "The engine_dispatch id (preferred — exact provenance)." },
                    engine_name: { type: "string", description: "Alternative to dispatch_id; resolved only if it matches exactly one dispatch in this session." },
                    stance: { type: "string", enum: ["supports", "diverges"] },
                  },
                  required: ["stance"],
                },
              },
              citations: {
                type: "array",
                description: "The truth layer: independently-verifiable sources. resolution defaults 'unchecked' (claimed-until-checked).",
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    title: { type: "string" },
                    source_date: { type: "string", description: "ISO date (YYYY-MM-DD) the source is dated — load-bearing for claim-date-vs-source-date checking." },
                    dispatch_id: { type: "string", description: "Optional: the engine_dispatch this citation came from." },
                    engine_name: { type: "string", description: "Optional alternative to dispatch_id (unique-resolve)." },
                    note: { type: "string" },
                  },
                },
              },
            },
            required: ["claim_text", "claim_status"],
          },
        },
      },
      required: ["theo_session_id", "claims"],
    },
  },

  available: ({ isNewSession }) => !isNewSession,

  summarize: (input) => {
    const c = Array.isArray((input as { claims?: unknown[] })?.claims) ? (input as { claims: unknown[] }).claims.length : 0;
    return `write_claims: ${c} claim(s)`;
  },

  run: async (input, ctx: ToolContext) => {
    const i = input as { theo_session_id?: unknown; replace?: unknown; questions?: unknown; claims?: unknown };
    const sessionRaw = typeof i?.theo_session_id === "string" ? i.theo_session_id.trim() : "";
    if (!ID_RE.test(sessionRaw)) return fail(`theo_session_id must be a UUID or hex prefix. Got: ${sessionRaw.slice(0, 40)}`);
    if (!Array.isArray(i?.claims) || i.claims.length === 0) return fail("claims must be a non-empty array.");
    const replace = i?.replace === true;

    // Resolve session (prefix-tolerant; sessionRaw is ID_RE-validated).
    const sLookup = await ctx.supabase.rpc("execute_raw_sql", {
      query: `SELECT id FROM theo_session WHERE id::text LIKE '${sessionRaw}%' LIMIT 2`,
    });
    if (sLookup.error) return fail(`session lookup failed: ${sLookup.error.message}`);
    const sRows = (sLookup.data ?? []) as Array<{ id: string }>;
    if (sRows.length === 0) return fail(`no theo_session with id starting '${sessionRaw}'.`);
    if (sRows.length > 1) return fail(`prefix '${sessionRaw}' matches ${sRows.length} sessions — supply more characters.`);
    const sessionId = sRows[0].id;

    // Synthesis must exist — claims hang off a synthesis (write_synthesis_section first).
    const synth = await ctx.supabase
      .from("synthesis").select("id").eq("theo_session_id", sessionId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (synth.error) return fail(`synthesis lookup failed: ${synth.error.message}`);
    if (!synth.data?.id) return fail("no synthesis row for this session — write the synthesis first (write_synthesis_section).");
    const synthesisId = synth.data.id as string;

    // Build provenance maps for this session: dispatch ids, and engine_name → [ids].
    const disp = await ctx.supabase.from("engine_dispatch").select("id, engine_name").eq("theo_session_id", sessionId);
    if (disp.error) return fail(`dispatch lookup failed: ${disp.error.message}`);
    const dispatchIds = new Set<string>();
    const byEngine = new Map<string, string[]>();
    for (const r of (disp.data ?? []) as Array<{ id: string; engine_name: string }>) {
      dispatchIds.add(r.id);
      const arr = byEngine.get(r.engine_name) ?? [];
      arr.push(r.id);
      byEngine.set(r.engine_name, arr);
    }
    // Resolve a source/citation reference to a real dispatch id for this session.
    // Returns {id} or {err}. dispatch_id wins; engine_name resolves iff unique.
    const resolveDispatch = (dispatchId: unknown, engineName: unknown, where: string, required: boolean): { id: string | null; err?: string } => {
      if (typeof dispatchId === "string" && dispatchId.trim()) {
        const id = dispatchId.trim();
        if (!dispatchIds.has(id)) return { id: null, err: `${where}: dispatch_id ${id} is not an engine_dispatch for this session.` };
        return { id };
      }
      if (typeof engineName === "string" && engineName.trim()) {
        const ids = byEngine.get(engineName.trim());
        if (!ids || ids.length === 0) return { id: null, err: `${where}: engine '${engineName}' did not run in this session — cannot source a claim to it.` };
        if (ids.length > 1) return { id: null, err: `${where}: engine '${engineName}' ran for ${ids.length} questions — ambiguous; supply dispatch_id.` };
        return { id: ids[0] };
      }
      if (required) return { id: null, err: `${where}: needs a dispatch_id or engine_name.` };
      return { id: null };
    };

    // Section index → id map (for optional claim→section links).
    const secQ = await ctx.supabase.from("synthesis_section").select("id, section_index").eq("synthesis_id", synthesisId);
    if (secQ.error) return fail(`section lookup failed: ${secQ.error.message}`);
    const sectionByIndex = new Map<number, string>();
    for (const r of (secQ.data ?? []) as Array<{ id: string; section_index: number }>) sectionByIndex.set(r.section_index, r.id);

    // Pre-validate everything before any write (fail whole-call, not half-written).
    const questions = Array.isArray(i?.questions) ? (i.questions as QuestionIn[]) : [];
    for (let q = 0; q < questions.length; q++) {
      const qi = questions[q];
      if (!Number.isInteger(qi?.question_index)) return fail(`questions[${q}].question_index must be an integer.`);
      if (typeof qi?.question_text !== "string" || !qi.question_text.trim()) return fail(`questions[${q}].question_text is required.`);
      if (qi?.status !== undefined && !Q_STATUS.has(String(qi.status))) return fail(`questions[${q}].status invalid: '${qi.status}'.`);
    }
    const claims = i.claims as ClaimIn[];
    for (let c = 0; c < claims.length; c++) {
      const cl = claims[c];
      if (typeof cl?.claim_text !== "string" || !cl.claim_text.trim()) return fail(`claims[${c}].claim_text is required.`);
      if (!CLAIM_STATUS.has(String(cl?.claim_status))) return fail(`claims[${c}].claim_status invalid: '${cl?.claim_status}'. Use convergent/divergent/single_source/synthesis_inference/gap.`);
      if (cl?.divergence_status !== undefined && !DIVERGENCE_STATUS.has(String(cl.divergence_status))) return fail(`claims[${c}].divergence_status invalid: '${cl.divergence_status}'.`);
      for (const [si, s] of (Array.isArray(cl?.sources) ? cl.sources as SourceIn[] : []).entries()) {
        if (!STANCE.has(String(s?.stance))) return fail(`claims[${c}].sources[${si}].stance invalid: '${s?.stance}'. Use supports/diverges.`);
        const r = resolveDispatch(s?.dispatch_id, s?.engine_name, `claims[${c}].sources[${si}]`, true);
        if (r.err) return fail(r.err);
      }
      for (const [ci, ct] of (Array.isArray(cl?.citations) ? cl.citations as CitationIn[] : []).entries()) {
        const r = resolveDispatch(ct?.dispatch_id, ct?.engine_name, `claims[${c}].citations[${ci}]`, false);
        if (r.err) return fail(r.err);
      }
    }

    // Optional clean re-author.
    if (replace) {
      const delC = await ctx.supabase.from("synthesis_claim").delete().eq("synthesis_id", synthesisId);
      if (delC.error) return fail(`replace: claim delete failed: ${delC.error.message}`);
      const delQ = await ctx.supabase.from("research_question").delete().eq("theo_session_id", sessionId);
      if (delQ.error) return fail(`replace: question delete failed: ${delQ.error.message}`);
    }

    // Questions (upsert by session+index), build index→id.
    const questionByIndex = new Map<number, string>();
    if (questions.length > 0) {
      const up = await ctx.supabase.from("research_question").upsert(
        questions.map((q) => ({
          theo_session_id: sessionId,
          question_index: q.question_index as number,
          question_text: (q.question_text as string).trim(),
          status: q.status !== undefined ? String(q.status) : "answered",
        })),
        { onConflict: "theo_session_id,question_index" },
      ).select("id, question_index");
      if (up.error) return fail(`research_question upsert failed: ${up.error.message}`);
      for (const r of (up.data ?? []) as Array<{ id: string; question_index: number }>) questionByIndex.set(r.question_index, r.id);
    }
    // Backfill any question_index referenced by a claim but not in this call (existing rows).
    const referencedQ = new Set<number>();
    for (const cl of claims) if (Number.isInteger(cl?.question_index)) referencedQ.add(cl.question_index as number);
    const missingQ = [...referencedQ].filter((qi) => !questionByIndex.has(qi));
    if (missingQ.length > 0) {
      const exist = await ctx.supabase.from("research_question").select("id, question_index")
        .eq("theo_session_id", sessionId).in("question_index", missingQ);
      if (exist.error) return fail(`existing question lookup failed: ${exist.error.message}`);
      for (const r of (exist.data ?? []) as Array<{ id: string; question_index: number }>) questionByIndex.set(r.question_index, r.id);
    }

    // Claims (+ nested sources/citations).
    let claimN = 0, sourceN = 0, citationN = 0;
    for (const cl of claims) {
      const insC = await ctx.supabase.from("synthesis_claim").insert({
        synthesis_id: synthesisId,
        section_id: Number.isInteger(cl.section_index) ? (sectionByIndex.get(cl.section_index as number) ?? null) : null,
        question_id: Number.isInteger(cl.question_index) ? (questionByIndex.get(cl.question_index as number) ?? null) : null,
        claim_text: (cl.claim_text as string).trim(),
        claim_status: String(cl.claim_status),
        scope: typeof cl.scope === "string" ? cl.scope : null,
        divergence_status: cl.divergence_status !== undefined ? String(cl.divergence_status) : null,
        resolution_note: typeof cl.resolution_note === "string" ? cl.resolution_note : null,
      }).select("id").single();
      if (insC.error) return fail(`synthesis_claim insert failed: ${insC.error.message}`);
      const claimId = insC.data.id as string;
      claimN++;

      const sources = Array.isArray(cl.sources) ? cl.sources as SourceIn[] : [];
      if (sources.length > 0) {
        const rows = sources.map((s) => ({
          claim_id: claimId,
          dispatch_id: resolveDispatch(s.dispatch_id, s.engine_name, "", true).id,
          stance: String(s.stance),
        }));
        const insS = await ctx.supabase.from("claim_source").upsert(rows, { onConflict: "claim_id,dispatch_id" });
        if (insS.error) return fail(`claim_source insert failed: ${insS.error.message}`);
        sourceN += rows.length;
      }

      const citations = Array.isArray(cl.citations) ? cl.citations as CitationIn[] : [];
      if (citations.length > 0) {
        const rows = citations.map((ct) => ({
          claim_id: claimId,
          dispatch_id: resolveDispatch(ct.dispatch_id, ct.engine_name, "", false).id,
          url: typeof ct.url === "string" ? ct.url : null,
          title: typeof ct.title === "string" ? ct.title : null,
          source_date: typeof ct.source_date === "string" && ct.source_date.trim() ? ct.source_date.trim() : null,
          note: typeof ct.note === "string" ? ct.note : null,
          // resolution defaults to 'unchecked' at the DB level — claimed-until-checked.
        }));
        const insCit = await ctx.supabase.from("claim_citation").insert(rows);
        if (insCit.error) return fail(`claim_citation insert failed: ${insCit.error.message}`);
        citationN += rows.length;
      }
    }

    return JSON.stringify({
      theo_session_id: sessionId,
      synthesis_id: synthesisId,
      replaced: replace,
      written: { questions: questionByIndex.size, claims: claimN, sources: sourceN, citations: citationN },
      "[SYSTEM]": `Claim layer written: ${claimN} claim(s), ${sourceN} source link(s), ${citationN} citation(s). Citations are 'unchecked' until the liveness pass resolves them. render_claim_v1 now returns these rows; verify with read_synthesis or a render-view read. Provenance is intact — every source/citation resolved to a real dispatch for this session.`,
    });
  },
};
