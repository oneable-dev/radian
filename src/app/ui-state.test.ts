import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPreferences } from "../runtime/client.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { purgeUiState, retainedUiDrafts, UiStateStore, type UiState } from "./ui-state.ts";
import { restoreWorkViews } from "../runtime/work-view-preferences.ts";
import { withCleanupLock, writeCleanupLedger } from "../runtime/restore-state.ts";
import type { CleanupReceipt } from "../runtime/daemon-protocol.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "radian-ui-state-"));
  return {
    directory,
    first: new UiStateStore(directory, "terminal-one"),
    second: new UiStateStore(directory, "terminal-two"),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("First UI starts in CHAT without changing legacy preferences", async () => {
  // Legacy workspace state is an initial compatibility seed, not a shared UI owner.
  const app = await fixture();
  try {
    const defaults = defaultPreferences();
    defaults.selection.worktreeId = "repo:main";
    const original = structuredClone(defaults);

    const state = expectOk(await app.first.load(defaults));
    state.preferences.selection.worktreeId = "another-worktree";

    expect(state.view).toBe("chat");
    expect(state.chatSessionId).toBeNull();
    expect(defaults).toEqual(original);
  } finally {
    await app.close();
  }
});

test("UI state creates a fresh daemon directory before loading or saving under its lock", async () => {
  const app = await fixture();
  try {
    // UI persistence may run before a daemon has created its state directory.
    const first = new UiStateStore(join(app.directory, "fresh", "daemon"), "first");
    const direct = new UiStateStore(join(app.directory, "direct", "daemon"), "second");
    const state = expectOk(await first.load(defaultPreferences()));
    state.preferences.drafts.saved = "Fresh draft";

    expectOk(await first.save(state));
    expectOk(await direct.save(state));

    const loaded = expectOk(await direct.load(defaultPreferences()));
    expect(loaded.preferences.drafts.saved).toBe("Fresh draft");
    expect(loaded.view).toBe("chat");
  } finally {
    await app.close();
  }
});

test("A whole repository receipt scrubs UI-only owned worktrees and preserves other repositories", async () => {
  const app = await fixture();
  try {
    const state = expectOk(await app.first.load(defaultPreferences()));
    state.preferences.selection = {
      worktreeId: "only-ui-a",
      sessions: { "only-ui-a": "a", "only-ui-b": "b" },
    };
    state.preferences.workViews = {
      active: { "only-ui-a": "git", "only-ui-b": "editor" },
      agentScroll: {},
    };
    state.preferences.drafts = { a: "delete", b: "keep" };
    state.sessionScopes = { a: "only-ui-a", b: "only-ui-b" };
    state.worktreeRepositories = { "only-ui-a": "repo-a", "only-ui-b": "repo-b" };
    expectOk(await app.first.save(state));
    const receipt: CleanupReceipt = {
      token: "whole-ui-only",
      repositoryId: "repo-a",
      kind: "repository",
      worktrees: [{ id: "runtime-a", path: "/fixture/a" }],
      sessionIds: [],
      revision: 1,
      state: "fenced",
      updatedAt: 1,
    };

    expectOk(
      await withCleanupLock(app.directory, () =>
        writeCleanupLedger(app.directory, {
          version: 1,
          revision: 1,
          receipts: [receipt],
        }),
      ),
    );
    const report = expectOk(await purgeUiState(app.directory));

    expect(report.residuals).toEqual([]);
    const saved = JSON.parse(await readFile(app.first.file, "utf8")) as UiState;
    expect(saved.preferences.selection.worktreeId).toBeNull();
    expect(saved.preferences.workViews?.active).toEqual({ "only-ui-b": "editor" });
    expect(saved.preferences.drafts).toEqual({ b: "keep" });
    expect(saved.worktreeRepositories).toEqual({ "only-ui-b": "repo-b" });
    const navigation = JSON.parse(await readFile(join(app.directory, "ui", "last.json"), "utf8"));
    expect(navigation.selection.worktreeId).toBeNull();
  } finally {
    await app.close();
  }
});

test("Two terminals persist independent drafts and selected conversations", async () => {
  // Both windows share the same daemon directory but own different UI records.
  const app = await fixture();
  try {
    const first = expectOk(await app.first.load(defaultPreferences()));
    const second = expectOk(await app.second.load(defaultPreferences()));
    first.chatSessionId = "chat-one";
    first.preferences.drafts["same-conversation"] = "first unsent draft";
    second.chatSessionId = "chat-two";
    second.view = "editor";
    second.preferences.drafts["same-conversation"] = "second unsent draft";

    for (const result of await Promise.all([app.first.save(first), app.second.save(second)])) {
      expectOk(result);
    }
    const loadedFirst = expectOk(
      await new UiStateStore(app.directory, "terminal-one").load(defaultPreferences()),
    );
    const loadedSecond = expectOk(
      await new UiStateStore(app.directory, "terminal-two").load(defaultPreferences()),
    );

    expect(loadedFirst.chatSessionId).toBe("chat-one");
    expect(loadedFirst.preferences.drafts["same-conversation"]).toBe("first unsent draft");
    expect(loadedSecond.chatSessionId).toBe("chat-two");
    expect(loadedSecond.view).toBe("editor");
    expect(loadedSecond.preferences.drafts["same-conversation"]).toBe("second unsent draft");
  } finally {
    await app.close();
  }
});

test("A new terminal restores navigation but never another terminal's unsent draft", async () => {
  // A fresh window may follow the last view without joining its mutable input buffer.
  const app = await fixture();
  try {
    const state = expectOk(await app.first.load(defaultPreferences()));
    state.view = "git";
    state.chatSessionId = "chat-one";
    state.preferences.selection.worktreeId = "repo:feature";
    state.preferences.drafts["chat-one"] = "private unsent text";
    expectOk(await app.first.save(state));

    const restored = expectOk(await app.second.load(defaultPreferences()));

    expect(restored.view).toBe("git");
    expect(restored.chatSessionId).toBe("chat-one");
    expect(restored.preferences.selection.worktreeId).toBe("repo:feature");
    expect(restoreWorkViews(restored.preferences).active["repo:feature"]).toBe("git");
    expect(restored.preferences.drafts).toEqual({});
    expect(await readFile(join(app.directory, "ui", "last.json"), "utf8")).not.toContain(
      "private unsent text",
    );
  } finally {
    await app.close();
  }
});

test.each(["agent", "editor", "git", "terminal"] as const)(
  "Navigation seeds restore the actual %s work pane in a fresh terminal",
  async (view) => {
    // The app badge and the worktree-local pane must agree after restoring a navigation-only seed.
    const app = await fixture();
    try {
      const first = expectOk(await app.first.load(defaultPreferences()));
      first.view = view;
      first.preferences.selection.worktreeId = "repo:main";
      expectOk(await app.first.save(first));

      const restored = expectOk(await app.second.load(defaultPreferences()));

      expect(restored.view).toBe(view);
      expect(restoreWorkViews(restored.preferences).active["repo:main"]).toBe(view);
    } finally {
      await app.close();
    }
  },
);

test("Cold scopes retain local drafts until their authoritative session snapshot arrives", async () => {
  // Restoring a daemon's empty catalog must not erase a terminal's independent unsent draft.
  const app = await fixture();
  try {
    const state = expectOk(await app.first.load(defaultPreferences()));
    state.preferences.drafts.a = "first local draft";
    state.preferences.drafts.b = "unmapped legacy draft";
    state.sessionScopes = { a: "repo:main" };
    expectOk(await app.first.save(state));
    const restored = expectOk(await app.first.load(defaultPreferences()));

    expect([...retainedUiDrafts(restored, () => false)]).toEqual(["a", "b"]);
    expect([...retainedUiDrafts(restored, () => true)]).toEqual(["b"]);
    expect(restored.preferences.drafts.a).toBe("first local draft");
  } finally {
    await app.close();
  }
});

test("Queued saves capture their input and retain the latest client state", async () => {
  // Persistence must not observe later mutation while an earlier disk write waits.
  const app = await fixture();
  try {
    const state = expectOk(await app.first.load(defaultPreferences()));
    state.preferences.drafts.a = "earlier";
    const earlier = app.first.save(state);
    state.preferences.drafts.a = "latest";
    const latest = app.first.save(state);
    state.preferences.drafts.a = "not submitted for saving";

    expectOk(await earlier);
    expectOk(await latest);
    const restored = expectOk(await app.first.load(defaultPreferences()));

    expect(restored.preferences.drafts.a).toBe("latest");
  } finally {
    await app.close();
  }
});

test("Corrupt UI state is reported and never overwritten by fallback state", async () => {
  // Falling back to an empty draft must not erase a recoverable original record.
  const app = await fixture();
  try {
    const state = expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(state));
    await writeFile(app.first.file, "{broken");
    const reopened = new UiStateStore(app.directory, "terminal-one");

    const loaded = await reopened.load(defaultPreferences());
    const saved = await reopened.save(state);

    expect(expectError(loaded).code).toBe("INVALID_INPUT");
    expect(expectError(saved).code).toBe("INVALID_INPUT");
    expect(await readFile(app.first.file, "utf8")).toBe("{broken");
  } finally {
    await app.close();
  }
});

