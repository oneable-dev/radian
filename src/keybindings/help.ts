import { formatKeys, isImplicitArrowBinding, type Keymap } from "./config.ts";
import { inScope, type CommandId, type KeyContext } from "./commands.ts";

const labels: Partial<Record<CommandId, string>> = {
  "app.detach": "Detach Radian (keep background work running)", "app.help": "Open application help", "notice.details": "Read the current notification",
  "sidebar.toggle": "Toggle the workspace popup", "focus.search": "Search workspaces", "focus.sidebar": "Open the workspace popup",
  "workspace.dismiss": "Close without switching workspaces", "workspace.search": "Search workspaces",
  "monitor.show": "Monitor working sessions and unread results", "monitor.open": "Open the selected session", "monitor.dismiss": "Close session monitoring", "monitor.preview": "Focus or toggle live preview",
  "focus.prompt": "Focus the Agent input", "focus.transcript": "Read the Agent conversation", "focus.next": "Next focus target", "focus.previous": "Previous focus target",
  "view.agent": "Show Agents", "view.editor": "Show Editor", "view.git": "Show Git", "view.terminal": "Show Terminal",
  "tab.new": "Create a session in Agents or a shell in Terminal",
  "tab.select-1": "Select tab 1", "tab.select-2": "Select tab 2", "tab.select-3": "Select tab 3",
  "tab.select-4": "Select tab 4", "tab.select-5": "Select tab 5", "tab.select-6": "Select tab 6",
  "tab.select-7": "Select tab 7", "tab.select-8": "Select tab 8", "tab.select-9": "Select tab 9",
  "agent.send": "Send input (steer at the next eligible turn when busy)", "agent.newline": "Insert a newline without sending", "agent.paste": "Paste text, images or files from the clipboard", "agent.inspect": "Inspect the attachment at the cursor",
  "git.submit": "Send input with the frozen Git context", "git.newline": "Insert a newline without sending", "git.paste": "Paste from the clipboard", "git.inspect": "Inspect the attachment at the cursor",
  "history.show": "Open saved session history", "transcript.help": "Open conversation navigation help",
};
export function keymapHelp(keymap: Keymap, context: KeyContext, available: (command: CommandId) => boolean): string {
  const rows = (global: boolean): string => {
    const groups = new Map<CommandId, string[]>();
    for (const binding of keymap.bindings) {
      const common = binding.scope === "global" || binding.scope === "app" || binding.scope === "pty"
        || binding.command === "app.help" || binding.command === "focus.next" || binding.command === "focus.previous";
      if (common !== global || !inScope(binding.scope, context) || !available(binding.command) || isImplicitArrowBinding(binding)) continue;
      const keys = groups.get(binding.command) ?? [];
      const key = formatKeys(binding.keys);
      if (!keys.includes(key)) keys.push(key);
      groups.set(binding.command, keys);
    }
    const family = context.startsWith("prompt") ? "agent" : context.startsWith("history") ? "history" : context.startsWith("transcript") ? "transcript" : context.split("-")[0];
    const entries = [...groups];
    if (!global) entries.sort(([a], [b]) => Number(b.startsWith(family + ".")) - Number(a.startsWith(family + ".")));
    return entries.map(([command, keys]) => {
      const key = keys.join(" / "), description = labels[command] ?? command.replaceAll(".", " ").replaceAll("-", " ");
      const width = Bun.stringWidth(key);
      return width < 28 ? key + " ".repeat(28 - width) + description : `${key}\n  ${description}`;
    }).join("\n") || "No additional bindings in this context.";
  };
  return `Current context: ${context}\n\n${rows(false)}\n\nApplication shortcuts\n\n${rows(true)}\n\nInput ownership\n\nEnter sends the current Agent input, even with suggestions open; Tab inserts the selected completion. Shift+Enter inserts a newline (Alt+Enter is an alternative). Paste never sends automatically.\n\nUnbound input, mouse and paste in Editor/Terminal belong to the embedded program. F1 stays native there. The configured application leader remains available.\n\nThe active keybindings are shown above, including user overrides. Read-only details use j/k and PgUp/PgDn; Esc returns to the previous focus.`;
}
