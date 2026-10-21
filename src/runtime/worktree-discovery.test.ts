import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import { connectRuntime, fetchSnapshot, type RuntimeClient } from "./client.ts";
import { WorkspaceClient } from "./workspace-client.ts";
import { pidAlive, runtimePaths } from "./storage.ts";

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Worktree catalog update was not observed.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function fixtureRuntime() {
  const fixture = await createWorktreeFixture();
  const options = { offline: true, stateRoot: join(fixture.directory, "state"), entry: join(import.meta.dir, "..", "index.ts") };
  const paths = runtimePaths(fixture.repository.id, true, options.stateRoot);
  const clients: RuntimeClient[] = [];
  return { ...fixture, options, paths,
    async connect() {
      const client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
      if (!client) throw new Error("Missing test runtime.");
      clients.push(client); return client;
    },
    async cleanup() {
      const client = expectOk(await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }));
      if (client) {
        const pid = client.snapshot.pid;
        expectOk(await client.stopRuntime()); await client.disconnect();
        await until(() => !pidAlive(pid));
      }
      await Promise.all(clients.map((client) => client.disconnect()));
      await fixture.cleanup();
    },
  };
}

test("외부 Git 워크트리 생성은 같은 데몬에서 감지하고 세션·History·Editor·Terminal에 즉시 사용할 수 있다", async () => {
  // The fixture owns the daemon, SDK sessions, editor and shell; user services are never restarted.
  const app = await fixtureRuntime();
  try {
    const client = await app.connect(), main = app.repository.worktrees.find((tree) => tree.path === app.main)!;
    const session = expectOk(await client.create(main.id));
    const preferences = client.snapshot.preferences;
    preferences.selection = { worktreeId: main.id, sessions: { [main.id]: session } };
    preferences.drafts = { [session]: "keep my input" };
    expectOk(await client.savePreferences(preferences));
    expectOk(await client.prompt(session, "slow"));
    await until(() => client.snapshot.details[session]?.status === "working");
    const conversation = client.snapshot.details[session]?.conversationId;
    const selection = new WorkspaceSelection(client.snapshot.repositories);
    selection.restore(preferences.selection);
    const unsubscribe = client.subscribe(() => selection.replaceSnapshot(client.snapshot.repositories));
    const pid = client.snapshot.pid, instance = client.snapshot.instance;
    try {
      // A worktree created by any external process must become usable without daemon restart.
      const added = join(app.directory, "added");
      await app.git(app.main, ["worktree", "add", "-b", "feature/dynamic", added]);
      await writeFile(join(added, "workspace.txt"), "dynamically-added-worktree");
      await until(() => client.snapshot.repositories[0]!.worktrees.some((tree) => tree.path === added));
      expect(client.snapshot.pid).toBe(pid); expect(client.snapshot.instance).toBe(instance);
      expect(client.snapshot.details[session]?.status).toBe("working");
      expect(client.snapshot.details[session]?.conversationId).toBe(conversation);
      expect(client.snapshot.preferences.drafts[session]).toBe("keep my input");
      expect(selection.worktree?.id).toBe(main.id); expect(selection.sessionId).toBe(session);
      expectOk(await client.listHistory(added));
      const addedSession = expectOk(await client.create(added));
      expectOk(await client.prompt(addedSession, "read"));
      await until(() => client.snapshot.details[addedSession]?.output.includes("dynamically-added-worktree") === true);
      const editor = expectOk(await client.openEditor(added, { cols: 80, rows: 20 }));
      const terminal = expectOk(await client.createTerminal(added, { cols: 80, rows: 20 }));
      await until(() => client.snapshot.editors?.some((item) => item.id === editor && item.worktreeId === added) === true);
      const errors: unknown[] = [];
      const connection = expectOk(await client.attachTerminal(terminal, () => {}, (error) => errors.push(error)));
      connection.input(Buffer.from("printf dynamic-terminal > dynamic-terminal.txt\r"));
      await until(() => Bun.file(join(added, "dynamic-terminal.txt")).exists());

      // Every consumer resolves the added worktree's actual cwd, not the original startup snapshot.
      expect(await readFile(join(added, "dynamic-terminal.txt"), "utf8")).toBe("dynamic-terminal");
      expect(await Bun.file(join(app.main, "dynamic-terminal.txt")).exists()).toBe(false);
      expect(errors).toEqual([]);
      await app.git(app.main, ["worktree", "remove", "--force", app.feature]);
      await until(() => !client.snapshot.repositories[0]!.worktrees.some((tree) => tree.path === app.feature));
      expect(client.snapshot.preferences.drafts[session]).toBe("keep my input");
    } finally { unsubscribe(); }
  } finally { await app.cleanup(); }
}, 25000);

