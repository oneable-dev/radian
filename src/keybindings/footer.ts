import { defaultKeymap } from "./config.ts";
import type { CommandId, KeyContext } from "./commands.ts";

const defaults = defaultKeymap();
const omitted = new Set<CommandId>([
  "agent.send",
  "agent.newline",
  "agent.interrupt",
  "git.submit",
  "git.newline",
]);
const routine = new Set<CommandId>([
  "focus.next",
  "focus.results",
  "button.activate",
  "agent.clear",
  "agent.history-previous",
  "agent.history-next",
  "git.clear",
  "git.search-clear",
  "search.clear",
  "dialog.dismiss",
  "dialog.half-page-down",
  "messages.open",
  "messages.dismiss",
  "messages.next",
  "messages.previous",
  "messages.first",
  "messages.last",
  "messages.half-page-down",
  "workspace.open",
  "workspace.dismiss",
  "workspace.previous",
  "workspace.next",
  "workspace.first",
  "workspace.last",
  "workspace.half-page-down",
  "session.previous",
  "session.next",
  "tab.previous",
  "tab.next",
  "terminal.tab-previous",
  "terminal.tab-next",
  "terminal.scroll-up",
  "terminal.scroll-down",
  "terminal.copy-right",
  "terminal.copy-visual",
  "terminal.copy-visual-line",
  "terminal.copy-half-page-down",
  "terminal.copy-back",
  "completion.next",
  "completion.previous",
  "completion.dismiss",
  "history.open",
  "history.dismiss",
  "history.previous",
  "history.next",
  "history.half-page-down",
  "monitor.open",
  "monitor.dismiss",
  "monitor.previous",
  "monitor.next",
  "monitor.half-page-down",
  "model.dismiss",
  "model.previous",
  "model.next",
  "model.half-page-down",
  "accounts.dismiss",
  "accounts.previous",
  "accounts.next",
  "accounts.half-page-down",
  "extension.dismiss",
  "extension.previous",
  "extension.next",
  "extension.half-page-down",
  "dashboard.dismiss",
  "dashboard.previous",
  "dashboard.next",
  "dashboard.half-page-down",
  "transcript.next",
  "transcript.right",
  "transcript.visual",
  "transcript.visual-line",
  "transcript.half-page-down",
  "transcript.page-down",
  "transcript.back",
  "transcript.help",
  "git.back",
  "git.cancel",
  "git.previous",
  "git.next",
  "git.half-page-down",
]);

// Keep routine defaults in full help, not the footer. Changed bindings remain discoverable;
// send, newline and interrupt hints are deliberately omitted even when rebound.
export function footerKeyHint(command: CommandId, context: KeyContext, key: string): string {
  if (omitted.has(command)) {
    return "";
  }

  const conventional =
    routine.has(command) ||
    (command === "transcript.copy" && context === "transcript-visual") ||
    (command === "terminal.copy-yank" && context === "terminal-visual");
  if (!conventional) {
    return key;
  }

  return key === defaults.hint(command, context) || key === defaults.hints(command, context)
    ? ""
    : key;
}
