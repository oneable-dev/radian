import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPreferences } from "../runtime/client.ts";
import type { CleanupReceipt } from "../runtime/daemon-protocol.ts";
import type { DeletedScopes } from "../runtime/protocol.ts";
import { withCleanupLock, writeCleanupLedger } from "../runtime/restore-state.ts";
import { ok } from "../result.ts";
import { expectOk } from "../testing/results.ts";
import type { Repository } from "../workspace/model.ts";
import { purgeUiState, UiStateStore, type UiState } from "./ui-state.ts";
import {
  initialView,
  pendingDeletion,
  recordWorktreeOwners,
  UiStatePersistence,
  WorkspaceDeletions,
} from "./workspace-deletion.ts";
import { WorkspaceSelection } from "./workspace-selection.ts";

const scope = (
  state: DeletedScopes["scopes"][number]["state"],
  revision: number,
  ids: { worktreeIds?: string[]; sessionIds?: string[]; token?: string } = {},
): DeletedScopes["scopes"][number] => ({
  token: ids.token ?? "cleanup-token-a",
  repositoryId: "repo",
  kind: "worktrees",
  worktreeIds: ids.worktreeIds ?? ["repo:feature"],
  sessionIds: ids.sessionIds ?? ["feature-session"],
  revision,
  state,
});

function repositories(...trees: [string, string[]][]): Repository[] {
  return [
    {
      id: "repo",
      name: "repo",
      worktrees: trees.map(([id, sessions]) => ({
        id,
        path: `/fixture/${id}`,
        name: id,
        branch: null,
        sessions: sessions.map((session) => ({
          id: session,
          name: session,
          status: null,
          subagents: [],
        })),
      })),
    },
  ];
}

function mixedState(): UiState {
  const preferences = defaultPreferences();
  preferences.selection = {
    worktreeId: "repo:feature",
    sessions: { "repo:feature": "feature-session", "repo:main": "main-session" },
  };
  preferences.drafts = {
    "feature-session": "deleted draft",
    "main-session": "main draft",
    "chat-session": "CHAT draft",
  };
  preferences.workViews = {
    active: { "repo:feature": "git", "repo:main": "editor" },
    agentScroll: { "feature-session": 3, "main-session": 4 },
  };
  return {
    version: 1,
    view: "chat",
    chatSessionId: "chat-session",
    preferences,
    sessionScopes: {
      "feature-session": "repo:feature",
      "main-session": "repo:main",
      "chat-session": "chat",
    },
  };
}

test("Missing summaries and already acknowledged revisions authorize no cleanup", () => {
  // Cold, not-ready and disconnected snapshots carry no deletion summary at all.
  expect(pendingDeletion(undefined, 0)).toBeNull();
  expect(pendingDeletion({ revision: 0, scopes: [] }, 0)).toBeNull();
  expect(pendingDeletion({ revision: 3, scopes: [scope("complete", 3)] }, 3)).toBeNull();
});

test("Pending, complete and reopened scopes newer than the acknowledgement are all scrubbed", () => {
  // A UI that missed the earlier states only sees the reopened receipt.
  const summary: DeletedScopes = {
    revision: 7,
    scopes: [
      scope("reopened", 7),
      scope("pending", 6, { token: "cleanup-token-b", worktreeIds: ["b"], sessionIds: ["b1"] }),
      scope("complete", 2, { token: "cleanup-token-c", worktreeIds: ["c"], sessionIds: ["c1"] }),
    ],
  };

  const batch = pendingDeletion(summary, 4);

  // Older receipts were already applied; the top-level revision is acknowledged next.
  expect(batch?.revision).toBe(7);
  expect([...batch!.worktreeIds]).toEqual(["repo:feature", "b"]);
  expect([...batch!.sessionIds]).toEqual(["feature-session", "b1"]);
});

