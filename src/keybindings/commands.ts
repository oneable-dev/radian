export const contexts = ["workspace", "search", "history", "session-tabs", "prompt", "prompt-completion", "button", "transcript", "transcript-text", "transcript-visual", "editor", "terminal", "git", "git-prompt", "none"] as const;
export type KeyContext = typeof contexts[number];
export type KeyScope = KeyContext | "global" | "app" | "pty";
export type BindingInput = { keys: string; scope: KeyScope };
const key = (keys: string, scope: KeyScope = "global"): BindingInput => ({ keys, scope });

const transcriptContexts = ["transcript", "transcript-text", "transcript-visual"] as const;
const transcriptKeys = (keys: string): BindingInput[] => transcriptContexts.map((scope) => key(keys, scope));
const textKeys = (...keys: string[]): BindingInput[] => keys.flatMap((keys) => [key(keys, "transcript-text"), key(keys, "transcript-visual")]);
const tabContexts = contexts.filter((context) => context !== "editor" && context !== "terminal" && context !== "prompt-completion");

export const defaultBindings = {
  "app.detach": [key("<leader> c")],
  "sidebar.toggle": [key("<leader> b")],
  "focus.sidebar": [key("ctrl+]", "pty"), key("escape", "prompt"), key("escape", "session-tabs"), key("<leader> w")],
  "focus.search": [key("ctrl+f", "app"), key("<leader> f")],
  "focus.prompt": [key("ctrl+e", "app"), key("<leader> p"), key("i", "transcript"), key("i", "transcript-text")],
  "focus.transcript": [key("ctrl+t", "app"), key("<leader> o")],
  "focus.next": tabContexts.map((context) => key("tab", context)),
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
  "session.new": [key("n", "session-tabs")],
  "session.close": [key("x", "session-tabs")],
  "session.previous": [key("h", "session-tabs"), key("left", "session-tabs")],
  "session.next": [key("l", "session-tabs"), key("right", "session-tabs")],
  "session.first": [key("home", "session-tabs")],
  "session.last": [key("end", "session-tabs")],
  "workspace.open": [key("enter", "workspace")],
  "workspace.previous": [key("k", "workspace"), key("up", "workspace")],
  "workspace.next": [key("j", "workspace"), key("down", "workspace")],
  "workspace.first": [key("home", "workspace")],
  "workspace.last": [key("end", "workspace")],
  "history.refresh": [key("r", "history")],
  "history.open": [key("enter", "history")],
  "history.previous": [key("k", "history"), key("up", "history")],
  "history.next": [key("j", "history"), key("down", "history")],
  "history.first": [key("home", "history")],
  "history.last": [key("end", "history")],
  "agent.send": [key("enter", "prompt")],
  "completion.next": [key("ctrl+n", "prompt-completion")],
  "completion.previous": [key("ctrl+p", "prompt-completion")],
  "completion.accept": [key("tab", "prompt-completion"), key("enter", "prompt-completion")],
  "completion.dismiss": [key("escape", "prompt-completion")],
  "transcript.previous": [key("k", "transcript"), key("up", "transcript")],
  "transcript.next": [key("j", "transcript"), key("down", "transcript")],
  "transcript.first": [key("home", "transcript"), key("g g", "transcript")],
  "transcript.last": [key("end", "transcript"), key("shift+g", "transcript")],
  "transcript.enter": [key("enter", "transcript")],
  "transcript.back": [key("escape", "transcript"), key("escape", "transcript-text"), key("escape", "transcript-visual")],
  "transcript.fold": [...transcriptKeys("ctrl+o"), ...transcriptKeys("z a")],
  "transcript.fold-all": transcriptKeys("z m"),
  "transcript.unfold-all": transcriptKeys("z r"),
  "transcript.latest": transcriptKeys("g e"),
  "transcript.copy": transcriptKeys("y"),
  "transcript.copy-section": transcriptKeys("shift+y"),
  "transcript.help": transcriptKeys("f1"),
  "transcript.left": textKeys("h", "left"),
  "transcript.right": textKeys("l", "right"),
  "transcript.up": textKeys("k", "up"),
  "transcript.down": textKeys("j", "down"),
  "transcript.word-next": textKeys("w"),
  "transcript.word-previous": textKeys("b"),
  "transcript.line-start": textKeys("0", "home"),
  "transcript.line-end": textKeys("$", "shift+$", "shift+4", "end"),
  "transcript.buffer-start": textKeys("g g", "ctrl+home"),
  "transcript.buffer-end": textKeys("shift+g", "ctrl+end"),
  "transcript.visual": textKeys("v"),
  "transcript.visual-line": textKeys("shift+v"),
  "transcript.half-page-up": transcriptKeys("ctrl+u"),
  "transcript.half-page-down": transcriptKeys("ctrl+d"),
  "transcript.page-up": transcriptKeys("pageup"),
  "transcript.page-down": transcriptKeys("pagedown"),
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
  "git.left": [key("h", "git"), key("left", "git")],
  "git.right": [key("l", "git"), key("right", "git")],
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
