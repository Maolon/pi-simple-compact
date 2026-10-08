import type {
  NonLlmReducer,
  ReducerInput,
  SummarySharedContext,
} from "./pipeline.ts";

/**
 * Deterministic example reducer: emit de-duplicated, chronology-preserving source facts.
 * This intentionally performs no semantic rewriting; a caller can install it under any
 * route name with `{ routes: { user: { reducer: "deterministic-facts" } } }`.
 */
export const deterministicFactsReducer: NonLlmReducer = (
  input: ReducerInput,
  shared: SummarySharedContext,
  signal: AbortSignal,
): string => {
  signal.throwIfAborted();
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of input.items) {
    signal.throwIfAborted();
    const normalized = item.text.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(`- ${normalized}`);
  }

  const sections: string[] = [];
  if (shared.taskCapsule) sections.push(`Current user task from ${shared.taskCapsule.entryId}:\n${shared.taskCapsule.text}`);
  if (shared.previousSummary) sections.push(`Prior summary context:\n${shared.previousSummary}`);
  if (shared.manualFocus) sections.push(`Manual focus:\n${shared.manualFocus}`);
  if (shared.splitPrefix) sections.push(`Split-turn prefix context:\n${shared.splitPrefix}`);
  sections.push(`Exact ${input.kind} facts:\n${lines.length > 0 ? lines.join("\n") : "- No non-empty facts."}`);
  return sections.join("\n\n");
};
