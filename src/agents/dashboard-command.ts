import type { CompletionItem } from "./completion.ts";
import { InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export const dashboardCommand: CompletionItem = {
  kind: "command",
  value: "dashboard",
  description: "Open Agent usage statistics and graphs",
};

export function parseDashboardCommand(text: string): Result<boolean, InputError> {
  if (!/^\/dashboard(?:\s|$)/u.test(text)) {
    return ok(false);
  }

  return text.slice(10).trim()
    ? err(new InputError("Usage: /dashboard (open usage statistics; no arguments)."))
    : ok(true);
}
