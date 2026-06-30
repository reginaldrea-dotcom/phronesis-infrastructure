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
// claim_source / claim_citation must carry a REAL dispatch_id from THIS CONVERSATION
// (the arc session OR a sibling capture session of the same conversation — baton 8cb99efa).
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
import { captureSource } from "../lib/captureSource.ts";
import { resolveCaptureSession } from "../lib/resolveCaptureSession.ts";
import { assertCaptureTarget } from "../lib/captureTarget.ts";

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
  supersedes_claim_id?: unknown;
}
interface QuestionIn { question_index?: unknown; question_text?: unknown; status?: unknown; }

export const writeClaimsTool: Tool = {
  definition: {
    name: "write_claims",
    description:
      "Write the authored claim layer for a theo_session's synthesis: research_question rows (the navigation spine), synthesis_claim rows (load-bearing claims, not every sentence), claim_source (claim→engine provenance) and claim_citation (the independently-verifiable source; resolution defaults 'unchecked'). Author this AFTER the synthesis exists (write_synthesis_section). Every source/citation must carry a real dispatch_id from this conversation (the arc session or a sibling capture session) — pass dispatch_id, or an engine_name that resolves to exactly one dispatch (ambiguous engines must use dispatch_id). claim_status: convergent/divergent/single_source/synthesis_inference/gap. stance: supports/diverges. Pass replace=true to re-author cleanly (deletes existing questions+claims first). To CORRECT an existing claim, append the corrected claim with supersedes_claim_id set to the old claim's id: the old claim is atomically marked superseded (auditable correction, never a silent in-place edit), and the new claim carries the correction.",
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
              supersedes_claim_id: { type: "string", description: "Optional correction: the full id of an EXISTING claim in this synthesis that this claim replaces. That claim is atomically marked claim_lifecycle='superseded' with superseded_by set to this new claim — an auditable correction, not an in-place edit. Append-only (not valid with replace=true); must be a real claim of this synthesis." },
              sources: {
                type: "array",
                description: "Provenance: which engine returns support/diverge on this claim. Each MUST resolve to a real dispatch in this conversation.",
                items: {
                  type: "object",
                  properties: {
                    dispatch_id: { type: "string", description: "The engine_dispatch id (preferred — exact provenance)." },
                    engine_name: { type: "string", description: "Alternative to dispatch_id; resolved only if it matches exactly one dispatch in this conversation." },
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

    // Resolve session (prefix-tolerant; also accepts a synthesis_id and maps it to its
    // session — the model routinely conflates the two ids). sessionRaw is ID_RE-validated.
    const resolved = await resolveCaptureSession(ctx.supabase, sessionRaw);
    if ("err" in resolved) return fail(resolved.err);
    const sessionId = resolved.sessionId;
    const idNote = resolved.note ? ` ${resolved.note}` : "";

    // Ownership-bind (a90e1410 inst 3): a run may only write claims to the synthesis it declared.
    const own = await assertCaptureTarget(ctx.supabase, ctx.sessionId, sessionId);
    if ("err" in own) return fail(own.err);

    // Synthesis must exist — claims hang off a synthesis (write_synthesis_section first).
    const synth = await ctx.supabase
      .from("synthesis").select("id").eq("theo_session_id", sessionId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (synth.error) return fail(`synthesis lookup failed: ${synth.error.message}`);
    if (!synth.data?.id) return fail("no synthesis row for this session — write the synthesis first (write_synthesis_section).");
    const synthesisId = synth.data.id as string;

    // Build provenance maps for this CONVERSATION: dispatch ids, and engine_name → [ids].
    // Widen the dispatch pool from the single session to the conversation (Conf d36d9609 / baton
    // 8cb99efa; Connie ruling 82d38a8f): an arc claim may legitimately cite a dispatch run in a sibling
    // CAPTURE session of the same conversation. The forgery floor holds, just at conversation scope —
    // the dispatch must be REAL and IN THIS CONVERSATION, never "any dispatch anywhere". Falls back to
    // the single session if it has no conversation (legacy).
    const convRow = await ctx.supabase.from("theo_session").select("conversation_id").eq("id", sessionId).maybeSingle();
    const conversationId = (convRow.data as { conversation_id?: string } | null)?.conversation_id ?? null;
    let dispatchSessionIds: string[] = [sessionId];
    if (conversationId) {
      const sibs = await ctx.supabase.from("theo_session").select("id").eq("conversation_id", conversationId);
      const ids = ((sibs.data ?? []) as Array<{ id: string }>).map((r) => String(r.id));
      if (ids.length > 0) dispatchSessionIds = ids;
    }
    const disp = await ctx.supabase.from("engine_dispatch")
      .select("id, engine_name, role_in_dispatch, role_description, prompt_sent, theo_session_id")
      .in("theo_session_id", dispatchSessionIds);
    if (disp.error) return fail(`dispatch lookup failed: ${disp.error.message}`);
    const dispatchIds = new Set<string>();
    const byEngine = new Map<string, string[]>();
    const dispatchLabel = new Map<string, string>();
    const thisSessionDispatch = new Set<string>();
    for (const r of (disp.data ?? []) as Array<{ id: string; engine_name: string; role_in_dispatch: string | null; role_description: string | null; prompt_sent: string | null; theo_session_id: string }>) {
      dispatchIds.add(r.id);
      if (r.theo_session_id === sessionId) thisSessionDispatch.add(r.id);
      const arr = byEngine.get(r.engine_name) ?? [];
      arr.push(r.id);
      byEngine.set(r.engine_name, arr);
      // A short human label so an ambiguity error can name each candidate, not just count them.
      const hint = (r.role_description || r.prompt_sent || r.role_in_dispatch || "").replace(/\s+/g, " ").trim().slice(0, 70);
      dispatchLabel.set(r.id, `${r.id}${hint ? ` ["${hint}…"]` : ""}`);
    }
    // Resolve a source/citation reference to a real dispatch id for this session.
    // Returns {id} or {err}. dispatch_id wins; engine_name resolves iff unique.
    const resolveDispatch = (dispatchId: unknown, engineName: unknown, where: string, required: boolean): { id: string | null; err?: string } => {
      if (typeof dispatchId === "string" && dispatchId.trim()) {
        const id = dispatchId.trim();
        if (!dispatchIds.has(id)) return { id: null, err: `${where}: dispatch_id ${id} is not an engine_dispatch in this conversation.` };
        return { id };
      }
      if (typeof engineName === "string" && engineName.trim()) {
        const ids = byEngine.get(engineName.trim());
        if (!ids || ids.length === 0) return { id: null, err: `${where}: engine '${engineName}' did not run in this conversation — cannot source a claim to it.` };
        if (ids.length > 1) {
          // SELF-SERVICE (Angelia SC1, 30 Jun): an engine that ran multiple questions can't be
          // disambiguated by name, and stamping question_id at enqueue is Theo's lane. So list the
          // candidate dispatch_ids HERE — turn the dead-end into a one-step fix: pick the dispatch
          // whose return supports THIS claim and pass it as sources[].dispatch_id / citations[].dispatch_id.
          // The conversation-wide provenance pool (8cb99efa) can make this list long in a mature arc, so
          // lead with THIS session's dispatches (almost always the right ones) and cap the siblings.
          const here = ids.filter((id) => thisSessionDispatch.has(id));
          const elsewhere = ids.filter((id) => !thisSessionDispatch.has(id));
          const SIB_CAP = 4;
          const lines = [
            ...here.map((id) => `${dispatchLabel.get(id) ?? id} (this session)`),
            ...elsewhere.slice(0, SIB_CAP).map((id) => `${dispatchLabel.get(id) ?? id} (sibling session)`),
          ];
          const more = elsewhere.length > SIB_CAP ? ` …and ${elsewhere.length - SIB_CAP} more in sibling capture sessions (use dispatch_id).` : "";
          return { id: null, err: `${where}: engine '${engineName}' ran ${ids.length} dispatches in this conversation — ambiguous by name. Cite by dispatch_id instead (usually one from THIS session). Candidates: ${lines.join("; ")}.${more} Use the dispatch_id of the one whose return supports this claim.` };
        }
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

    // Supersede targets (corrections, baton a3c59a67 / Connie ruling): each supersedes_claim_id must be a
    // REAL claim of THIS synthesis — the forgery floor for corrections; you can only supersede an existing
    // claim of the synthesis you are authoring. Exact-id only (no prefix match — never risk flipping the
    // wrong claim). Append-only: incompatible with replace, which would delete the very claims you supersede.
    const supersedeIds = new Set<string>();
    for (let c = 0; c < claims.length; c++) {
      const sid = typeof claims[c]?.supersedes_claim_id === "string" ? (claims[c].supersedes_claim_id as string).trim() : "";
      if (!sid) continue;
      if (!ID_RE.test(sid)) return fail(`claims[${c}].supersedes_claim_id must be a claim UUID. Got: ${sid.slice(0, 40)}`);
      supersedeIds.add(sid);
    }
    if (supersedeIds.size > 0) {
      if (replace) return fail("supersedes_claim_id is append-only and cannot be combined with replace=true (replace deletes the claims you would supersede).");
      const ex = await ctx.supabase.from("synthesis_claim").select("id").eq("synthesis_id", synthesisId).in("id", [...supersedeIds]);
      if (ex.error) return fail(`supersede target lookup failed: ${ex.error.message}`);
      const found = new Set(((ex.data ?? []) as Array<{ id: string }>).map((r) => r.id));
      for (const sid of supersedeIds) if (!found.has(sid)) return fail(`supersedes_claim_id ${sid} is not a claim of this synthesis — cannot supersede it.`);
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

    // Roadmap Phase 1 — CAPTURE AT RESEARCH TIME. Freeze every cited web source NOW into the
    // evidence locker and build url -> source_document_id, so each citation lands version-pinned
    // to an immutable snapshot rather than a URL that rots. Pre-captured in BOUNDED-PARALLEL batches
    // (so total time is ~one fetch timeout per batch, not the sum — stays under the EF ceiling).
    // Best-effort: a null id means cited-but-not-anchored (a loud gap), never a blocked write.
    const captureCache = new Map<string, string | null>();
    const urlMeta = new Map<string, { title: string | null; sourceDate: string | null }>();
    for (const cl of claims) {
      for (const ct of (Array.isArray(cl.citations) ? cl.citations as CitationIn[] : [])) {
        const u = typeof ct?.url === "string" ? ct.url.trim() : "";
        if (/^https?:\/\//i.test(u) && !urlMeta.has(u)) {
          urlMeta.set(u, {
            title: typeof ct.title === "string" ? ct.title : null,
            sourceDate: typeof ct.source_date === "string" && ct.source_date.trim() ? ct.source_date.trim() : null,
          });
        }
      }
    }
    const urlList = [...urlMeta.keys()];
    const CAPTURE_CONCURRENCY = 8;
    for (let k = 0; k < urlList.length; k += CAPTURE_CONCURRENCY) {
      const batch = urlList.slice(k, k + CAPTURE_CONCURRENCY);
      const ids = await Promise.all(batch.map((u) => {
        const m = urlMeta.get(u)!;
        return captureSource(ctx.supabase, { url: u, title: m.title, sourceDate: m.sourceDate, sessionId })
          .catch(() => null);
      }));
      batch.forEach((u, idx) => captureCache.set(u, ids[idx]));
    }

    // Claims (+ nested sources/citations). Collect the persisted ids so the author can read the
    // write back (A2 5acd06d0) and chain citation_ids into write_figure (folds Connie's 6e3dbeb6).
    let claimN = 0, sourceN = 0, citationN = 0, anchoredN = 0, supersededN = 0;
    const claimIds: string[] = [];
    const citationIds: string[] = [];
    const supersededPairs: Array<{ old: string; new: string }> = [];
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
      claimIds.push(claimId);
      claimN++;

      // Atomic correction: the corrected claim is now in (active by default); mark the claim it
      // supersedes and point that claim at this one. Validated above as a real claim of this synthesis.
      // Double-guarded on synthesis_id so a flip can only ever land within this synthesis.
      const supersedesId = typeof cl.supersedes_claim_id === "string" ? cl.supersedes_claim_id.trim() : "";
      if (supersedesId) {
        const upd = await ctx.supabase.from("synthesis_claim")
          .update({ claim_lifecycle: "superseded", superseded_by: claimId })
          .eq("id", supersedesId).eq("synthesis_id", synthesisId);
        if (upd.error) return fail(`supersede update failed for claim ${supersedesId}: ${upd.error.message}`);
        supersededN++;
        supersededPairs.push({ old: supersedesId, new: claimId });
      }

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
        const rows = citations.map((ct) => {
          const url = typeof ct.url === "string" ? ct.url : null;
          // Pin the captured snapshot (version-pinned anchor). null = cited-not-anchored (loud gap).
          const sourceDocId = url ? (captureCache.get(url.trim()) ?? null) : null;
          if (sourceDocId) anchoredN++;
          return {
            claim_id: claimId,
            dispatch_id: resolveDispatch(ct.dispatch_id, ct.engine_name, "", false).id,
            url,
            title: typeof ct.title === "string" ? ct.title : null,
            source_date: typeof ct.source_date === "string" && ct.source_date.trim() ? ct.source_date.trim() : null,
            note: typeof ct.note === "string" ? ct.note : null,
            source_document_id: sourceDocId,
            // resolution defaults to 'unchecked' at the DB level — claimed-until-checked.
          };
        });
        const insCit = await ctx.supabase.from("claim_citation").insert(rows).select("id");
        if (insCit.error) return fail(`claim_citation insert failed: ${insCit.error.message}`);
        for (const r of (insCit.data ?? []) as Array<{ id: string }>) citationIds.push(r.id);
        citationN += rows.length;
      }
    }

    return JSON.stringify({
      theo_session_id: sessionId,
      synthesis_id: synthesisId,
      replaced: replace,
      // Confirmed-persisted counts: every count here is a row that COMMITTED. Each insert is
      // error-checked (and claims use .select().single()), so a failed persist returns a loud
      // error and stops this call — it never returns a count. So a count IS the confirmation.
      persisted: { questions: questionByIndex.size, claims: claimN, sources: sourceN, citations: citationN, anchored: anchoredN, superseded: supersededN },
      claim_ids: claimIds,        // A2 5acd06d0 — the write landed iff these come back
      citation_ids: citationIds,  // folds 6e3dbeb6 — feed straight into write_figure
      superseded: supersededPairs, // {old,new} pairs — old claim marked superseded, superseded_by=new
      "[SYSTEM]": `PERSISTED + CONFIRMED. ${claimN} claim(s) [ids: ${claimIds.join(", ") || "none"}], ${citationN} citation(s) [ids: ${citationIds.join(", ") || "none"}], ${sourceN} source link(s)${supersededN > 0 ? `, ${supersededN} correction(s) [superseded: ${supersededPairs.map((p) => `${p.old}→${p.new}`).join(", ")}]` : ""}. These ids ARE the confirmation the write landed — read them back, and pass citation_ids into write_figure. Every count above is a committed row: a failed persist would have surfaced as an error and stopped this call, not returned a count, so silence-on-failure is not possible here. ${anchoredN} citation(s) ANCHORED to a captured source_document (frozen + hashed); ${citationN - anchoredN} cited-but-not-anchored (no recoverable snapshot — a loud gap, not a silent hole). Citations are 'unchecked' until the liveness pass. Provenance intact — every source/citation resolved to a real dispatch for this conversation.${supersededN > 0 ? " Corrections are auditable: the old claim is marked claim_lifecycle='superseded' with superseded_by set to its correction, never edited in place." : ""}${idNote}`,
    });
  },
};
