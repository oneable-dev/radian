import type { CompletionItem } from "./completion.ts";
import { InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export type SessionControl = { action: "new" } | { action: "compact"; instructions?: string };
export const sessionControlCommands: readonly CompletionItem[] = [
  { kind: "command", value: "new", description: "Start a fresh conversation in this tab; keep the previous conversation in History" },
  { kind: "command", value: "compact", description: "Summarize this session's model context: /compact [instructions]. May use model tokens" },
];

// Recognition and completion share the same reserved host command names. These
// actions must never fall through to SDK prompt/template expansion or the model.
export function parseSessionControl(text: string): Result<SessionControl | null, InputError> {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text);
  if (!match || !sessionControlCommands.some((item) => item.value === match[1])) return ok(null);
  const instructions = match[2]?.trim();
  if (match[1] === "new") return instructions ? err(new InputError("Usage: /new (no arguments).")) : ok({ action: "new" });
  return ok({ action: "compact", ...(instructions ? { instructions } : {}) });
}
