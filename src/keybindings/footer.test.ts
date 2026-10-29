import { expect, test } from "bun:test";
import { defaultKeymap, parseKeymap } from "./config.ts";
import type { CommandId, KeyContext } from "./commands.ts";
import { footerKeyHint } from "./footer.ts";
import { expectOk } from "../testing/results.ts";

const defaults = defaultKeymap();

test.each([
  ["workspace.previous", "search"],
  ["workspace.next", "workspace"],
  ["workspace.open", "workspace"],
  ["workspace.first", "workspace"],
  ["workspace.half-page-down", "search"],
  ["completion.next", "prompt-completion"],
  ["completion.previous", "prompt-completion"],
  ["completion.dismiss", "prompt-completion"],
  ["agent.clear", "prompt"],
  ["agent.clear", "prompt-completion"],
  ["agent.history-previous", "prompt"],
  ["agent.history-next", "prompt"],
  ["git.clear", "git-prompt"],
  ["git.search-clear", "git-search"],
  ["search.clear", "search"],
  ["history.open", "history"],
  ["history.dismiss", "history-search"],
  ["monitor.half-page-down", "monitor"],
  ["dashboard.next", "dashboard-tabs"],
  ["model.next", "model-search"],
  ["accounts.dismiss", "accounts-input"],
  ["accounts.next", "accounts-search"],
  ["terminal.scroll-up", "terminal"],
  ["transcript.next", "transcript"],
  ["transcript.right", "transcript-text"],
  ["transcript.visual", "transcript-text"],
  ["transcript.visual-line", "transcript-text"],
  ["transcript.copy", "transcript-visual"],
  ["git.next", "git-search"],
  ["git.cancel", "git-prompt"],
  ["focus.next", "git"],
  ["dialog.dismiss", "dialog"],
] satisfies [CommandId, KeyContext][])(
  "%s default %s actions are omitted only from footers",
  (command, context) => {
    // Default list/input/body actions remain in actual keymaps and full Help.
    const key = defaults.hint(command, context);

    // Apply compactness only to footer hints.
    const hint = footerKeyHint(command, context, key);

    // Bindings exist without consuming footer space.
    expect(key).not.toBe("");
    expect(hint).toBe("");
    expect(defaults.hint(command, context)).toBe(key);
  },
);

test("Button Enter and Space alternatives are omitted together from footers", () => {
  // Buttons hint all alternatives rather than one key.
  const key = defaults.hints("button.activate", "button");

  // Alternative combinations follow the same omission policy as single defaults.
  const hint = footerKeyHint("button.activate", "button", key);

  // Preserve activation while removing routine guidance.
  expect(key).toBe("<CR>/<Space>");
  expect(hint).toBe("");
});

test("User-remapped navigation remains in footers despite being routine", () => {
  // Users replacing default l with q must see their actual overrides.
  const map = expectOk(
    parseKeymap({ bindings: { "dashboard.next": [{ keys: "q", scope: "dashboard-tabs" }] } }),
  );

  // Pass overrides through the same footer policy.
  const hint = footerKeyHint(
    "dashboard.next",
    "dashboard-tabs",
    map.hint("dashboard.next", "dashboard-tabs"),
  );

  // Hide default hints only; never erase overrides or restore defaults.
  expect(hint).toBe("q");
  expect(map.bound("q", "dashboard-tabs")).toBe(true);
});

test.each([
  ["agent.send", "prompt"],
  ["agent.newline", "prompt"],
  ["agent.interrupt", "prompt"],
  ["git.submit", "git-prompt"],
  ["git.newline", "git-prompt"],
] satisfies [CommandId, KeyContext][])(
  "%s hints stay omitted from footers even when remapped",
  (command, context) => {
    // Submit, newline, and interrupt hints are omitted regardless of configuration.
    const map = expectOk(
      parseKeymap({ bindings: { [command]: [{ keys: "alt+z", scope: context }] } }),
    );

    // Compact only footers while retaining actual overridden bindings.
    const key = map.hint(command, context);
    const hint = footerKeyHint(command, context, key);

    // Hidden hints must not disable functionality.
    expect(key).toBe("<M-z>");
    expect(hint).toBe("");
    expect(map.bound("alt+z", context)).toBe(true);
  },
);

test.each([
  ["sidebar.toggle", "prompt"],
  ["tab.new", "terminal"],
  ["output.read", "prompt"],
  ["completion.accept", "prompt-completion"],
  ["transcript.enter", "transcript"],
  ["transcript.fold", "transcript"],
  ["transcript.copy", "transcript-text"],
  ["history.preview", "history"],
  ["model.select", "model"],
  ["model.effort-more", "model"],
  ["git.open", "git"],
  ["git.refs", "git"],
  ["git.reflog", "git"],
  ["git.preview", "git-search"],
  ["git.change-session", "git-prompt"],
  ["accounts.rename", "accounts"],
  ["accounts.browser", "accounts"],
  ["accounts.copy-url", "accounts"],
  ["accounts.copy-code", "accounts"],
] satisfies [CommandId, KeyContext][])(
  "%s app-specific actions remain in %s footers",
  (command, context) => {
    // Non-navigation actions stay discoverable even with identical Enter/Ctrl keys.
    const key = defaults.hint(command, context);

    // Apply policy by command meaning, not wholesale physical-key suppression.
    const hint = footerKeyHint(command, context, key);

    // Contextual preview, folding, filtering, and application actions remain visible.
    expect(key).not.toBe("");
    expect(hint).toBe(key);
  },
);
