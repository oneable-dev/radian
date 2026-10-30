import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPreferences } from "../runtime/client.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { retainedUiDrafts, UiStateStore } from "./ui-state.ts";
import { restoreWorkViews } from "../runtime/work-view-preferences.ts";

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