const deletedTree = "repo:feature";
const deletedSession = "feature-session";

function receipt(state: CleanupReceipt["state"], revision: number): CleanupReceipt {
  return {
    token: "cleanup-token-ui",
    repositoryId: "repo",
    kind: "worktrees",
    worktrees: [{ id: deletedTree, path: "/repo/feature" }],
    sessionIds: [deletedSession],
    revision,
    state,
    updatedAt: 0,
  };
}

async function recordCleanup(directory: string, revision: number, receipts: CleanupReceipt[]) {
  expectOk(
    await withCleanupLock(directory, () =>
      writeCleanupLedger(directory, { version: 1, revision, receipts }),
    ),
  );
}

// A UI that worked in the deleted worktree and also has CHAT and an unrelated worktree.
function mixedState(): UiState {
  const preferences = defaultPreferences();
  preferences.selection.worktreeId = deletedTree;
  preferences.selection.sessions = { [deletedTree]: deletedSession, "repo:main": "main-session" };
  preferences.drafts = {
    [deletedSession]: "deleted draft",
    "chat-session": "CHAT draft",
    "main-session": "main draft",
  };
  preferences.workViews = {
    active: { [deletedTree]: "git", "repo:main": "editor" },
    agentScroll: { [deletedSession]: 3, "main-session": 4 },
  };
  preferences.terminalViews = { active: [deletedTree], selected: { [deletedTree]: "t1" } };
  return {
    version: 1,
    view: "chat",
    chatSessionId: "chat-session",
    preferences,
    sessionScopes: {
      [deletedSession]: deletedTree,
      "chat-session": "chat",
      "main-session": "repo:main",
    },
  };
}

