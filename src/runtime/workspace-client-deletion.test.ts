import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
import { ok } from "../result.ts";
import { expectOk } from "../testing/results.ts";
import { RuntimeClient, defaultPreferences } from "./client.ts";
import * as lifecycle from "./lifecycle.ts";
import type { DeletedScopes, RuntimePreferences, RuntimeSnapshot } from "./protocol.ts";
import { daemonPaths } from "./storage.ts";
import { WorkspaceClient } from "./workspace-client.ts";

class SnapshotClient extends RuntimeClient {
  readonly saved: RuntimePreferences[] = [];
  private readonly observers = new Set<() => void>();

  constructor(
    root: string,
    public current: RuntimeSnapshot,
  ) {
    super(daemonPaths(true, root), current);
  }

  override get snapshot() {
    return this.current;
  }
  override get connected() {
    return true;
  }
  override subscribe(listener: () => void) {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }
  override async savePreferences(preferences: RuntimePreferences) {
    this.saved.push(structuredClone(preferences));
    return ok(undefined);
  }
  publish() {
    for (const observer of this.observers) observer();
  }
}

// Repository B now owns the path that repository A's deleted worktree used.
const reused = "/x";
const repositoryB = {
  id: "/b/.git",
  name: "b",
  worktrees: [
    {
      id: reused,
      path: reused,
      name: "main",
      branch: "main",
      sessions: [{ id: "newB", name: "B", status: null, subagents: [] }],
    },
  ],
};

function snapshot(deletedScopes?: DeletedScopes): RuntimeSnapshot {
  return {
    version: 1,
    pid: process.pid,
    instance: "daemon",
    repositoryId: repositoryB.id,
    mode: "offline",
    repositories: [repositoryB],
    preferences: defaultPreferences(),
    details: {},
    closingCount: 0,
    notice: "",
    capabilities: ["shared-daemon"],
    chat: {
      id: CHAT_SCOPE_ID,
      path: homedir(),
      name: "CHAT",
      sessions: [],
      details: {},
      historyRevision: 0,
      accountsRevision: 0,
      closingCount: 0,
    },
    ...(deletedScopes ? { deletedScopes } : {}),
  };
}

const deletionOfA: DeletedScopes = {
  revision: 3,
  scopes: [
    {
      token: "cleanup-token-a",
      repositoryId: "/a/.git",
      kind: "repository",
      worktreeIds: [reused],
      sessionIds: ["oldA"],
      revision: 3,
      state: "complete",
    },
  ],
};

test("A deletion of another repository's historical path keeps the repository that reuses it", async () => {
  const root = await mkdtemp(join(tmpdir(), "radian-workspace-deletion-client-"));
  const code = new SnapshotClient(root, snapshot());
  const chat = new SnapshotClient(root, snapshot());
  const connectCode = spyOn(lifecycle, "connectRuntime").mockResolvedValue(ok(code));
  const connectChat = spyOn(lifecycle, "connectChatRuntime").mockResolvedValue(ok(chat));
  let workspace: WorkspaceClient | undefined;
  try {
    workspace = expectOk(
      await WorkspaceClient.open(
        [repositoryB],
        reused,
        { stateRoot: root },
        lifecycle.connectRuntime,
      ),
    );
    const preferences = defaultPreferences();
    preferences.selection = { worktreeId: reused, sessions: { [reused]: "newB" } };
    preferences.drafts = { newB: "B draft", oldA: "late A draft" };
    preferences.workViews = { active: { [reused]: "git" }, agentScroll: {} };
    expectOk(await workspace.savePreferences(preferences));

    // A's receipt names the reused path and A's own old session.
    chat.current = snapshot(deletionOfA);
    chat.publish();
    expectOk(await workspace.savePreferences(preferences));

    const current = workspace.snapshot.preferences;
    expect(current.selection).toEqual({ worktreeId: reused, sessions: { [reused]: "newB" } });
    expect(current.drafts).toEqual({ newB: "B draft" });
    expect(current.workViews?.active).toEqual({ [reused]: "git" });
    expect(code.saved.at(-1)?.drafts).toEqual({ newB: "B draft" });
    expect(code.saved.at(-1)?.selection.worktreeId).toBe(reused);
  } finally {
    await workspace?.disconnect();
    connectCode.mockRestore();
    connectChat.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