test("Applying a deletion scrubs memory, switches selection, then acknowledges and persists once", () => {
  const state = mixedState();
  const events: string[] = [];
  const store = { acknowledgeCleanup: (revision: number) => events.push(`ack:${revision}`) };
  const deletions = new WorkspaceDeletions(state, store, 0);
  const selection = new WorkspaceSelection(
    repositories(["repo:main", ["main-session"]], ["repo:feature", ["feature-session"]]),
  );
  selection.selectWorktree("repo:feature");
  // Bootstrap persists from selection callbacks; they must not run on a partial batch.
  selection.subscribe(() => events.push(deletions.suspended ? "suppressed" : "persist"));
  const view = {
    forgetWorkspaces: () => events.push(`view:${deletions.suspended}`),
  };

  const applied = deletions.apply(
    { revision: 2, scopes: [scope("complete", 2)] },
    repositories(["repo:main", ["main-session"]]),
    { selection, view, persist: () => events.push("persist") },
  );

  expect(applied).toBe(true);
  expect(events).toEqual(["view:true", "suppressed", "ack:2", "persist"]);
  expect(selection.worktree?.id).toBe("repo:main");
  expect(state.preferences.drafts).toEqual({
    "main-session": "main draft",
    "chat-session": "CHAT draft",
  });
  expect(state.preferences.workViews).toEqual({
    active: { "repo:main": "editor" },
    agentScroll: { "main-session": 4 },
  });
  expect(state.sessionScopes).toEqual({ "main-session": "repo:main", "chat-session": "chat" });
  expect(state.view).toBe("chat");
  expect(state.chatSessionId).toBe("chat-session");
});

test("A snapshot without a newer deletion leaves state and selection to the normal refresh", () => {
  // The UI already acknowledged this revision when it loaded.
  const state = mixedState();
  const deletions = new WorkspaceDeletions(state, undefined, 2);
  const selection = new WorkspaceSelection(repositories(["repo:feature", ["feature-session"]]));
  let persisted = 0;

  const applied = deletions.apply({ revision: 2, scopes: [scope("reopened", 2)] }, [], {
    selection,
    persist: () => persisted++,
  });

  // The reopened scope is a new generation; its current state is not scrubbed again.
  expect(applied).toBe(false);
  expect(persisted).toBe(0);
  expect(state.preferences.workViews?.active["repo:feature"]).toBe("git");
  // Its old sessions stay deleted permanently.
  expect(deletions.isDeleted("feature-session")).toBe(true);
  expect(deletions.withoutDeleted(state.preferences.drafts)).toEqual({
    "main-session": "main draft",
    "chat-session": "CHAT draft",
  });
});

test("Preparing loaded state reports a deleted selected worktree", () => {
  const state = mixedState();
  const acknowledged: number[] = [];
  const deletions = new WorkspaceDeletions(
    state,
    { acknowledgeCleanup: (revision) => acknowledged.push(revision) },
    0,
  );

  expect(deletions.prepare({ revision: 1, scopes: [scope("pending", 1)] })).toBe(true);
  expect(acknowledged).toEqual([1]);
  expect(state.preferences.selection.worktreeId).toBeNull();
  expect(deletions.prepare({ revision: 1, scopes: [scope("pending", 1)] })).toBe(false);
});

