export const contexts = ["workspace", "search", "history", "prompt", "button", "transcript", "editor", "terminal", "git", "git-prompt", "none"] as const;
export type KeyContext = typeof contexts[number];
export type KeyScope = KeyContext | "global" | "app" | "pty";
export type BindingInput = { keys: string; scope: KeyScope };
const key = (keys: string, scope: KeyScope = "global"): BindingInput => ({ keys, scope });

export const defaultBindings = {
  "app.detach": [key("<leader> c")],
  "focus.sidebar": [key("ctrl+]", "pty"), key("escape", "prompt"), key("<leader> w")],
  "focus.search": [key("ctrl+f", "app"), key("<leader> f")],
  "focus.prompt": [key("ctrl+e", "app"), key("<leader> p")],
  "focus.next": [key("tab", "app")],
  "focus.previous": [key("shift+tab", "app")],
  "focus.results": [key("enter", "search")],
  "search.clear": [key("escape", "search")],
  "view.agent": [key("<leader> 1")],
  "view.editor": [key("<leader> 2")],
  "view.git": [key("<leader> 3")],
  "view.terminal": [key("<leader> 4")],
  "terminal.new": [key("<leader> t")],
  "terminal.close": [key("<leader> x")],
  "terminal.previous": [key("<leader> [")],
  "terminal.next": [key("<leader> ]")],
  "terminal.scroll-up": [key("shift+pageup", "terminal")],
  "terminal.scroll-down": [key("shift+pagedown", "terminal")],
  "session.new": [key("n", "workspace")],
  "session.close": [key("x", "workspace")],
  "workspace.previous": [key("up", "workspace")],
  "workspace.next": [key("down", "workspace")],
  "workspace.first": [key("home", "workspace")],
  "workspace.last": [key("end", "workspace")],
  "history.refresh": [key("r", "history")],
  "history.open": [key("enter", "history")],
  "history.previous": [key("up", "history")],
  "history.next": [key("down", "history")],
  "history.first": [key("home", "history")],
  "history.last": [key("end", "history")],
  "agent.send": [key("enter", "prompt")],
  "git.ask": [key("a", "git")],
  "git.copy": [key("y", "git")],
  "git.submit": [key("enter", "git-prompt")],
  "git.cancel": [key("escape", "git-prompt")],
  "git.open": [key("enter", "git")],
  "git.back": [key("escape", "git")],
  "git.refresh": [key("r", "git")],
  "git.more": [key("plus", "git")],
  "git.previous": [key("up", "git"), key("k", "git")],
  "git.next": [key("down", "git"), key("j", "git")],
  "git.first": [key("home", "git")],
  "git.last": [key("end", "git")],
  "git.page-up": [key("pageup", "git")],
  "git.page-down": [key("pagedown", "git")],
  "git.left": [key("left", "git")],
  "git.right": [key("right", "git")],
  "button.activate": [key("enter", "button"), key("space", "button")],
} satisfies Record<string, readonly BindingInput[]>;
export type CommandId = keyof typeof defaultBindings;
export const commandIds = Object.keys(defaultBindings) as CommandId[];
export function isCommand(value: string): value is CommandId { return Object.hasOwn(defaultBindings, value); }
export function inScope(scope: KeyScope, context: KeyContext): boolean {
  if (scope === "global") return true;
  if (scope === "pty") return context === "editor" || context === "terminal";
  if (scope === "app") return context !== "editor" && context !== "terminal";
  return scope === context;
}
