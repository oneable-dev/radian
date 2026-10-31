import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultKeymap, loadKeymap, parseKeymap } from "./config.ts";
import { expectError, expectOk } from "../testing/results.ts";

test("Default leader is Ctrl+Space and Ctrl+C never quits the app", () => {
  const map = defaultKeymap();
  expect(map.leader).toEqual(["ctrl+space"]);
  expect(map.hint("app.detach", "terminal")).toBe("<leader>d");
  expect(
    map.bindings.some(
      (binding) => binding.command === "app.detach" && binding.keys.includes("ctrl+c"),
    ),
  ).toBe(false);
  expect(map.hint("focus.search", "editor")).toBe("");
  expect(map.hint("focus.search", "search")).toBe("");
  expect(map.hint("sidebar.toggle", "workspace")).toBe("<leader>b");
  expect(map.hint("sidebar.toggle", "editor")).toBe("<leader>b");
  expect(map.bound("ctrl+b", "prompt")).toBe(false);
});

test("History has no default shortcut while explicit user mappings remain available", () => {
  // History opens from the prompt unless a user deliberately configures a shortcut.
  const defaults = defaultKeymap();
  const custom = expectOk(parseKeymap({ bindings: { "history.show": ["<leader> h"] } }));

  // Removing the default must free the sequence in both app-owned and native input contexts.
  for (const context of ["prompt", "transcript", "editor", "terminal", "none"] as const) {
    expect(defaults.hints("history.show", context)).toBe("");
    expect(custom.hints("history.show", context)).toBe("<leader>h");
  }

  expect(defaults.bindings.some((binding) => binding.command === "history.show")).toBe(false);
  expect(defaults.bindings.some((binding) => binding.keys.join(" ") === "ctrl+space h")).toBe(
    false,
  );
});

test("Reader defaults omit transcript search without removing popup search commands", () => {
  // Transcript readers no longer own search keys, while searchable popups keep their command map.
  const map = defaultKeymap();
  const formerSearchKeys = [
    "/",
    "?",
    "shift+?",
    "shift+/",
    "n",
    "shift+n",
    "*",
    "shift+*",
    "shift+8",
    "#",
    "shift+#",
    "shift+3",
  ];

  for (const context of ["transcript", "transcript-text", "transcript-visual"] as const) {
    for (const key of formerSearchKeys) {
      expect(map.bound(key, context)).toBe(false);
    }
  }

  expect(map.bindings.some((binding) => binding.command.startsWith("transcript.search"))).toBe(
    false,
  );
  expect(map.hint("workspace.search", "workspace")).toBe("/");
  expect(map.hint("history.search", "history")).toBe("/");
  expect(map.hint("search.clear", "search")).toBe("<C-c>");
});

test.each([
  ["darwin", "<D-c>", "super+c", "ctrl+c"],
  ["win32", "<C-c>", "ctrl+c", "super+c"],
  ["linux", "<C-c>", "ctrl+c", "super+c"],
] as const)(
  "%s copy defaults use only %s in the transient selection scope",
  (platform, hint, copyKey, nativeKey) => {
    // Platform-specific copy shortcuts must not reserve the other platform's key.
    const map = defaultKeymap(platform);

    const selection = map.hints("selection.copy", "selection");

    expect(selection).toBe(hint);
    expect(map.bound(copyKey, "selection")).toBe(true);
    expect(map.bound(nativeKey, "selection")).toBe(false);
    expect(map.bound("ctrl+c", "terminal")).toBe(false);
    expect(map.hints("selection.copy", "prompt")).toBe("");
    expect(map.hints("agent.clear", "prompt")).toBe("<C-c>");
    expect(map.hints("search.clear", "search")).toBe("<C-c>");
  },
);

test("Default keymaps detect the TUI process platform", () => {
  // Production callers do not have to pass the OS explicitly.
  const map = defaultKeymap();

  const hint = map.hints("selection.copy", "selection");

  expect(hint).toBe(process.platform === "darwin" ? "<D-c>" : "<C-c>");
});

