import { expect, test } from "bun:test";
import { defaultKeymap, parseKeymap } from "./config.ts";
import { inScope, type CommandId, type KeyContext } from "./commands.ts";
import { expectOk } from "../testing/results.ts";

const commandFor = (context: KeyContext, key: string): CommandId | undefined => defaultKeymap().bindings.find(binding =>
  binding.keys.length === 1 && binding.keys[0] === key && inScope(binding.scope, context))?.command;

test.each([
  ["workspace", "workspace"], ["history", "history"], ["monitor", "monitor"], ["model", "model"], ["accounts", "accounts"],
  ["extension", "extension"], ["extension-body", "extension"],
  ["dialog", "dialog"], ["git", "git"], ["git-search", "git"], ["transcript", "transcript"], ["transcript-text", "transcript"], ["transcript-visual", "transcript"],
] as const)("%s Ctrl+D/U routes to %s half-page commands", (context, family) => {
  // Lists and bodies share key names while surface owners determine behavior.
  const down = commandFor(context, "ctrl+d"), up = commandFor(context, "ctrl+u");

  // No surface maps jumps to single-item navigation or input editing.
  expect(down).toBe(`${family}.half-page-down`); expect(up).toBe(`${family}.half-page-up`);
});

test.each([
  ["workspace", "workspace.previous", "workspace.next"], ["search", "workspace.previous", "workspace.next"],
  ["history", "history.previous", "history.next"], ["history-search", "history.previous", "history.next"],
  ["monitor", "monitor.previous", "monitor.next"], ["monitor-search", "monitor.previous", "monitor.next"],
  ["model", "model.previous", "model.next"], ["model-search", "model.previous", "model.next"],
  ["accounts", "accounts.previous", "accounts.next"], ["accounts-search", "accounts.previous", "accounts.next"],
  ["extension", "extension.previous", "extension.next"], ["extension-search", "extension.previous", "extension.next"], ["extension-body", "extension.previous", "extension.next"],
  ["model-effort", "model.effort-less", "model.effort-more"], ["dialog", "dialog.previous", "dialog.next"],
  ["git", "git.previous", "git.next"], ["git-search", "git.previous", "git.next"],
  ["transcript", "transcript.previous", "transcript.next"], ["transcript-text", "transcript.up", "transcript.down"],
  ["transcript-visual", "transcript.up", "transcript.down"],
] as const)("%s Ctrl+N/P executes the same commands as existing directional navigation", (context, previous, next) => {
  // Ctrl+N/P are required defaults, not fallbacks for unavailable Vim keys.
  const up = commandFor(context, "ctrl+p"), down = commandFor(context, "ctrl+n");

  // Choose previous/next actions according to focused tabs, bodies, or results.
  expect(up).toBe(previous); expect(down).toBe(next);
});

test.each(["editor", "terminal", "prompt", "prompt-completion", "extension-input"] as const)("%s Ctrl+D/U preserves native input ownership", context => {
  // Search interception policy must not affect ordinary prompts or embedded programs.
  const map = defaultKeymap();

  expect(map.bound("ctrl+d", context)).toBe(false); expect(map.bound("ctrl+u", context)).toBe(false);
});

test.each([["search", "workspace"], ["history-search", "history"], ["monitor-search", "monitor"], ["model-search", "model"], ["accounts-search", "accounts"], ["extension-search", "extension"]] as const)("%s Ctrl+D/U jumps %s results and Ctrl+C clears search", (context, family) => {
  // Forward half-page actions to owned results without editing search text.
  const down = commandFor(context, "ctrl+d"), up = commandFor(context, "ctrl+u");

  expect(down).toBe(`${family}.half-page-down`); expect(up).toBe(`${family}.half-page-up`);
  expect(commandFor(context, "ctrl+c")).toBe("search.clear"); expect(commandFor(context, "ctrl+l")).toBeUndefined();
  expect(defaultKeymap().hints("search.clear", context)).toBe("<C-c>");
});

test.each([["workspace", "workspace.search"], ["monitor", "monitor.search"], ["history", "history.search"],
  ["model", "model.search"], ["accounts", "accounts.search"], ["messages", "messages.search"], ["extension", "extension.search"]] as const)("%s returns to search with configurable slash and clears query from results", (context, command) => {
  // Returning to search and clearing from results use registered commands, never widget-local key handlers.
  expect(commandFor(context, "/")).toBe(command); expect(commandFor(context, "ctrl+c")).toBe("search.clear");
  const map = expectOk(parseKeymap({ bindings: { [command]: [{ keys: "ctrl+f", scope: context }] } }));

  // Explicit remaps replace the default slash binding without changing literal search input.
  expect(map.bound("/", context)).toBe(false); expect(map.hint(command, context)).toBe("<C-f>");
});