function expectScrubbed(saved: UiState): void {
  expect(saved.preferences.drafts).toEqual({
    "chat-session": "CHAT draft",
    "main-session": "main draft",
  });
  expect(saved.preferences.selection).toEqual({
    worktreeId: null,
    sessions: { "repo:main": "main-session" },
  });
  expect(saved.preferences.workViews).toEqual({
    active: { "repo:main": "editor" },
    agentScroll: { "main-session": 4 },
  });
  expect(saved.preferences.terminalViews).toEqual({ active: [], selected: {} });
  expect(saved.sessionScopes).toEqual({ "chat-session": "chat", "main-session": "repo:main" });
  expect(saved.view).toBe("chat");
  expect(saved.chatSessionId).toBe("chat-session");
}

test("A save of a snapshot taken before deletion persists without the deleted scope", async () => {
  // The snapshot was captured before the cleanup was recorded, then saved afterward.
  const app = await fixture();
  try {
    expectOk(await app.first.load(defaultPreferences()));
    const stale = mixedState();
    await recordCleanup(app.directory, 1, [receipt("purged", 1)]);

    expectOk(await app.first.save(stale));

    expectScrubbed(JSON.parse(await readFile(app.first.file, "utf8")));
    const navigation = JSON.parse(await readFile(join(app.directory, "ui", "last.json"), "utf8"));
    expect(navigation.selection.worktreeId).toBeNull();
    expect(navigation.chatSessionId).toBe("chat-session");
  } finally {
    await app.close();
  }
});

