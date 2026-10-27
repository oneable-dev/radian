import { expect, test } from "bun:test";
import { defaultKeymap, parseKeymap } from "./config.ts";
import { keymapHelp } from "./help.ts";
import { expectOk } from "../testing/results.ts";

test.each(["monitor", "monitor-search"] as const)(
  "%s help omits removed preview actions while retaining candidate jumps",
  (context) => {
    // Session monitoring is list-only; History retains its independent preview command.
    const keymap = defaultKeymap();

    // Help follows the real configured actions in either monitor focus context.
    const help = keymapHelp(keymap, context, (command) => command.startsWith("monitor."));

    // Obsolete preview shortcuts must not remain discoverable or consume input.
    expect(help).not.toMatch(/preview|<C-o>/iu);
    expect(help).toContain("<C-d>");
    expect(help).toContain("<C-u>");
    for (const key of ["ctrl+o", "pageup", "pagedown"])
      expect(keymap.bound(key, context)).toBe(false);
    expect(keymap.hint("history.preview", "history")).toBe("<C-o>");
  },
);

test("Help shows registered navigation alternatives instead of bare arrows", () => {
  // Git registers arrows first and provides Vim alternatives on both axes.
  const keymap = defaultKeymap();

  // Include only commands available in the current Git context.
  const help = keymapHelp(keymap, "git", (command) => command.startsWith("git."));

  expect(help).toMatch(/^k \/ <C-p>\s+git previous$/mu);
  expect(help).toMatch(/^j \/ <C-n>\s+git next$/mu);
  expect(help).toMatch(/^h\s+git left$/mu);
  expect(help).toMatch(/^l\s+git right$/mu);
  expect(help).not.toMatch(/[↑↓←→]/u);
  expect(help).not.toContain("arrows");
});

test.each([
  ["darwin", "<D-c>", "<C-c>"],
  ["win32", "<C-c>", "<D-c>"],
  ["linux", "<C-c>", "<D-c>"],
] as const)("%s help advertises only its platform copy shortcut", (platform, shortcut, other) => {
  // Full Help must describe the actual OS-specific keymap rather than both platform conventions.
  const keymap = defaultKeymap(platform);

  const help = keymapHelp(keymap, "terminal", () => false);

  expect(help).toContain(`${shortcut} copies visible selected text`);
  expect(help).not.toContain(other);
});

test("Help derives selection copy hints from overrides and explains terminal forwarding", () => {
  // Selection help remains discoverable even when no text is currently selected.
  const keymap = expectOk(
    parseKeymap({ bindings: { "selection.copy": [{ keys: "ctrl+shift+c", scope: "selection" }] } }),
  );
  const disabled = expectOk(parseKeymap({ bindings: { "selection.copy": [] } }));

  const help = keymapHelp(keymap, "terminal", () => false);
  const disabledHelp = keymapHelp(disabled, "terminal", () => false);

  expect(help).toContain("<C-S-c> copies visible selected text");
  expect(help).not.toContain("<D-c>");
  expect(help).toContain("must be forwarded by the host terminal");
  expect(disabledHelp).toContain("Selection copying has no configured binding.");
  expect(disabledHelp).not.toContain("copies visible selected text");
});

test("Help retains custom modifiers and sequences while omitting default navigation hints", () => {
  // Honor arrow-only overrides while showing semantically distinct modifiers/sequences.
  const keymap = expectOk(
    parseKeymap({
      bindings: {
        "workspace.previous": [{ keys: "up", scope: "workspace" }],
        "workspace.next": [
          { keys: "down", scope: "workspace" },
          { keys: "ctrl+down", scope: "workspace" },
          { keys: "<leader> down", scope: "workspace" },
        ],
      },
    }),
  );

  // Help shares footer omission policy.
  const help = keymapHelp(keymap, "workspace", (command) => command.startsWith("workspace."));

  expect(help).not.toContain("workspace previous");
  expect(help).toContain("<C-Down> / <leader><Down>");
  expect(help).toContain("workspace next");
});