test("Git search provides default navigation/clearing while keeping ordinary characters literal", () => {
  // Git modal keys divide ownership from main navigation and Agent prompts.
  const map = defaultKeymap();

  expect(commandFor("git-search", "ctrl+n")).toBe("git.next"); expect(commandFor("git-search", "ctrl+p")).toBe("git.previous");
  expect(commandFor("git-search", "ctrl+c")).toBe("git.search-clear"); expect(commandFor("git-search", "ctrl+l")).toBeUndefined();
  for (const key of ["h", "j", "k", "l", "a", "y", "b"]) expect(commandFor("git-search", key)).toBeUndefined();
  expect(commandFor("git", "b")).toBe("git.refs"); expect(commandFor("git", "ctrl+r")).toBe("git.reflog"); expect(commandFor("git", "r")).toBe("git.refresh");
  expect(map.hint("git.search-clear", "git-search")).toBe("<C-c>");
});

test("Git modal/search-clear overrides replace default bindings", () => {
  // Direct modal interception would bypass user keymap overrides.
  const map = expectOk(parseKeymap({ bindings: { "git.refs": [{ keys: "v", scope: "git" }],
    "git.reflog": [{ keys: "shift+r", scope: "git" }], "git.search-clear": [{ keys: "ctrl+g", scope: "git-search" }] } }));

  expect(map.bound("b", "git")).toBe(false); expect(map.bound("ctrl+r", "git")).toBe(false); expect(map.bound("ctrl+c", "git-search")).toBe(false);
  expect(map.hint("git.refs", "git")).toBe("v"); expect(map.hint("git.reflog", "git")).toBe("R");
  expect(map.hint("git.search-clear", "git-search")).toBe("<C-g>");
});

test("Transcript Shift+G follows latest output from sections and reaches section ends from bodies", () => {
  // The same Vim key has a different owner in section navigation and read-only source navigation.
  const map = defaultKeymap();

  // Sections advertise the new bottom shortcut while text/visual keep their source cursor bindings.
  expect(commandFor("transcript", "shift+g")).toBe("transcript.latest");
  expect(commandFor("transcript", "end")).toBe("transcript.last");
  expect(commandFor("transcript", "ctrl+end")).toBe("transcript.latest");
  for (const context of ["transcript-text", "transcript-visual"] as const) {
    expect(commandFor(context, "shift+g")).toBe("transcript.buffer-end");
    expect(commandFor(context, "ctrl+end")).toBe("transcript.buffer-end");
    expect(map.hint("transcript.latest", context)).toBe("ge");
  }
  expect(map.hint("transcript.latest", "transcript")).toBe("G");
  for (const context of ["prompt", "prompt-completion", "editor", "terminal"] as const) {
    expect(map.bound("shift+g", context)).toBe(false);
    expect(map.bound("ctrl+end", context)).toBe(false);
  }
});

test("Agent/Git prompt Ctrl+C clears respective drafts while respecting overrides", () => {
  // Direct shared-input interception would prevent replacing default clearing bindings.
  const map = expectOk(parseKeymap({ bindings: { "git.clear": [{ keys: "ctrl+g", scope: "git-prompt" }] } }));

  // Route both defaults to clearing while explicit overrides replace defaults.
  expect(commandFor("prompt", "ctrl+c")).toBe("agent.clear"); expect(commandFor("git-prompt", "ctrl+c")).toBe("git.clear");
  expect(map.bound("ctrl+c", "git-prompt")).toBe(false); expect(map.hint("git.clear", "git-prompt")).toBe("<C-g>");
});

test("Workspace search clearing and custom jumps never collide with default jump bindings", () => {
  // Jump overrides are separate from clearing and replace that command's defaults.
  const map = expectOk(parseKeymap({ bindings: { "workspace.half-page-down": [{ keys: "ctrl+y", scope: "workspace" }] } }));

  expect(commandFor("search", "ctrl+u")).toBe("workspace.half-page-up");
  expect(map.hint("workspace.half-page-down", "workspace")).toBe("<C-y>");
  expect(map.bound("ctrl+d", "workspace")).toBe(false); expect(map.bound("ctrl+d", "search")).toBe(false);
});
