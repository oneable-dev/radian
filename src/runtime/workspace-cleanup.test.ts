import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sessionRecordKey } from "../agents/session-snapshot.ts";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../agents/session-registry.ts";
import { UiStateStore, type UiState } from "../app/ui-state.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { defaultPreferences } from "./client.ts";
import { emptyPreferences, type RuntimeManifest } from "./protocol.ts";
import { RestoreStateStore } from "./restore-state.ts";
import {
  daemonPaths,
  privateDirectory,
  runtimePaths,
  RuntimeStore,
  type RuntimeCleanupReport,
} from "./storage.ts";
import { cleanupToken, WorkspaceCleanup, type RuntimeScopeCleanup } from "./workspace-cleanup.ts";
import * as storage from "./storage.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "radian-workspace-cleanup-")));
  const stateRoot = join(root, "state");
  const repositoryId = join(root, "repo", ".git");
  const paths = runtimePaths(repositoryId, true, stateRoot);
  const daemon = daemonPaths(true, stateRoot);
  await privateDirectory(paths.directory);
  await privateDirectory(daemon.directory);
  const sdk = join(paths.directory, "offline-agent", "sessions");
  await mkdir(sdk, { recursive: true, mode: 0o700 });
  const external = join(root, "external");
  await mkdir(external, { mode: 0o700 });
  const main = { id: join(root, "repo"), path: join(root, "repo") };
  const linked = { id: join(root, "linked"), path: join(root, "linked") };
  for (const tree of [main, linked]) await mkdir(tree.path, { recursive: true });

  const sdkFile = async (directory: string, id: string, cwd: string) => {
    const file = join(directory, `2026-01-01_${id}.jsonl`);
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id, cwd }) + "\n", {
      mode: 0o600,
    });
    return file;
  };
  // Closed records only: a cold host has no open registry candidates for them.
  const record = (
    id: string,
    tree: { id: string; path: string },
    sessionFile: string,
  ): SessionRecord => ({
    id: `tab-${id}`,
    name: id,
    worktreeId: tree.id,
    cwd: tree.path,
    sessionFile,
    lifecycle: "closed",
    managed: true,
    closedAt: 1,
    updatedAt: 1,
    state: { conversationId: id, status: "complete", output: `Secret ${id}`, error: null },
    subagents: [],
  });
  const manifest = (records: readonly SessionRecord[]): RuntimeManifest => ({
    version: 1,
    repositoryId,
    repositories: [
      {
        id: repositoryId,
        name: "repo",
        worktrees: [main, linked].map((tree) => ({
          ...tree,
          name: tree.id,
          branch: null,
          sessions: [],
        })),
      },
    ],
    preferences: structuredClone(emptyPreferences),
    records,
  });
  const registry = new RestoreStateStore(daemon.manifest);
  const cleanup = (runtime?: RuntimeScopeCleanup) =>
    new WorkspaceCleanup({ offline: true, stateRoot, registry, ...(runtime ? { runtime } : {}) });

  return {
    root,
    stateRoot,
    repositoryId,
    paths,
    daemon,
    sdk,
    external,
    main,
    linked,
    sdkFile,
    record,
    manifest,
    registry,
    cleanup,
    exists: (path: string) =>
      stat(path).then(
        () => true,
        () => false,
      ),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

// A UI that used the linked worktree's closed session and also has a CHAT draft.
function uiState(linked: string, main: string, repositoryId: string): UiState {
  const preferences = defaultPreferences();
  preferences.selection.worktreeId = linked;
  preferences.selection.sessions = { [main]: "tab-a" };
  preferences.drafts = { "tab-b": "deleted draft", "tab-a": "main draft", chat: "CHAT draft" };
  return {
    version: 1,
    view: "chat",
    chatSessionId: "chat",
    preferences,
    sessionScopes: { chat: "chat", "tab-a": main },
    // The attached UI recorded which repository owned each worktree it displayed.
    worktreeRepositories: { [linked]: repositoryId, [main]: repositoryId },
  };
}

test("A confirmed worktree cleanup purges closed owned state and every persisted UI reference", async () => {
  // The closed session is known only to the runtime index, not to any caller candidate.
  const app = await fixture();
  try {
    const a = await app.sdkFile(app.sdk, "a", app.main.path);
    const b = await app.sdkFile(app.sdk, "b", app.linked.path);
    const foreign = await app.sdkFile(app.external, "c", app.linked.path);
    const store = new RuntimeStore(app.paths);
    expectOk(await store.load(app.repositoryId));
    expectOk(
      await store.save(
        app.manifest([
          app.record("a", app.main, a),
          app.record("b", app.linked, b),
          app.record("c", app.linked, foreign),
        ]),
      ),
    );
    expectOk(
      await app.registry.save({
        version: 2,
        source: {
          settings: { path: join(app.root, "settings.json"), explicit: true },
          workspace: { path: join(app.root, "workspace.json"), explicit: false },
          cwd: app.linked.path,
          contexts: [app.main.path],
        },
        chatConfig: null,
        repositories: [{ repositoryId: app.repositoryId, active: true }],
      }),
    );
    const ui = new UiStateStore(app.daemon.directory, "terminal");
    expectOk(await ui.load(defaultPreferences()));
    expectOk(await ui.save(uiState(app.linked.id, app.main.id, app.repositoryId)));
    const cleanup = app.cleanup();

    const fenced = cleanup.fence(
      { repositoryId: app.repositoryId, kind: "worktrees", worktrees: [app.linked] },
      cleanupToken("native-proof-1"),
    );
    const receipt = expectOk(await fenced.durable);
    const report = expectOk(await cleanup.purge(fenced.token, { writersStopped: true }));

    // Runtime: the owned original goes; the sibling and the foreign original stay.
    expect(report.complete).toBe(true);
    expect(report.residuals).toEqual([]);
    expect(await app.exists(b)).toBe(false);
    expect(await app.exists(a)).toBe(true);
    expect(await app.exists(foreign)).toBe(true);
    expect(report.receipt.state).toBe("purged");
    expect(report.receipt.sessionIds).toEqual(expect.arrayContaining(["tab-b", "tab-c"]));
    expect(report.receipt.revision).toBeGreaterThan(receipt.revision);
    // Registry: the source keeps its references, the deleted cwd stops being a context.
    expect(report.registry?.source?.cwdRemoved).toBe(true);
    expect(report.registry?.source?.contexts).toEqual([app.main.path]);
    expect(report.registry?.repositories).toEqual([
      { repositoryId: app.repositoryId, active: true },
    ]);
    // UI: deleted session and selection are scrubbed; CHAT and the sibling remain.
    const saved = JSON.parse(await readFile(ui.file, "utf8")) as UiState;
    expect(saved.preferences.drafts).toEqual({ "tab-a": "main draft", chat: "CHAT draft" });
    expect(saved.preferences.selection.worktreeId).toBeNull();
    expect(saved.chatSessionId).toBe("chat");
    // The wire view distinguishes this explicit deletion and reports the latest revision.
    const scopes = cleanup.deletedScopes()!;
    expect(scopes.revision).toBe(report.receipt.revision);
    expect(scopes.scopes).toEqual([
      expect.objectContaining({
        token: fenced.token,
        state: "complete",
        worktreeIds: [app.linked.id],
      }),
    ]);
  } finally {
    await app.close();
  }
});

test("Repeated evidence and repeated purges reuse one receipt", async () => {
  // A replayed notification or a retry after a crash must not create another cleanup.
  const app = await fixture();
  try {
    const cleanup = app.cleanup();
    const scope = {
      repositoryId: app.repositoryId,
      kind: "worktrees" as const,
      worktrees: [app.linked],
    };
    const token = cleanupToken("native-proof-2");

    const first = expectOk(await cleanup.fence(scope, token).durable);
    const again = expectOk(await cleanup.fence(scope, token).durable);
    const purged = expectOk(await cleanup.purge(token, { writersStopped: true }));
    const repeated = expectOk(await cleanup.purge(token, { writersStopped: true }));

    expect(again.token).toBe(first.token);
    expect(purged.complete).toBe(true);
    expect(repeated.complete).toBe(true);
    expect(cleanup.deletedScopes()!.scopes.length).toBe(1);
    // The same token for another scope is rejected, not merged.
    const other = cleanup.fence(
      { repositoryId: app.repositoryId, kind: "worktrees", worktrees: [app.main] },
      token,
    );
    expect(expectError(await other.durable).code).toBe("INVALID_INPUT");
  } finally {
    await app.close();
  }
});

test("Residual runtime state keeps the cleanup incomplete and retryable", async () => {
  // A partial failure is neither success nor a rollback.
  const app = await fixture();
  try {
    let failing = true;
    const runtime: RuntimeScopeCleanup = {
      ...storage,
      purgeRuntimeScope: async (...args) => {
        const result = await storage.purgeRuntimeScope(...args);
        if (!failing || !result.ok) return result;
        const residual: RuntimeCleanupReport = {
          ...result.value,
          complete: false,
          residuals: [{ path: "/unverified", reason: "fixture residual" }],
        };
        return { ok: true, value: residual };
      },
    };
    const cleanup = app.cleanup(runtime);
    const { token, durable } = cleanup.fence({
      repositoryId: app.repositoryId,
      kind: "worktrees",
      worktrees: [app.linked],
    });
    expectOk(await durable);

    const partial = expectOk(await cleanup.purge(token, { writersStopped: true }));
    failing = false;
    const retried = expectOk(await cleanup.purge(token, { writersStopped: true }));

    expect(partial.complete).toBe(false);
    expect(partial.receipt.state).toBe("fenced");
    expect(partial.residuals.map((item) => item.path)).toContain("/unverified");
    expect(retried.complete).toBe(true);
  } finally {
    await app.close();
  }
});

test("Restart resumes confirmed receipts before restoration and never creates new ones", async () => {
  // A new coordinator process sees only the durable ledger, not live deletion evidence.
  const app = await fixture();
  try {
    const first = app.cleanup();
    const { token, durable } = first.fence({
      repositoryId: app.repositoryId,
      kind: "repository",
      worktrees: [app.main, app.linked],
    });
    expectOk(await durable);

    const restarted = new WorkspaceCleanup({
      offline: true,
      stateRoot: app.stateRoot,
      registry: new RestoreStateStore(app.daemon.manifest),
    });
    const pending = expectOk(await restarted.resume());

    expect(pending.map((receipt) => receipt.token)).toEqual([token]);
    // A runtime store of the fenced repository cannot write before the purge finishes.
    const store = new RuntimeStore(app.paths);
    expect(expectError(await store.load(app.repositoryId)).code).toBe("CANCELLED");
    expect(expectOk(await restarted.purge(token, { writersStopped: true })).complete).toBe(true);
    expect(expectOk(await app.cleanup().resume())).toEqual([]);
  } finally {
    await app.close();
  }
});

test("A reopened scope accepts fresh state while old session identities stay deleted", async () => {
  // The worktree path was recreated and a new generation starts using the same ID.
  const app = await fixture();
  try {
    const cleanup = app.cleanup();
    const { token, durable } = cleanup.fence({
      repositoryId: app.repositoryId,
      kind: "worktrees",
      worktrees: [app.linked],
      sessionIds: ["tab-b"],
    });
    expectOk(await durable);
    expect(expectError(await cleanup.reopen(token)).code).toBe("INVALID_INPUT");
    expectOk(await cleanup.purge(token, { writersStopped: true }));

    const reopened = expectOk(await cleanup.reopen(token));
    const ui = new UiStateStore(app.daemon.directory, "terminal");
    expectOk(await ui.load(defaultPreferences()));
    ui.acknowledgeCleanup(cleanup.deletedScopes()!.revision);
    const fresh = uiState(app.linked.id, app.main.id, app.repositoryId);
    fresh.preferences.drafts["tab-new"] = "fresh draft";
    expectOk(await ui.save(fresh));

    expect(reopened.state).toBe("reopened");
    const saved = JSON.parse(await readFile(ui.file, "utf8")) as UiState;
    expect(saved.preferences.selection.worktreeId).toBe(app.linked.id);
    expect(saved.preferences.drafts["tab-new"]).toBe("fresh draft");
    expect(saved.preferences.drafts["tab-b"]).toBeUndefined();
    expect(cleanup.deletedScopes()!.scopes[0]!.state).toBe("reopened");
    // A fresh store of the reopened worktree can persist new records again.
    const store = new RuntimeStore(app.paths);
    expectOk(await store.load(app.repositoryId));
    expectOk(await store.save(app.manifest([])));
  } finally {
    await app.close();
  }
});

test("Whole repository cleanup includes historical worktrees absent from current Git rows", async () => {
  const app = await fixture();
  try {
    // A closed index and its preferences retain ownership after Git has lost this worktree.
    const file = await app.sdkFile(app.sdk, "historical", app.linked.path);
    const record = app.record("historical", app.linked, file);
    const original = app.manifest([record]);
    const repositories = original.repositories.map((repository) => ({
      ...repository,
      worktrees: repository.worktrees.filter((tree) => tree.id === app.main.id),
    }));
    const preferences = defaultPreferences();
    preferences.selection = {
      worktreeId: app.linked.id,
      sessions: { [app.linked.id]: record.id },
    };
    preferences.drafts[record.id] = "Historical draft";
    preferences.workViews = { active: { [app.linked.id]: "git" }, agentScroll: {} };
    preferences.terminalViews = {
      active: [app.linked.id],
      selected: { [app.linked.id]: "old-terminal" },
    };
    const manifest: RuntimeManifest = { ...original, repositories, preferences };
    expectOk(await new RuntimeStore(app.paths).save(manifest));
    const ui = new UiStateStore(app.daemon.directory, "historical");
    expectOk(
      await ui.save({
        version: 1,
        view: "chat",
        chatSessionId: null,
        preferences,
        sessionScopes: { [record.id]: app.linked.id },
      }),
    );
    const cleanup = app.cleanup();
    const scope = {
      repositoryId: app.repositoryId,
      kind: "repository" as const,
      worktrees: [app.main],
    };

    // The native receipt knows only current rows; persistent ownership fills in old scopes.
    const pending = cleanup.fence(scope, "historical-whole-repository");
    expectOk(await pending.durable);
    const result = expectOk(await cleanup.purge(pending.token, { writersStopped: true }));

    expect(result.complete).toBe(true);
    expect(await app.exists(app.paths.manifest)).toBe(false);
    expect(result.receipt.worktrees.map((tree) => tree.id)).toContain(app.linked.id);
    const saved = JSON.parse(await readFile(ui.file, "utf8")) as UiState;
    expect(saved.preferences.selection.worktreeId).toBeNull();
    expect(saved.preferences.drafts[record.id]).toBeUndefined();
    expect(saved.preferences.workViews?.active[app.linked.id]).toBeUndefined();
    expect(saved.preferences.terminalViews?.active).not.toContain(app.linked.id);
    expect(saved.preferences.terminalViews?.selected[app.linked.id]).toBeUndefined();
    const navigation = JSON.parse(
      await readFile(join(app.daemon.directory, "ui", "last.json"), "utf8"),
    );
    expect(navigation.selection.worktreeId).toBeNull();
    // Enrichment must not change the meaning of a stable whole-repository evidence token.
    expectOk(await cleanup.fence(scope, pending.token).durable);
    expect(expectOk(await cleanup.purge(pending.token, { writersStopped: true })).complete).toBe(
      true,
    );
  } finally {
    await app.close();
  }
});

test.each(["snapshot", "catalog-copy", "preferences-copy"] as const)(
  "Whole repository cleanup reports historical scopes discovered only in %s",
  async (source) => {
    const app = await fixture();
    try {
      // The published index and Git rows no longer name this scope; its owned snapshot still does.
      const file =
        source === "snapshot" ? await app.sdkFile(app.sdk, "orphan", app.linked.path) : undefined;
      const record = app.record("orphan", app.linked, file ?? join(app.sdk, "orphan.jsonl"));
      const base = app.manifest([]);
      expectOk(
        await new RuntimeStore(app.paths).save({
          ...base,
          repositories: base.repositories.map((repo) => ({
            ...repo,
            worktrees: repo.worktrees.filter((tree) => tree.id === app.main.id),
          })),
        }),
      );
      if (source === "snapshot") {
        const directory = join(app.paths.directory, "sessions");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const key = createHash("sha256").update(sessionRecordKey(record)).digest("hex");
        await writeFile(join(directory, `${key}.json`), JSON.stringify(record), { mode: 0o600 });
      } else {
        const copy: RuntimeManifest =
          source === "catalog-copy"
            ? base
            : {
                ...base,
                repositories: base.repositories.map((repo) => ({
                  ...repo,
                  worktrees: repo.worktrees.filter((tree) => tree.id === app.main.id),
                })),
                preferences: {
                  ...defaultPreferences(),
                  workViews: { active: { [app.linked.id]: "git" }, agentScroll: {} },
                },
              };
        await writeFile(`${app.paths.manifest}.${crypto.randomUUID()}.tmp`, JSON.stringify(copy), {
          mode: 0o600,
        });
      }
      const preferences = defaultPreferences();
      preferences.selection = {
        worktreeId: app.linked.id,
        sessions: source === "snapshot" ? { [app.linked.id]: record.id } : {},
      };
      preferences.workViews = { active: { [app.linked.id]: "git" }, agentScroll: {} };
      const ui = new UiStateStore(app.daemon.directory, "orphan-history");
      expectOk(
        await ui.save({
          version: 1,
          view: "chat",
          chatSessionId: null,
          preferences,
          sessionScopes: { [record.id]: app.linked.id },
          worktreeRepositories: { [app.linked.id]: app.repositoryId },
        }),
      );
      const cleanup = app.cleanup();
      const pending = cleanup.fence(
        {
          repositoryId: app.repositoryId,
          kind: "repository",
          worktrees: [app.main],
        },
        "orphan-history-cleanup",
      );
      expectOk(await pending.durable);

      const result = expectOk(await cleanup.purge(pending.token, { writersStopped: true }));

      expect(result.complete).toBe(true);
      expect(result.receipt.worktrees.map((tree) => tree.id)).toContain(app.linked.id);
      const saved = JSON.parse(await readFile(ui.file, "utf8")) as UiState;
      expect(saved.preferences.selection.worktreeId).toBeNull();
      expect(saved.preferences.workViews?.active[app.linked.id]).toBeUndefined();
    } finally {
      await app.close();
    }
  },
);

test("Invalid scopes are rejected without fencing anything", async () => {
  const app = await fixture();
  try {
    const cleanup = app.cleanup();
    const empty = cleanup.fence({
      repositoryId: app.repositoryId,
      kind: "worktrees",
      worktrees: [],
    });
    const nul = cleanup.fence(
      { repositoryId: app.repositoryId, kind: "worktrees", worktrees: [app.linked] },
      "bad\0token",
    );

    expect(expectError(await empty.durable).code).toBe("INVALID_INPUT");
    expect(expectError(await nul.durable).code).toBe("INVALID_INPUT");
    expect(cleanup.deletedScopes()).toBeUndefined();
  } finally {
    await app.close();
  }
});