test("삭제된 워크트리의 열린 세션은 보존하고 마지막 세션을 닫은 뒤 행을 정리한다", async () => {
  const app = await fixtureRuntime();
  try {
    const client = await app.connect();
    const id = expectOk(await client.create(app.feature));

    // Removing Git registration must not silently dispose a session owned by the daemon.
    await app.git(app.main, ["worktree", "remove", "--force", app.feature]);
    await until(() => client.snapshot.repositories[0]!.worktrees.some((tree) => tree.path === app.feature && tree.sessions.some((session) => session.id === id)));
    const added = join(app.directory, "after-removal");
    await app.git(app.main, ["worktree", "add", "-b", "after-removal", added]);
    await until(() => client.snapshot.repositories[0]!.worktrees.some((tree) => tree.path === added));
    expect(client.snapshot.repositories[0]!.worktrees.find((tree) => tree.path === app.feature)?.sessions.map((session) => session.id)).toContain(id);
    expectOk(await client.closeSession(id));
    await until(() => !client.snapshot.repositories[0]!.worktrees.some((tree) => tree.path === app.feature));

    expect(client.snapshot.closingCount).toBe(0);
  } finally { await app.cleanup(); }
}, 20000);

test("공용 데몬은 SDK를 시작하지 않은 저장소도 감시하고 같은 프로세스에서 활성화한다", async () => {
  const app = await fixtureRuntime();
  let workspace: WorkspaceClient | undefined;
  try {
    workspace = expectOk(await WorkspaceClient.open([app.repository], app.main, app.options));
    const catalog = expectOk(await fetchSnapshot(app.paths))!;
    expect(catalog.capabilities).toContain("repository-catalog");
    const selection = new WorkspaceSelection(workspace.snapshot.repositories);
    const main = selection.worktree!.id;
    const unsubscribe = workspace.subscribe(() => selection.replaceSnapshot(workspace!.snapshot.repositories));
    try {
      // Shared catalog watching must not allocate SDK/Editor/Terminal resources.
      const added = join(app.directory, "cold-added");
      await app.git(app.main, ["worktree", "add", "-b", "cold-added", added]);
      await until(() => workspace!.snapshot.repositories[0]!.worktrees.some((tree) => tree.path === added));
      const updated = expectOk(await fetchSnapshot(app.paths))!;
      expect(updated.pid).toBe(catalog.pid); expect(updated.instance).toBe(catalog.instance);
      expect(updated.capabilities).toContain("repository-catalog");
      expect(updated.details).toEqual({}); expect(updated.editors).toEqual([]); expect(updated.terminals).toEqual([]);
      expect(selection.worktree?.id).toBe(main);
      expectOk(await workspace.activate(added));
      const active = expectOk(await fetchSnapshot(app.paths))!;
      expect(active.pid).toBe(catalog.pid); expect(active.instance).toBe(catalog.instance);
      expect(active.capabilities).toContain("repository-runtime");
      const id = expectOk(await workspace.create(added));
      expectOk(await workspace.prompt(id, "read"));
      await until(() => workspace!.snapshot.details[id]?.output.includes("main-worktree-marker") === true);
      await app.git(added, ["switch", "-c", "after-activation"]);
      await until(() => workspace!.snapshot.repositories[0]!.worktrees.some((tree) => tree.path === added && tree.branch === "after-activation"));

      expect(workspace.snapshot.notice).toBe("");
      expect(workspace.hasSnapshot(added)).toBe(true);
    } finally { unsubscribe(); }
  } finally { await workspace?.disconnect(); await app.cleanup(); }
}, 20000);