test("Purging UI state scrubs every terminal's file and the shared navigation seed", async () => {
  // Another terminal is not running, so only the daemon-side purge can clean its file.
  const app = await fixture();
  try {
    expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(mixedState()));
    expectOk(await app.second.load(defaultPreferences()));
    const other = mixedState();
    other.preferences.drafts = { "chat-session": "second CHAT draft" };
    expectOk(await app.second.save(other));
    await recordCleanup(app.directory, 1, [receipt("fenced", 1)]);

    const report = expectOk(await purgeUiState(app.directory));

    expect(report.residuals).toEqual([]);
    expect(report.rewritten.length).toBe(3);
    expectScrubbed(JSON.parse(await readFile(app.first.file, "utf8")));
    const second = JSON.parse(await readFile(app.second.file, "utf8"));
    expect(second.preferences.drafts).toEqual({ "chat-session": "second CHAT draft" });
    expect(second.preferences.selection.worktreeId).toBeNull();
    const navigation = JSON.parse(await readFile(join(app.directory, "ui", "last.json"), "utf8"));
    expect(navigation.selection.worktreeId).toBeNull();
    // A repeated purge has nothing left to change.
    expect(expectOk(await purgeUiState(app.directory)).rewritten).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Unrecognized UI files are cleanup residuals and are never overwritten", async () => {
  // A file the purge cannot verify keeps the cleanup incomplete instead of being guessed clean.
  const app = await fixture();
  try {
    expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(mixedState()));
    await writeFile(app.second.file, "{broken");
    await recordCleanup(app.directory, 1, [receipt("fenced", 1)]);

    const report = expectOk(await purgeUiState(app.directory));

    expect(report.residuals.map((item) => item.path)).toEqual([app.second.file]);
    expect(await readFile(app.second.file, "utf8")).toBe("{broken");
  } finally {
    await app.close();
  }
});

test("After a reopen, acknowledged fresh state is kept but older snapshots stay scrubbed", async () => {
  // A recreated worktree with the same ID may receive new UI state once this UI scrubbed memory.
  const app = await fixture();
  try {
    expectOk(await app.first.load(defaultPreferences()));
    await recordCleanup(app.directory, 2, [receipt("reopened", 2)]);
    const old = mixedState();
    // Queued before the acknowledgement, so it still represents pre-deletion memory.
    const queued = app.first.save(old);
    app.first.acknowledgeCleanup(2);
    expectOk(await queued);
    expectScrubbed(JSON.parse(await readFile(app.first.file, "utf8")));

    const fresh = mixedState();
    fresh.preferences.selection.sessions = { [deletedTree]: "new-session" };
    fresh.preferences.drafts = { "new-session": "fresh draft", [deletedSession]: "late callback" };
    fresh.sessionScopes = { "new-session": deletedTree, [deletedSession]: deletedTree };
    expectOk(await app.first.save(fresh));

    // The new generation persists; the old session ID never returns, even through a late callback.
    const saved = JSON.parse(await readFile(app.first.file, "utf8"));
    expect(saved.preferences.selection.worktreeId).toBe(deletedTree);
    expect(saved.preferences.drafts).toEqual({ "new-session": "fresh draft" });
    expect(saved.sessionScopes).toEqual({ "new-session": deletedTree });
    // Loading again does not scrub what this file was already clean against.
    const reloaded = expectOk(
      await new UiStateStore(app.directory, "terminal-one").load(defaultPreferences()),
    );
    expect(reloaded.preferences.drafts).toEqual({ "new-session": "fresh draft" });
  } finally {
    await app.close();
  }
});

test("Restart loading scrubs files saved before an interrupted cleanup", async () => {
  // A file written before the fence is read by a new TUI process after the daemon restarted.
  const app = await fixture();
  try {
    expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(mixedState()));
    await recordCleanup(app.directory, 1, [receipt("fenced", 1)]);

    const loaded = expectOk(
      await new UiStateStore(app.directory, "terminal-one").load(defaultPreferences()),
    );
    const fresh = expectOk(
      await new UiStateStore(app.directory, "terminal-three").load(defaultPreferences()),
    );

    expectScrubbed(loaded);
    expect(fresh.preferences.selection.worktreeId).toBeNull();
  } finally {
    await app.close();
  }
});

test("A late save from another TUI process cannot restore a purged scope", async () => {
  // The second process loads before deletion and saves its stale memory after the purge.
  const app = await fixture();
  const script = join(app.directory, "late-writer.ts");
  const module = join(import.meta.dir, "ui-state.ts");
  await writeFile(
    script,
    `import { UiStateStore } from ${JSON.stringify(module)};
const store = new UiStateStore(process.argv[2], "late-process");
const loaded = await store.load(JSON.parse(process.argv[3]));
if (!loaded.ok) throw loaded.error;
const stale = JSON.parse(process.argv[4]);
console.log("READY");
for await (const _ of process.stdin) break;
const saved = await store.save(stale);
if (!saved.ok) throw saved.error;
console.log("SAVED");
`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      script,
      app.directory,
      JSON.stringify(defaultPreferences()),
      JSON.stringify(mixedState()),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("READY");
    await recordCleanup(app.directory, 1, [receipt("fenced", 1)]);
    expectOk(await purgeUiState(app.directory));

    await child.stdin.write("save\n");
    await child.stdin.end();
    let output = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      output += new TextDecoder().decode(next.value);
    }

    expect(await child.exited).toBe(0);
    expect(output).toContain("SAVED");
    const late = new UiStateStore(app.directory, "late-process");
    expectScrubbed(JSON.parse(await readFile(late.file, "utf8")));
    const navigation = JSON.parse(await readFile(join(app.directory, "ui", "last.json"), "utf8"));
    expect(navigation.selection.worktreeId).toBeNull();
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await app.close();
  }
});

