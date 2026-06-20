// load_mst — the PULL half of MST delivery (conf d36d9609, MR ac84a3d9; baton 3305e3d0, component 2).
//
// The C pointer-list (component 1) advertises, on the per-turn rail, WHICH MSTs are mapped to this
// Prime's working set and which reasoning junctures they serve — pointers only, never the bodies.
// load_mst is how the Prime then PULLS the body it needs, at the juncture it needs it. Pull-only by
// design (push-injection was struck): nothing is force-fed; the Prime asks, scoped to its own working
// set (prime_mst_map), and gets exactly what serves the asked juncture/topic — not "which of forty".
//
// Three ways to ask (give one):
//   • juncture: "VALIDATION" | "DECISION" — resolved OVER CONNIE'S D-LITE VIEW (juncture_mst_index),
//     so it stays behind her seam: when she widens the vocabulary or re-curates the index, this widens
//     with it, no code change.
//   • topic: free text — matched against the MST's metadata.topic / domain / title within your working set.
//   • mst_id: pull one specific MST by id (must be in your working set).
// With NO argument, load_mst returns your POINTERS (discovery: what you could pull), no bodies.
//
// Lineage-scoped to the caller's mapped set (ctx.lineageName ⋈ prime_mst_map) — like read_super_t, no
// cross-Prime exposure. An id outside your working set returns a clear "not in your set", not the body.
// Read-only, always offered (including the wake turn — that is exactly when a Prime may need to pull).

import type { Tool, ToolContext } from "./types.ts";
import { logMstEvent } from "../lib/mstLedger.ts";

// Parsimony guard: a juncture/topic that resolves to more than this many MSTs returns POINTERS, not
// bodies — the Prime then pulls the specific one by id. Keeps a broad ask from dumping the working set.
const MAX_BODIES = 6;

interface MapRec {
  mst_id: string;
  map_reason: string | null;
  title: string;
  genre: string | null;
  junctures: string[];
  topic: string | null;
  domain: string | null;
  load_when: string | null;
}

function meta(a: any): Record<string, any> { return (a?.metadata ?? {}) as Record<string, any>; }

function toRec(row: any): MapRec {
  const m = meta(row?.artifacts);
  return {
    mst_id: row.mst_id,
    map_reason: row.reason ?? null,
    title: row?.artifacts?.title ?? "(untitled)",
    genre: m.genre ?? null,
    junctures: Array.isArray(m.junctures) ? m.junctures : [],
    topic: m.topic ?? null,
    domain: m.domain ?? null,
    load_when: m.load_when ?? null,
  };
}

function pointer(r: MapRec) {
  return {
    mst_id: r.mst_id, title: r.title, genre: r.genre,
    serves: r.junctures, topic: r.topic, load_when: r.load_when, map_reason: r.map_reason,
  };
}