test.each(["darwin", "win32", "linux"] as const)(
  "%s selection copy overrides replace platform defaults",
  (platform) => {
    // Explicit mappings remain authoritative for SSH clients and user preferences.
    const map = expectOk(
      parseKeymap(
        { bindings: { "selection.copy": [{ keys: "alt+c", scope: "selection" }] } },
        platform,
      ),
    );
    const disabled = expectOk(parseKeymap({ bindings: { "selection.copy": [] } }, platform));

    const hint = map.hints("selection.copy", "selection");

    expect(hint).toBe("<M-c>");
    expect(map.bound("ctrl+c", "selection")).toBe(false);
    expect(map.bound("super+c", "selection")).toBe(false);
    expect(disabled.hints("selection.copy", "selection")).toBe("");
  },
);

test("Workspace defaults use only leader+b and reading surfaces own Ctrl+F/B", () => {
  const map = defaultKeymap();
  for (const context of [
    "prompt",
    "editor",
    "terminal",
    "transcript",
    "transcript-text",
    "workspace",
    "search",
  ] as const) {
    expect(map.hint("sidebar.toggle", context)).toBe("<leader>b");
    expect(map.hints("focus.search", context)).toBe("");
    expect(map.hints("focus.sidebar", context)).toBe("");
  }

  expect(map.bound("ctrl+f", "prompt")).toBe(false);
  expect(map.bound("ctrl+f", "terminal")).toBe(false);
  expect(map.hint("transcript.page-down", "transcript")).toBe("<C-f>");
  expect(map.hint("transcript.page-up", "transcript-text")).toBe("<C-b>");
  expect(map.hint("terminal.copy-page-down", "terminal-copy")).toBe("<C-f>");
});

test.each(["ctrl+b", "ctrl+f"])(
  "An explicit %s leader wins optional default page chords without losing PageUp/Down",
  (leader) => {
    const map = expectOk(parseKeymap({ leader }));
    const command = leader === "ctrl+b" ? "transcript.page-up" : "transcript.page-down";

    expect(map.hints(command, "transcript")).toBe(leader === "ctrl+b" ? "<PageUp>" : "<PageDown>");
    expect(map.hint("sidebar.toggle", "transcript")).toBe("<leader>b");
    expect(
      expectError(
        parseKeymap({ leader, bindings: { [command]: [{ keys: leader, scope: "transcript" }] } }),
      ).code,
    ).toBe("INVALID_INPUT");
  },
);

test("Session creation defaults only to leader+c while Ctrl+N recalls Agent input history or stays PTY-owned", () => {
  // Inputs and empty content views share the same creation sequence.
  const map = defaultKeymap();

  // Verify hints alongside actual binding configuration.
  for (const context of [
    "prompt",
    "terminal",
    "button",
    "none",
    "session-tabs",
    "terminal-tabs",
  ] as const) {
    expect(map.hints("tab.new", context)).toBe("<leader>c");
  }

  // Strip-local aliases remain configurable but no longer have defaults.
  expect(map.hint("session.new", "session-tabs")).toBe("");
  expect(map.hints("agent.history-next", "prompt")).toBe("<C-n>");
  expect(map.bound("ctrl+n", "terminal")).toBe(false);
  expect(map.hints("session.next", "session-tabs")).toBe("");
  expect(map.hints("terminal.tab-next", "terminal-tabs")).toBe("");
});