// Repository A's deleted worktree path `/x` is now owned by repository B.
const reusedPath = "/x";

function reuseReceipt(state: CleanupReceipt["state"], revision: number): CleanupReceipt {
  return {
    token: "cleanup-token-reuse",
    repositoryId: "/a/.git",
    kind: "repository",
    worktrees: [{ id: reusedPath, path: reusedPath }],
    sessionIds: ["oldA"],
    revision,
    state,
    updatedAt: 0,
  };
}

function reusedState(owner?: string): UiState {
  const preferences = defaultPreferences();
  preferences.selection = { worktreeId: reusedPath, sessions: { [reusedPath]: "newB" } };
  preferences.drafts = { newB: "B draft", oldA: "A draft", chat: "CHAT draft" };
  preferences.workViews = { active: { [reusedPath]: "git" }, agentScroll: { newB: 2 } };
  return {
    version: 1,
    view: "git",
    chatSessionId: "chat",
    preferences,
    sessionScopes: { newB: reusedPath, chat: "chat" },
    ...(owner ? { worktreeRepositories: { [reusedPath]: owner } } : {}),
  };
}

function expectRepositoryBKept(saved: UiState): void {
  expect(saved.preferences.selection).toEqual({
    worktreeId: reusedPath,
    sessions: { [reusedPath]: "newB" },
  });
  expect(saved.preferences.drafts).toEqual({ newB: "B draft", chat: "CHAT draft" });
  expect(saved.preferences.workViews?.active).toEqual({ [reusedPath]: "git" });
  expect(saved.sessionScopes).toEqual({ newB: reusedPath, chat: "chat" });
  expect(saved.view).toBe("git");
}

test("Deleting a repository's historical path keeps another repository that now owns it", async () => {
  const app = await fixture();
  try {
    expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(reusedState("/b/.git")));
    await recordCleanup(app.directory, 1, [reuseReceipt("purged", 1)]);

    // The daemon purge, a stale save and a later load all honor the recorded owner.
    const report = expectOk(await purgeUiState(app.directory));
    expectRepositoryBKept(JSON.parse(await readFile(app.first.file, "utf8")));
    expect(report.residuals).toEqual([]);
    expectOk(await app.first.save(reusedState("/b/.git")));
    expectRepositoryBKept(JSON.parse(await readFile(app.first.file, "utf8")));
    const loaded = expectOk(
      await new UiStateStore(app.directory, "terminal-one").load(defaultPreferences()),
    );
    expectRepositoryBKept(loaded);
    const navigation = JSON.parse(await readFile(join(app.directory, "ui", "last.json"), "utf8"));
    expect(navigation.selection.worktreeId).toBe(reusedPath);
  } finally {
    await app.close();
  }
});

test("The current catalog resolves owners of a state saved before ownership tracking", async () => {
  const app = await fixture();
  try {
    expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(reusedState()));
    await recordCleanup(app.directory, 1, [reuseReceipt("purged", 1)]);

    const loaded = expectOk(
      await new UiStateStore(app.directory, "terminal-one").load(
        defaultPreferences(),
        new Map([[reusedPath, "/b/.git"]]),
      ),
    );

    expectRepositoryBKept(loaded);
  } finally {
    await app.close();
  }
});

test("A purge retains worktree state of an unknown owner and reports the cleanup incomplete", async () => {
  // Legacy state with no recorded owner and no link to the receipt's sessions is ambiguous.
  const app = await fixture();
  try {
    expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(reusedState()));
    await recordCleanup(app.directory, 1, [reuseReceipt("fenced", 1)]);

    const report = expectOk(await purgeUiState(app.directory));

    expectRepositoryBKept(JSON.parse(await readFile(app.first.file, "utf8")));
    expect(report.residuals).toHaveLength(2);
    expect(report.residuals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join(app.directory, "ui", "last.json") }),
        expect.objectContaining({ path: app.first.file, code: "CLEANUP_FAILED" }),
      ]),
    );
    expect(report.residuals.every((item) => item.code === "CLEANUP_FAILED")).toBe(true);
    // Repeating the purge reports the same retained state again instead of completing.
    expect(expectOk(await purgeUiState(app.directory)).residuals.length).toBe(2);
  } finally {
    await app.close();
  }
});