async function ledgerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "radian-ui-deletion-"));
  return {
    directory,
    store: new UiStateStore(directory, "terminal"),
    async record(revision: number, receipts: CleanupReceipt[]) {
      expectOk(
        await withCleanupLock(directory, () =>
          writeCleanupLedger(directory, { version: 1, revision, receipts }),
        ),
      );
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("A save requested before acknowledgement keeps its own acknowledgement while queued", async () => {
  // The scope was deleted and reopened while this UI still held its pre-deletion state.
  const app = await ledgerFixture();
  try {
    expectOk(await app.store.load(defaultPreferences()));
    await app.record(1, [
      {
        token: "cleanup-token-a",
        repositoryId: "repo",
        kind: "worktrees",
        worktrees: [{ id: "repo:feature", path: "/repo/feature" }],
        sessionIds: ["feature-session"],
        revision: 1,
        state: "reopened",
        updatedAt: 0,
      },
    ]);
    const saves = new UiStatePersistence(app.store, () => {});
    const earlier = mixedState();
    earlier.preferences.drafts["main-session"] = "first";

    // Two saves are requested back to back; the second waits behind the first in the store.
    saves.save(earlier);
    saves.save(mixedState());
    app.store.acknowledgeCleanup(1);
    expectOk(await saves.settled);

    // The queued stale snapshot was still scrubbed against its request-time acknowledgement.
    const saved = JSON.parse(await readFile(app.store.file, "utf8")) as UiState;
    expect(saved.preferences.drafts["main-session"]).toBe("main draft");
    expect(saved.preferences.workViews?.active).toEqual({ "repo:main": "editor" });
    expect(saved.preferences.selection.worktreeId).toBeNull();
    expect(saved.preferences.drafts["chat-session"]).toBe("CHAT draft");
  } finally {
    await app.close();
  }
});

test("Unchanged state is not saved twice", async () => {
  const requested: UiState[] = [];
  const saves = new UiStatePersistence(
    {
      save: async (state) => {
        requested.push(structuredClone(state));
        return ok(undefined);
      },
    },
    () => {},
  );
  const state = mixedState();

  saves.save(state);
  saves.save(state);
  state.view = "agent";
  saves.save(state);

  expect(requested.map((item) => item.view)).toEqual(["chat", "agent"]);
});

test("A reopened scope already applied by load() is not scrubbed again on the first snapshot", async () => {
  // The ledger records a deletion that was reopened before this UI started.
  const app = await ledgerFixture();
  try {
    await app.record(2, [
      {
        token: "cleanup-token-a",
        repositoryId: "repo",
        kind: "worktrees",
        worktrees: [{ id: "repo:feature", path: "/repo/feature" }],
        sessionIds: ["feature-session"],
        revision: 2,
        state: "reopened",
        updatedAt: 0,
      },
    ]);
    const state = expectOk(await app.store.load(defaultPreferences()));
    state.preferences.selection.worktreeId = "repo:feature";
    state.preferences.drafts["fresh-session"] = "fresh draft";
    const deletions = new WorkspaceDeletions(state, app.store, app.store.acknowledgedCleanup);
    const selection = new WorkspaceSelection(repositories(["repo:feature", ["fresh-session"]]));

    const applied = deletions.apply(
      { revision: 2, scopes: [scope("reopened", 2)] },
      selection.snapshot,
      { selection, persist: () => {} },
    );

    // The new generation keeps its selection and draft; old sessions remain deleted.
    expect(app.store.acknowledgedCleanup).toBe(2);
    expect(applied).toBe(false);
    expect(state.preferences.selection.worktreeId).toBe("repo:feature");
    expect(state.preferences.drafts).toEqual({ "fresh-session": "fresh draft" });
    expect(deletions.isDeleted("feature-session")).toBe(true);
  } finally {
    await app.close();
  }
});

test("Cold or disconnected snapshots without a deletion summary change nothing", () => {
  const state = mixedState();
  const original = structuredClone(state);
  const deletions = new WorkspaceDeletions(state, undefined, 0);
  const selection = new WorkspaceSelection(repositories(["repo:feature", ["feature-session"]]));

  // A cold catalog may omit worktrees entirely; that is not proof of deletion.
  const applied = deletions.apply(undefined, [], { selection, persist: () => {} });

  expect(applied).toBe(false);
  expect(state).toEqual(original);
  expect(deletions.isDeleted("feature-session")).toBe(false);
});

// Repository A's deleted worktree path `/x` is reused by repository B.
const reuse = {
  path: "/x",
  receipt: (revision: number): DeletedScopes => ({
    revision,
    scopes: [
      {
        token: "cleanup-token-reuse",
        repositoryId: "/a/.git",
        kind: "repository",
        worktreeIds: ["/x"],
        sessionIds: ["oldA"],
        revision,
        state: "complete",
      },
    ],
  }),
  repositories: (): Repository[] => [
    {
      id: "/b/.git",
      name: "b",
      worktrees: [
        {
          id: "/x",
          path: "/x",
          name: "b",
          branch: null,
          sessions: [{ id: "newB", name: "newB", status: null, subagents: [] }],
        },
      ],
    },
  ],
  state(): UiState {
    const preferences = defaultPreferences();
    preferences.selection = { worktreeId: "/x", sessions: { "/x": "newB" } };
    preferences.drafts = { newB: "B draft", oldA: "A draft", chat: "CHAT draft" };
    preferences.workViews = { active: { "/x": "git" }, agentScroll: { newB: 1, oldA: 2 } };
    return {
      version: 1,
      view: "git",
      chatSessionId: "chat",
      preferences,
      sessionScopes: { newB: "/x", oldA: "/x", chat: "chat" },
    };
  },
};

test("A live deletion of another repository's historical path keeps the repository reusing it", () => {
  const state = reuse.state();
  const acknowledged: number[] = [];
  const deletions = new WorkspaceDeletions(
    state,
    { acknowledgeCleanup: (revision) => acknowledged.push(revision) },
    0,
  );
  const selection = new WorkspaceSelection(reuse.repositories());
  const forgotten: string[][] = [];
  const view = {
    forgetWorkspaces: (deletion: { worktreeIds: ReadonlySet<string> }) =>
      forgotten.push([...deletion.worktreeIds]),
  };

  const applied = deletions.apply(reuse.receipt(3), reuse.repositories(), {
    selection,
    view,
    persist: () => {},
  });

  // Only A's own session is removed; B's selection, draft, view and session survive.
  expect(applied).toBe(true);
  expect(acknowledged).toEqual([3]);
  expect(forgotten).toEqual([[]]);
  expect(selection.worktree?.id).toBe("/x");
  expect(selection.sessionId).toBe("newB");
  expect(state.preferences.selection).toEqual({ worktreeId: "/x", sessions: { "/x": "newB" } });
  expect(state.preferences.drafts).toEqual({ newB: "B draft", chat: "CHAT draft" });
  expect(state.preferences.workViews).toEqual({
    active: { "/x": "git" },
    agentScroll: { newB: 1 },
  });
  expect(state.sessionScopes).toEqual({ newB: "/x", chat: "chat" });
  expect(deletions.isDeleted("oldA")).toBe(true);
  expect(deletions.isDeleted("newB")).toBe(false);
});

test("Startup preparation honors the current owner of a reused deleted path", () => {
  const state = reuse.state();
  const deletions = new WorkspaceDeletions(state, undefined, 0);

  const selectedDeleted = deletions.prepare(reuse.receipt(3), reuse.repositories());

  expect(selectedDeleted).toBe(false);
  expect(state.preferences.selection.worktreeId).toBe("/x");
  expect(state.preferences.drafts).toEqual({ newB: "B draft", chat: "CHAT draft" });
  expect(deletions.isDeleted("oldA")).toBe(true);
  expect(initialView(state.view, selectedDeleted, reuse.repositories())).toBe("git");
});

test("Recorded ownership persists through a stale save and a restart after the purge", async () => {
  const app = await ledgerFixture();
  try {
    expectOk(await app.store.load(defaultPreferences()));
    const state = reuse.state();
    state.worktreeRepositories = recordWorktreeOwners(state, reuse.repositories());
    expect(state.worktreeRepositories).toEqual({ "/x": "/b/.git" });
    await app.record(3, [
      {
        token: "cleanup-token-reuse",
        repositoryId: "/a/.git",
        kind: "repository",
        worktrees: [{ id: "/x", path: "/x" }],
        sessionIds: ["oldA"],
        revision: 3,
        state: "purged",
        updatedAt: 0,
      },
    ]);
    expectOk(await purgeUiState(app.directory));
    // A save queued before this UI acknowledged the cleanup.
    expectOk(await app.store.save(state));

    const restarted = new UiStateStore(app.directory, "terminal");
    const loaded = expectOk(await restarted.load(defaultPreferences()));

    expect(loaded.preferences.selection).toEqual({ worktreeId: "/x", sessions: { "/x": "newB" } });
    expect(loaded.preferences.drafts).toEqual({ newB: "B draft", chat: "CHAT draft" });
    expect(loaded.view).toBe("git");
    expect(restarted.selectionDeleted).toBe(false);
  } finally {
    await app.close();
  }
});

async function detachedDeletion(survivors: Repository[]) {
  // The UI saved a Code view of the selected worktree, exited, and the daemon then deleted it.
  const app = await ledgerFixture();
  const state = mixedState();
  state.view = "agent";
  state.worktreeRepositories = { "repo:feature": "repo", "repo:main": "repo" };
  expectOk(await app.store.load(defaultPreferences()));
  expectOk(await app.store.save(state));
  await app.record(3, [
    {
      token: "cleanup-token-a",
      repositoryId: "repo",
      kind: "worktrees",
      worktrees: [{ id: "repo:feature", path: "/repo/feature" }],
      sessionIds: ["feature-session"],
      revision: 3,
      state: "purged",
      updatedAt: 0,
    },
  ]);
  expectOk(await purgeUiState(app.directory));

  // Reconnect as bootstrap does: load, then prepare at the acknowledged revision.
  const store = new UiStateStore(app.directory, "terminal");
  const loaded = expectOk(await store.load(defaultPreferences()));
  const deletions = new WorkspaceDeletions(loaded, store, store.acknowledgedCleanup);
  const selectedDeleted = deletions.prepare(
    { revision: 3, scopes: [scope("complete", 3)] },
    survivors,
    store.selectionDeleted,
  );

  return { app, store, loaded, selectedDeleted };
}

test("A UI reconnecting after its last workspace was deleted while detached opens CHAT", async () => {
  const { app, store, loaded, selectedDeleted } = await detachedDeletion([]);
  try {
    expect(store.acknowledgedCleanup).toBe(3);
    expect(loaded.preferences.selection.worktreeId).toBeNull();
    expect(selectedDeleted).toBe(true);
    expect(initialView(loaded.view, selectedDeleted, [])).toBe("chat");
    // The existing CHAT conversation and its draft are untouched; nothing is created.
    expect(loaded.chatSessionId).toBe("chat-session");
    expect(loaded.preferences.drafts["chat-session"]).toBe("CHAT draft");
  } finally {
    await app.close();
  }
});

test("A UI reconnecting after a deletion with surviving workspaces keeps its Code view", async () => {
  const survivors = repositories(["repo:main", ["main-session"]]);
  const { app, loaded, selectedDeleted } = await detachedDeletion(survivors);
  try {
    expect(selectedDeleted).toBe(true);
    expect(initialView(loaded.view, selectedDeleted, survivors)).toBe("agent");
    const selection = new WorkspaceSelection(survivors);
    selection.restore(loaded.preferences.selection);
    expect(selection.worktree?.id).toBe("repo:main");
  } finally {
    await app.close();
  }
});

test("Cold or unavailable workspaces never move a reconnecting Code view to CHAT", async () => {
  const app = await ledgerFixture();
  try {
    const state = mixedState();
    state.view = "agent";
    expectOk(await app.store.load(defaultPreferences()));
    expectOk(await app.store.save(state));

    // No deletion receipt exists; the catalog is merely empty while repositories are cold.
    const store = new UiStateStore(app.directory, "terminal");
    const loaded = expectOk(await store.load(defaultPreferences()));
    const deletions = new WorkspaceDeletions(loaded, store, store.acknowledgedCleanup);
    const selectedDeleted = deletions.prepare(undefined, [], store.selectionDeleted);

    expect(selectedDeleted).toBe(false);
    expect(initialView(loaded.view, selectedDeleted, [])).toBe("agent");
    expect(loaded.preferences.selection.worktreeId).toBe("repo:feature");
  } finally {
    await app.close();
  }
});

test("An already active CHAT view stays CHAT after a detached deletion", () => {
  expect(initialView("chat", true, [])).toBe("chat");
});
