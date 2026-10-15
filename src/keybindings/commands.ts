export const contexts = ["workspace", "search", "history", "prompt", "button", "transcript", "editor", "terminal", "none"] as const;
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