test("A legacy worktree linked to the receipt's own session is scrubbed without an owner", async () => {
  const app = await fixture();
  try {
    const legacy = reusedState();
    legacy.preferences.selection.sessions[reusedPath] = "oldA";
    expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(legacy));
    await recordCleanup(app.directory, 1, [reuseReceipt("fenced", 1)]);

    const report = expectOk(await purgeUiState(app.directory));

    const saved = JSON.parse(await readFile(app.first.file, "utf8")) as UiState;
    expect(report.residuals).toEqual([]);
    expect(saved.preferences.selection.worktreeId).toBeNull();
    expect(saved.preferences.workViews?.active).toEqual({});
    expect(saved.preferences.drafts).toEqual({ chat: "CHAT draft" });
  } finally {
    await app.close();
  }
});

test("A purge while the UI was detached marks the cleared selection for its next start", async () => {
  // The UI last showed a Code view of the deleted worktree and then exited.
  const app = await fixture();
  try {
    const state = mixedState();
    state.view = "agent";
    expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(state));
    await recordCleanup(app.directory, 1, [receipt("purged", 1)]);
    expectOk(await purgeUiState(app.directory));

    const store = new UiStateStore(app.directory, "terminal-one");
    const loaded = expectOk(await store.load(defaultPreferences()));

    // The scrub already happened, so only the marker tells the UI its selection was deleted.
    expect(loaded.preferences.selection.worktreeId).toBeNull();
    expect(loaded.view).toBe("agent");
    expect(store.acknowledgedCleanup).toBe(1);
    expect(store.selectionDeleted).toBe(true);
    // The next save of the started UI consumes the marker.
    expectOk(await store.save({ ...loaded, view: "chat" }));
    const restarted = new UiStateStore(app.directory, "terminal-one");
    expectOk(await restarted.load(defaultPreferences()));
    expect(restarted.selectionDeleted).toBe(false);
  } finally {
    await app.close();
  }
});

test("A cold start without a deleted selection reports nothing", async () => {
  const app = await fixture();
  try {
    const state = mixedState();
    state.preferences.selection.worktreeId = "repo:main";
    state.view = "agent";
    expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(state));
    await recordCleanup(app.directory, 1, [receipt("purged", 1)]);
    expectOk(await purgeUiState(app.directory));

    const store = new UiStateStore(app.directory, "terminal-one");
    const loaded = expectOk(await store.load(defaultPreferences()));

    expect(loaded.preferences.selection.worktreeId).toBe("repo:main");
    expect(store.selectionDeleted).toBe(false);
  } finally {
    await app.close();
  }
});

const defaultUiState = (): UiState => ({
  version: 1,
  view: "chat",
  chatSessionId: null,
  preferences: defaultPreferences(),
});

test("A crashed temporary document is scrubbed in place, keeping its unrelated drafts", async () => {
  const app = await fixture();
  try {
    expectOk(await app.first.load(defaultPreferences()));
    expectOk(await app.first.save(defaultUiState()));
    const temporary = `${app.second.file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(mixedState()));
    await recordCleanup(app.directory, 1, [receipt("fenced", 1)]);

    const report = expectOk(await purgeUiState(app.directory));

    expect(report.removed).toEqual([]);
    expect(report.rewritten).toContain(temporary);
    expectScrubbed(JSON.parse(await readFile(temporary, "utf8")));
  } finally {
    await app.close();
  }
});

test("A UI directory that is a symlink to another state directory is never traversed", async () => {
  const app = await fixture();
  const foreign = await mkdtemp(join(tmpdir(), "radian-ui-foreign-"));
  try {
    const document = join(foreign, "other.json");
    const original = JSON.stringify(mixedState());
    await writeFile(document, original);
    await symlink(foreign, join(app.directory, "ui"));
    await recordCleanup(app.directory, 1, [receipt("fenced", 1)]);

    const report = expectOk(await purgeUiState(app.directory));

    expect(report.residuals.map((item) => item.path)).toEqual([join(app.directory, "ui")]);
    expect(await readFile(document, "utf8")).toBe(original);
  } finally {
    await rm(foreign, { recursive: true, force: true });
    await app.close();
  }
});
