import type { ExecutionState } from "../agents/session-registry.ts";

/** Transcript text as clients render it: streamed sections, or the legacy output preview. */
export function transcriptText(state: ExecutionState | null | undefined): string {
  if (!state) return "";
  return state.sections ? state.sections.map((section) => section.text).join("\n") : state.output;
}
