import type { CompletionItem } from "./completion.ts";
import { InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export const historyCommand: CompletionItem = { kind: "command", value: "history", description: "Open saved session history for this worktree" };

// Reserve the popup command at every prompt boundary; never send it to the model.
export function parseHistoryCommand(text: string): Result<boolean, InputError> {
  if (!/^\/history(?:\s|$)/u.test(text)) return ok(false);
  return text.slice(8).trim() ? err(new InputError("Usage: /history (open saved session history; no arguments).")) : ok(true);
}
