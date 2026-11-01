import { expect, test } from "bun:test";
import { join } from "node:path";
import { workspaceSource } from "../app/settings.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { defaultPreferences } from "./client.ts";
import { snapshotEvents } from "./events.ts";
import type { RuntimeSnapshot } from "./protocol.ts";
import { daemonPaths, privateDirectory, runtimePaths } from "./storage.ts";
import { WorkspaceClient } from "./workspace-client.ts";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Managed workspace update was not observed.");
    await Bun.sleep(5);
  }
}

test("An attached TUI preserves CODE entries and drafts while the shared daemon advertises startup", async () => {
  // Controlled wire snapshots reproduce reconnect ordering without starting a real daemon or model.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "state");
  const management = daemonPaths(true, stateRoot);
  const repository = runtimePaths(fixture.repository.id, true, stateRoot);
  await privateDirectory(management.directory);
  await privateDirectory(repository.directory);
  const preferences = defaultPreferences();
  preferences.drafts.pending = "keep the disconnected draft";
  const code: RuntimeSnapshot = {
    version: 1,
    pid: process.pid,
    instance: "code-owner",
    repositoryId: fixture.repository.id,
    mode: "offline",
    capabilities: ["shared-daemon", "repository-catalog"],
    repositories: [fixture.repository],
    details: {},
    closingCount: 0,
    preferences,
    notice: "",
  };
  let shared: RuntimeSnapshot = {
    ...code,
    instance: "shared-owner",
    repositoryId: "radian:shared",
    capabilities: ["shared-daemon", "workspace-source", "chat-sessions"],
    preferences: defaultPreferences(),
  };
  const listeners = new Set<() => void>();
  const managementServer = Bun.serve({
    unix: management.socket,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/snapshot") return Response.json(shared);
      if (path === "/events")
        return snapshotEvents(
          () => shared,
          (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        );
      if (path === "/workspace" || path === "/chat-config")
        return Response.json({ ok: true, value: null });
      return new Response("Not found", { status: 404 });
    },
  });
  const codeServer = Bun.serve({
    unix: repository.socket,
    fetch(request) {
      return new URL(request.url).pathname === "/events"
        ? snapshotEvents(
            () => code,
            () => () => {},
          )
        : Response.json(code);
    },
  });
  let workspace: WorkspaceClient | undefined;
  try {
    workspace = expectOk(
      await WorkspaceClient.attach(workspaceSource({ cwd: fixture.main }), {
        offline: true,
        stateRoot,
      }),
    );
    let updates = 0;
    const unsubscribe = workspace.subscribe(() => updates++);
    try {
      const before = updates;
      // A reconnect can deliver this valid but incomplete management snapshot before restoration finishes.
      shared = {
        ...shared,
        repositories: [],
        capabilities: [...shared.capabilities!, "daemon-starting"],
      };
      for (const listener of listeners) listener();
      await until(() => updates > before);

      expect(workspace.snapshot.repositories.map((repo) => repo.id)).toEqual([
        fixture.repository.id,
      ]);
      expect(workspace.snapshot.preferences.drafts.pending).toBe("keep the disconnected draft");
      const pending = updates;
      shared = {
        ...shared,
        repositories: [fixture.repository],
        capabilities: shared.capabilities!.filter((capability) => capability !== "daemon-starting"),
      };
      for (const listener of listeners) listener();
      await until(() => updates > pending);
      expect(workspace.snapshot.repositories.map((repo) => repo.id)).toEqual([
        fixture.repository.id,
      ]);
    } finally {
      unsubscribe();
    }
  } finally {
    await workspace?.disconnect();
    await managementServer.stop(true);
    await codeServer.stop(true);
    await fixture.cleanup();
  }
});
