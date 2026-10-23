import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { connectRuntime, fetchSnapshot } from "./client.ts";
import { pidAlive, runtimePaths } from "./storage.ts";
import { WorkspaceClient } from "./workspace-client.ts";

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Workspace runtime observation timed out.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

test("Two repositories share one daemon while SDK, shells, and storage stay isolated across full restart", async () => {
  // Run only two temporary Git repositories and offline SDKs, never user services.
  const a = await createWorktreeFixture(), b = await createWorktreeFixture();
  const options = { offline: true, stateRoot: join(a.directory, "state"), entry: join(import.meta.dir, "..", "index.ts") };
  const repositories = [a.repository, b.repository];
  const aTree = a.repository.worktrees.find((tree) => tree.path === a.main)!, bTree = b.repository.worktrees.find((tree) => tree.path === b.main)!;
  const aPaths = runtimePaths(a.repository.id, true, options.stateRoot), bPaths = runtimePaths(b.repository.id, true, options.stateRoot);
  let workspace: WorkspaceClient | undefined;
  try {
    await writeFile(join(a.main, "workspace.txt"), "isolated-repository-A");
    await writeFile(join(b.main, "workspace.txt"), "isolated-repository-B");
    workspace = expectOk(await WorkspaceClient.open(repositories, a.main, options));
    const aCatalog = expectOk(await fetchSnapshot(aPaths))!, bCatalog = expectOk(await fetchSnapshot(bPaths))!;
    expect(aCatalog.pid).toBe(bCatalog.pid);
    expect(aCatalog.capabilities).toContain("repository-catalog"); expect(bCatalog.capabilities).toContain("repository-catalog");
    expect(aCatalog.details).toEqual({}); expect(bCatalog.details).toEqual({});

    // Activating A must not initialize B's SDK in the shared daemon.
    expectOk(await workspace.activate(aTree.id));
    const aId = expectOk(await workspace.create(aTree.id));
    expect(expectOk(await fetchSnapshot(bPaths))!.capabilities).toContain("repository-catalog");
    const bId = expectOk(await workspace.create(bTree.id));
    expectOk(await workspace.prompt(aId, "read")); expectOk(await workspace.prompt(bId, "read"));
    await until(() => workspace!.snapshot.details[aId]?.output.includes("isolated-repository-A") === true && workspace!.snapshot.details[bId]?.output.includes("isolated-repository-B") === true);
    expect(workspace.snapshot.details[aId]?.output).not.toContain("isolated-repository-B");
    expect(workspace.snapshot.details[bId]?.output).not.toContain("isolated-repository-A");

    // B's PTY creates files only in B and retains existing lease/instance checks.
    const terminal = expectOk(await workspace.createTerminal(bTree.id, { cols: 80, rows: 16 }));
    const failures: unknown[] = [];
    const connection = expectOk(await workspace.attachTerminal(terminal, () => {}, (error) => failures.push(error)));
    connection.input(Buffer.from("printf pool-terminal-b > route-check.txt\r"));
    await until(() => Bun.file(join(b.main, "route-check.txt")).exists());
    expect(await readFile(join(b.main, "route-check.txt"), "utf8")).toBe("pool-terminal-b");
    expect(await Bun.file(join(a.main, "route-check.txt")).exists()).toBe(false);
    expect(failures).toEqual([]);
    const shellPid = workspace.snapshot.terminals!.find((shell) => shell.id === terminal)!.shellPid;
    const aPid = expectOk(await fetchSnapshot(aPaths))!.pid, bPid = expectOk(await fetchSnapshot(bPaths))!.pid;
    expect(aPid).toBe(bPid);
    expect(aPaths.directory).not.toBe(bPaths.directory);
    const preferences = workspace.snapshot.preferences;
    preferences.selection = { worktreeId: bTree.id, sessions: { [aTree.id]: aId, [bTree.id]: bId } };
    preferences.drafts = { [aId]: "draft A", [bId]: "draft B" };
    expectOk(await workspace.savePreferences(preferences));
    await workspace.disconnect();

    // Reconnection reuses daemon/shells and merges both draft sets for restoration.
    workspace = expectOk(await WorkspaceClient.open(repositories, b.main, options));
    expect(expectOk(await fetchSnapshot(aPaths))!.pid).toBe(aPid);
    expect(expectOk(await fetchSnapshot(bPaths))!.pid).toBe(bPid);
    expect(workspace.snapshot.preferences.drafts).toEqual({ [aId]: "draft A", [bId]: "draft B" });
    expect(workspace.snapshot.preferences.selection.worktreeId).toBe(bTree.id);
    expect(workspace.snapshot.terminals!.find((shell) => shell.id === terminal)?.shellPid).toBe(shellPid);
    expect(pidAlive(shellPid)).toBe(true);
    expect(expectOk(await fetchSnapshot(aPaths))!.preferences.drafts).toEqual({ [aId]: "draft A" });
    expect(expectOk(await fetchSnapshot(bPaths))!.preferences.drafts).toEqual({ [bId]: "draft B" });

    // Management commands target shared daemons and all repositories regardless of cwd.
    const config = join(a.directory, "workspace.json");
    await writeFile(config, JSON.stringify({ roots: [a.directory, b.directory] }));
    const administrative = async (command: string): Promise<string> => {
      const child = Bun.spawn([process.execPath, options.entry, "--test-runtime", command, "--runtime-cwd", a.main,
        "--state-dir", options.stateRoot, "--workspace-config", config], { stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(error);
      return output;
    };
    const status = JSON.parse(await administrative("--runtime-status"));
    expect(status.repositoryId).toBe("radian:shared");
    expect(status.repositories.map((repo: { id: string }) => repo.id).sort()).toEqual([a.repository.id, b.repository.id].sort());
    expect(await administrative("--stop-runtime")).toContain("Workspace service stopped");
    await until(() => !pidAlive(aPid));
    expect(expectOk(await fetchSnapshot(aPaths))).toBeNull(); expect(expectOk(await fetchSnapshot(bPaths))).toBeNull();
    expect(pidAlive(shellPid)).toBe(false);
    await workspace.disconnect();

    // Restore both repositories' conversations/drafts in fresh shared processes without moving storage.
    workspace = expectOk(await WorkspaceClient.open(repositories, b.main, options));
    expectOk(await workspace.activate(aTree.id)); expectOk(await workspace.activate(bTree.id));
    expect(workspace.snapshot.details[aId]?.output).toContain("isolated-repository-A");
    expect(workspace.snapshot.details[bId]?.output).toContain("isolated-repository-B");
    expect(workspace.snapshot.preferences.drafts).toEqual({ [aId]: "draft A", [bId]: "draft B" });
    expect(expectOk(await fetchSnapshot(aPaths))!.pid).toBe(expectOk(await fetchSnapshot(bPaths))!.pid);
    expect(expectOk(await fetchSnapshot(aPaths))!.pid).not.toBe(aPid);
  } finally {
    await workspace?.disconnect();
    for (const fixture of [a, b]) {
      const client = expectOk(await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }));
      if (client) {
        const pid = client.snapshot.pid;
        expectOk(await client.stopRuntime()); await client.disconnect();
        await until(() => !pidAlive(pid));
      }
      await fixture.cleanup();
    }
  }
}, 30000);
