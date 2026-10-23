import { formatKeys, isImplicitArrowBinding, type Keymap } from "./config.ts";
import { inScope, type CommandId, type KeyContext } from "./commands.ts";

const labels: Partial<Record<CommandId, string>> = {
  "app.detach": "Detach Radian (keep background work running)", "app.help": "Open application help", "notice.details": "Read the current notification",
  "sidebar.toggle": "Toggle the workspace popup", "focus.search": "Search workspaces", "focus.sidebar": "Open the workspace popup",
  "workspace.dismiss": "Close without switching workspaces", "workspace.search": "Search workspaces", "search.clear": "Clear the search query",
  "monitor.show": "Monitor working sessions and unread results", "monitor.open": "Open the selected session", "monitor.dismiss": "Close session monitoring", "monitor.preview": "Focus or toggle live preview",
  "focus.prompt": "Focus the Agent input", "focus.transcript": "Read the Agent conversation", "focus.next": "Next focus target", "focus.previous": "Previous focus target",
  "view.agent": "Show Agents", "view.editor": "Show Editor", "view.git": "Show Git", "view.terminal": "Show Terminal",
  "tab.new": "Create a session in Agents or a shell in Terminal",
  "tab.select-1": "Select tab 1", "tab.select-2": "Select tab 2", "tab.select-3": "Select tab 3",
  "tab.select-4": "Select tab 4", "tab.select-5": "Select tab 5", "tab.select-6": "Select tab 6",
  "tab.select-7": "Select tab 7", "tab.select-8": "Select tab 8", "tab.select-9": "Select tab 9",
  "agent.send": "Send input (steer at the next eligible turn when busy)", "agent.newline": "Insert a newline without sending", "agent.paste": "Paste text, images or files from the clipboard", "agent.inspect": "Inspect the attachment at the cursor",
  "git.refs": "Search refs and filter commit history", "git.reflog": "Search reflog events and preview target commits",
  "git.search": "Focus Git search", "git.search-clear": "Clear the Git search query", "git.preview": "Focus or toggle reflog preview",
  "git.change-session": "Cycle the Git request target through this worktree's sessions and New session",
  "git.submit": "Send input with the frozen Git context", "git.newline": "Insert a newline without sending", "git.clear": "Clear the current prompt", "git.paste": "Paste from the clipboard", "git.inspect": "Inspect the attachment at the cursor",
  "history.show": "Open saved session history", "transcript.help": "Open conversation navigation help",
  "transcript.open-link": "Open the HTTP(S) link under the cursor in the default browser",
  "transcript.line-first-nonblank": "Move to the first nonblank character of the logical line",
  "transcript.copy": "Copy section/selection, or start a yank operator in Text",
  "transcript.count": "Start/extend a motion or yank count",
  "transcript.inner-object": "Select/yank an inner text object (word, paragraph, quote or bracket)",
  "transcript.around-object": "Select/yank a text object including surrounding whitespace/delimiters",
  "transcript.find-forward": "Find the next literal character on the logical line",
  "transcript.find-backward": "Find the previous literal character on the logical line",
  "transcript.search-forward": "Search forward in the current reading section",
  "transcript.search-backward": "Search backward in the current reading section",
  "transcript.search-submit": "Accept the literal search and reveal its match",
  "transcript.search-cancel": "Cancel unsubmitted search without moving the cursor",
  "transcript.search-clear": "Clear only the transcript search query",
  "dashboard.show": "Open Agent usage dashboard", "dashboard.dismiss": "Close Agent dashboard", "dashboard.refresh": "Refresh saved statistics",
};
export function keymapHelp(keymap: Keymap, context: KeyContext, available: (command: CommandId) => boolean): string {
  const rows = (global: boolean): string => {
    const groups = new Map<CommandId, string[]>();
    for (const binding of keymap.bindings) {
      const common = binding.scope === "global" || binding.scope === "app" || binding.scope === "pty"
        || binding.command === "app.help" || binding.command === "focus.next" || binding.command === "focus.previous";
      if (common !== global || !inScope(binding.scope, context) || !available(binding.command) || isImplicitArrowBinding(binding)) continue;
      const keys = groups.get(binding.command) ?? [];
      const key = formatKeys(binding.displayKeys);
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
  return `Current context: ${context}\n<leader>: ${formatKeys(keymap.leader)}\n\n${rows(false)}\n\nApplication shortcuts\n\n${rows(true)}\n\nInput ownership\n\n<CR> sends the current Agent input, even with suggestions open; <Tab> inserts the selected completion. <S-CR> inserts a newline (<M-CR> is an alternative). Paste never sends automatically.\n\nUnbound input, mouse and paste in Editor/Terminal belong to the embedded program. <F1> stays native there. The configured application leader remains available.\n\nThe active keybindings are shown above, including user overrides. Read-only details use j/k and <PageUp>/<PageDown>; <Esc> returns to the previous focus.`;
}
