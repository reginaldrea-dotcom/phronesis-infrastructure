// Per-Prime model selection, resolved once per request from lineage_name.
// Defaults ratified by Reg (conference 7b09ea35); keys validated against the
// instructions table (Napoleon, 30 May 2026).

export const MODEL_BY_LINEAGE: Record<string, string> = {
  argos:          "claude-opus-4-8",   // confirmed
  constantinople: "claude-opus-4-8",   // Connie — confirmed
  theophrastus:   "claude-sonnet-4-6", // Theo — confirmed
  napoleon:       "claude-sonnet-4-6", // confirmed
  clarev:         "claude-opus-4-8",   // PLACEHOLDER — Clarev is a product/interface, not yet a
                                        //   Prime lineage. No lineage_name matches this key, so it
                                        //   is inert (resolves to DEFAULT_MODEL) until Clarev's
                                        //   lineage is created in the substrate.
};

export const DEFAULT_MODEL = "claude-sonnet-4-6";

export function modelForLineage(lineage: string): string {
  return MODEL_BY_LINEAGE[lineage] ?? DEFAULT_MODEL;
}