test("Tab close can be remapped or disabled without resurrecting per-view defaults", () => {
  // A shared close command must replace both previous screen-specific bindings.
  const map = expectOk(parseKeymap({ bindings: { "tab.close": ["alt+w"] } }));
  const disabled = expectOk(parseKeymap({ bindings: { "tab.close": [] } }));

  // Both app-owned and native inputs expose the same configured action.
  for (const context of ["prompt", "terminal", "transcript", "terminal-copy", "button"] as const) {
    expect(map.hint("tab.close", context)).toBe("<M-w>");
    expect(disabled.hint("tab.close", context)).toBe("");
    expect(map.hint("session.close", context)).toBe("");
    expect(map.hint("terminal.close", context)).toBe("");
  }
});

test("Output navigation uses only leader+[ and removes auxiliary input-return/terminal-toggle defaults", () => {
  // Enter app output navigation through the same command on every screen.
  const map = defaultKeymap();

  for (const context of ["prompt", "terminal"] as const) {
    expect(map.hints("output.read", context)).toBe("<leader>[");
    expect(map.bound("ctrl+t", context)).toBe(false);
    expect(map.bound("ctrl+e", context)).toBe(false);
  }

  expect(map.hints("focus.transcript", "prompt")).toBe("");
  expect(map.hints("terminal.previous", "terminal")).toBe("");
  expect(map.hints("terminal.next", "terminal")).toBe("");
  expect(map.bindings.some((binding) => binding.displayKeys.join(" ") === "<leader> o")).toBe(
    false,
  );
});

test("Creation, detach, usage, and tab defaults never collide and input focus has no default binding", () => {
  // Shared actions receive one leader sequence per command regardless of input context.
  const map = defaultKeymap();

  for (const context of [
    "prompt",
    "terminal",
    "session-tabs",
    "terminal-tabs",
    "transcript",
    "terminal-copy",
  ] as const) {
    expect(map.hints("tab.new", context)).toBe("<leader>c");
    expect(map.hints("tab.close", context)).toBe("<leader>x");
    expect(map.hints("tab.next", context)).toBe("<leader>n");
    expect(map.hints("tab.previous", context)).toBe("<leader>p");
    expect(map.hints("app.detach", context)).toBe("<leader>d");
    expect(map.hints("dashboard.show", context)).toBe("<leader>u");
    expect(map.hints("focus.prompt", context)).toBe("");
  }
});

test("Arrow bindings remain active while hints show alternative navigation keys only", () => {
  // Search and Git register arrows first but must hint their alternatives.
  const map = defaultKeymap();

  // Hint queries never change bindings used by actual routing.
  const searchHints = [
    map.hint("workspace.previous", "search"),
    map.hint("workspace.next", "search"),
  ];
  const listHints = map.hints("workspace.previous", "workspace");

  expect(searchHints).toEqual(["<C-p>", "<C-n>"]);
  expect(listHints).toBe("k/<C-p>");
  expect(map.hints("git.previous", "git")).toBe("k/<C-p>");
  expect(map.hints("session.next", "session-tabs")).toBe("");
  expect(map.bound("up", "search")).toBe(true);
  expect(map.bound("down", "workspace")).toBe(true);
});