export const loadMstTool: Tool = {
  definition: {
    name: "load_mst",
    description:
      "Pull a mapped MST (memory super-template) into context at the juncture you need it — the pull half of MST delivery. " +
      "Your per-turn rail lists your MSTs as POINTERS; call load_mst to pull a body. Ask by ONE of: " +
      "juncture (e.g. \"VALIDATION\", \"DECISION\") — pulls the MST(s) mapped to you that serve that reasoning juncture, resolved over the juncture index; " +
      "topic (free text) — matched against your MSTs' topic/domain/title; or mst_id — one specific MST by id. " +
      "Call with NO argument to list what you could pull (pointers only, no bodies). You can only pull MSTs in your own working set.",
    input_schema: {
      type: "object",
      properties: {
        juncture: { type: "string", description: "A reasoning juncture, e.g. VALIDATION or DECISION. Pulls your MST(s) tagged for it, via the juncture index (D-lite)." },
        topic: { type: "string", description: "Free-text topic, matched against your MSTs' topic/domain/title." },
        mst_id: { type: "string", description: "Pull one specific MST by id (must be in your working set)." },
      },
    },
  },

  available: () => true,

  summarize: (input) => {
    const i = (input ?? {}) as { juncture?: string; topic?: string; mst_id?: string };
    if (i.mst_id) return `load_mst: id ${String(i.mst_id).slice(0, 8)}`;
    if (i.juncture) return `load_mst: juncture ${i.juncture}`;
    if (i.topic) return `load_mst: topic ${i.topic}`;
    return "load_mst: pointers";
  },

  run: async (input, ctx: ToolContext) => {
    const i = (input ?? {}) as { juncture?: string; topic?: string; mst_id?: string };
    const lineage = ctx.lineageName;

    // Working set (no content): map_reason + the metadata that powers pointers, mst_id and topic modes.
    const mapRes = await ctx.supabase
      .from("prime_mst_map")
      .select("mst_id, reason, created_at, artifacts(title, metadata)")
      .eq("lineage", lineage)
      .order("created_at", { ascending: true });
    if (mapRes.error) return `load_mst error: ${mapRes.error.message}`;
    const recs = ((mapRes.data ?? []) as any[]).map(toRec);
    const byId = new Map<string, MapRec>(recs.map((r) => [r.mst_id, r]));

    if (recs.length === 0) {
      return JSON.stringify({
        mode: "empty", lineage, count: 0, msts: [],
        "[SYSTEM]": `No MSTs are mapped to ${lineage} yet — your working set is empty, so there is nothing to pull.`,
      });
    }

    // ── Discovery: no argument → pointers only (what you could pull). ──
    if (!i.juncture && !i.topic && !i.mst_id) {
      return JSON.stringify({
        mode: "pointers", lineage, count: recs.length, msts: recs.map(pointer),
        "[SYSTEM]": `${recs.length} MST(s) in your working set. Pull one with load_mst({mst_id}), or by juncture/topic. Pointers only — no bodies loaded.`,
      });
    }

    // ── Resolve the target id set (scoped to your working set), by precedence id > juncture > topic. ──
    let resolved: MapRec[] = [];
    let mode = "", query = "";

    if (i.mst_id) {
      mode = "mst_id"; query = i.mst_id;
      const r = byId.get(i.mst_id);
      if (!r) {
        return JSON.stringify({
          mode, query, lineage, count: 0, msts: [],
          "[SYSTEM]": `MST ${i.mst_id} is not in ${lineage}'s working set. Call load_mst with no argument to see what you can pull.`,
        });
      }
      resolved = [r];
    } else if (i.juncture) {
      mode = "juncture"; query = i.juncture.trim().toUpperCase();
      // Resolve over Connie's D-lite view so we stay behind her seam (vocab/curation lives there).
      const vRes = await ctx.supabase
        .from("juncture_mst_index")
        .select("mst_id")
        .eq("lineage", lineage)
        .eq("juncture", query);
      if (vRes.error) return `load_mst error: ${vRes.error.message}`;
      const ids = Array.from(new Set(((vRes.data ?? []) as any[]).map((x) => x.mst_id)));
      resolved = ids.map((id) => byId.get(id)).filter((r): r is MapRec => !!r);
      // M1 denominator: reaching a juncture via load_mst self-reports it (recorded hit OR miss).
      await logMstEvent(ctx, { kind: "juncture_reached", source: "load_mst", juncture: query });
    } else {
      mode = "topic"; query = (i.topic ?? "").trim();
      const q = query.toLowerCase();
      resolved = recs.filter((r) =>
        (r.topic && r.topic.toLowerCase().includes(q)) ||
        (r.domain && r.domain.toLowerCase().includes(q)) ||
        (r.title && r.title.toLowerCase().includes(q)));
    }

    if (resolved.length === 0) {
      const junctures = Array.from(new Set(recs.flatMap((r) => r.junctures))).sort();
      const hint = mode === "juncture"
        ? ` Junctures your mapped MSTs serve: ${junctures.length ? junctures.join(", ") : "none tagged yet"}.`
        : "";
      return JSON.stringify({
        mode, query, lineage, count: 0, msts: [],
        "[SYSTEM]": `No MST mapped to ${lineage} matched ${mode} '${query}'.${hint} Call load_mst with no argument to see your full set.`,
      });
    }

    // M1 numerator: a pull happened (>=1 resolved). Juncture-keyed only in juncture mode.
    await logMstEvent(ctx, {
      kind: "mst_pulled",
      source: "load_mst",
      juncture: mode === "juncture" ? query : null,
      mst_id: mode === "mst_id" ? query : null,
      detail: { mode, query, mst_ids: resolved.map((r) => r.mst_id) },
    });

    // ── Parsimony cap: a broad match returns pointers, not a body-dump. ──
    if (resolved.length > MAX_BODIES) {
      return JSON.stringify({
        mode, query, lineage, count: resolved.length, returned: "pointers", msts: resolved.map(pointer),
        "[SYSTEM]": `${resolved.length} MSTs matched ${mode} '${query}' — more than ${MAX_BODIES}, so pointers only. Pull a specific one with load_mst({mst_id}).`,
      });
    }

    // ── Bodies: fetch content for the resolved set. ──
    const ids = resolved.map((r) => r.mst_id);
    const bRes = await ctx.supabase.from("artifacts").select("id, content").in("id", ids);
    if (bRes.error) return `load_mst error: ${bRes.error.message}`;
    const content = new Map<string, string>(((bRes.data ?? []) as any[]).map((a) => [a.id, a.content ?? ""]));

    const msts = resolved.map((r) => ({
      mst_id: r.mst_id, title: r.title, genre: r.genre, serves: r.junctures,
      topic: r.topic, load_when: r.load_when, map_reason: r.map_reason,
      content: content.get(r.mst_id) ?? "",
    }));

    return JSON.stringify({
      mode, query, lineage, count: msts.length, returned: "bodies", msts,
      "[SYSTEM]": `Pulled ${msts.length} MST(s) for ${mode} '${query}', in full. These are your mapped working-set MSTs — rely on them as your own filed knowledge.`,
    });
  },
};