test("Arrow-only overrides omit hints while modified arrows and sequences remain visible", () => {
  // Honor overrides without hiding Ctrl+arrows or leader sequences.
  const map = expectOk(
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

  // Arrow-only commands must not hint nonexistent default alternatives.
  const previous = map.hint("workspace.previous", "workspace");
  const next = map.hints("workspace.next", "workspace");

  expect(previous).toBe("");
  expect(map.hints("workspace.previous", "workspace")).toBe("");
  expect(next).toBe("<C-Down>/<leader><Down>");
  expect(map.hint("workspace.next", "workspace")).toBe("<C-Down>");
  expect(map.bound("up", "workspace")).toBe(true);
  expect(map.bound("ctrl+p", "workspace")).toBe(false);
});

test("View letters and internal tab numbers/creation keys can be independently remapped or disabled", () => {
  // Shared tab commands must participate in the same validation and override path as views.
  const map = expectOk(
    parseKeymap({
      leader: "ctrl+b",
      bindings: {
        "tab.select-2": ["<leader> z"],
        "tab.new": [],
        "view.editor": ["<leader> v"],
      },
    }),
  );

  expect(map.hint("tab.select-2", "prompt")).toBe("<leader>z");
  expect(map.hint("tab.select-2", "terminal")).toBe("<leader>z");
  expect(map.hint("tab.new", "terminal")).toBe("");
  expect(map.hint("view.editor", "terminal")).toBe("<leader>v");
  expect(map.hint("view.terminal", "editor")).toBe("<leader>t");
  expect(map.hint("view.chat", "prompt")).toBe("<leader>m");
  expect(map.hint("view.chat", "editor")).toBe("<leader>m");
  expect(map.hint("view.chat", "terminal")).toBe("<leader>m");
  expect(map.bindings.some((binding) => binding.keys.join(" ") === "ctrl+b q")).toBe(false);
  expect(map.hint("terminal.new", "terminal")).toBe("");
});

test("CHAT keeps explicit legacy shortcuts and supports disabling its direct view command", () => {
  // Existing user mappings remain valid when the default CHAT letter changes.
  const legacy = expectOk(parseKeymap({ bindings: { "view.chat": ["<leader> q"] } }));
  const disabled = expectOk(parseKeymap({ bindings: { "view.chat": [] } }));

  // CHAT is still a direct view command, independent of the shared creation command.
  expect(legacy.hint("view.chat", "prompt")).toBe("<leader>q");
  expect(legacy.hint("tab.new", "prompt")).toBe("<leader>c");
  expect(disabled.hint("view.chat", "terminal")).toBe("");
  expect(disabled.hint("view.agent", "terminal")).toBe("<leader>a");
});

test("Enter routes through completion-aware submission while Tab routes only through insertion", () => {
  const map = defaultKeymap();

  expect(map.hints("agent.send", "prompt")).toBe("<CR>");
  expect(map.hints("agent.send", "prompt-completion")).toBe("<CR>");
  expect(map.hints("completion.accept", "prompt-completion")).toBe("<Tab>");
});

test("Key settings override or disable scoped defaults and update actual hints", () => {
  const map = expectOk(
    parseKeymap({
      leader: "ctrl+b",
      bindings: {
        "session.new": [{ keys: "s", scope: "workspace" }],
        "session.close": [],
        "app.detach": ["<leader> q"],
        "view.chat": [],
      },
    }),
  );
  expect(map.hint("session.new", "workspace")).toBe("s");
  expect(map.hint("session.new", "prompt")).toBe("");
  expect(map.hint("session.close", "workspace")).toBe("");
  expect(map.hint("app.detach", "editor")).toBe("<leader>q");
});

test.each([
  { leader: "" },
  { leader: "ctrl+unknown" },
  { timeoutMs: 0 },
  { bindings: { "unknown.action": [] } },
  { bindings: { "app.detach": null } },
  { bindings: { "app.detach": [{ keys: "x", scope: "unknown" }] } },
  { bindings: { "app.detach": ["ctrl+f"] } },
  { bindings: { "app.detach": ["ctrl+space"] } },
])(
  "Invalid settings and overlapping prefixes return errors instead of silently restoring defaults: %j",
  (config) => {
    expect(expectError(parseKeymap(config)).code).toBe("INVALID_INPUT");
  },
);

test("Explicit config reads distinguish missing files from malformed JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-keys-"));
  const path = join(directory, "keys.json");
  try {
    expect(expectError(await loadKeymap(path)).code).toBe("STORAGE_FAILED");
    await writeFile(path, "{");
    expect(expectError(await loadKeymap(path)).code).toBe("INVALID_INPUT");
    await writeFile(path, JSON.stringify({ leader: "ctrl+b" }));

    const map = expectOk(await loadKeymap(path));
    expect(map.leader).toEqual(["ctrl+b"]);
    expect(map.hint("app.detach", "none")).toBe("<leader>d");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
