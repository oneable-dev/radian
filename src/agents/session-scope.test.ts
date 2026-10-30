import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../result.ts";
import { RepositoryCatalog } from "../workspace/catalog.ts";
import { expectOk } from "../testing/results.ts";
import { SessionRegistry, type SessionContext, type SessionExecutor } from "./session-registry.ts";

test("CHAT checkpoints closed managed children without exposing or independently restoring them", async () => {
  // The registry owns a child SDK file, but only its parent is an independent conversation.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-chat-child-")));
  let parent: SessionContext | undefined;
  let factories = 0;
  const registry = new SessionRegistry(
    new RepositoryCatalog([]),
    async (context) => {
      factories++;
      if (context.role === "main") parent = context;
      const conversationId = `${context.role}-conversation`;
      const sessionFile = join(directory, `${conversationId}.jsonl`);
      await writeFile(
        sessionFile,
        JSON.stringify({ type: "session", id: conversationId, cwd: context.cwd }) + "\n",
      );
      return {
        savedSessionId: conversationId,
        sessionFile,
        state: {
          status: "complete",
          output: `${context.role} output`,
          finalOutput: `${context.role} output`,
          error: null,
        },
        subscribe: () => () => {},
        prompt: async () => ok(undefined),
        close: async () => ok(undefined),
      };
    },
    "chat",
  );
  try {
    const main = expectOk(await registry.createChat());

    // Completed child cleanup must produce its own retention record instead of an orphan SDK file.
    expect(expectOk(await parent!.spawnSubagent("fixture", "Complete the child task"))).toBe(
      "subagent output",
    );
    const records = registry.checkpointRecords;
    const child = records.find((record) => record.role === "subagent")!;
    expect(child).toMatchObject({
      scope: { kind: "chat" },
      role: "subagent",
      lifecycle: "closed",
      managed: true,
      cwd: homedir(),
      state: { conversationId: "subagent-conversation" },
    });
    expect(child.closedAt).toBeNumber();
    expect(registry.chatSessions.map((entry) => entry.id)).toEqual([main]);

    // Even stale metadata calling restore directly must never turn a child into a main executor.
    expectOk(await registry.restore({ ...child, lifecycle: "open" }));
    expect(factories).toBe(2);
    expect(registry.chatSessions.map((entry) => entry.id)).toEqual([main]);
    registry.acknowledgeCheckpoint(records);
    expect(registry.checkpointRecords.some((record) => record.role === "subagent")).toBe(false);
  } finally {
    expectOk(await registry.shutdown());
    await rm(directory, { recursive: true, force: true });
  }
});

test("CHAT registry uses homedir for cwd and explicit relative attachments without a worktree", async () => {
  // The factory receives a scope, never a fabricated repository/worktree identity.
  let context: SessionContext | undefined;
  let attachments: readonly string[] | undefined;
  const executor: SessionExecutor = {
    savedSessionId: "conversation",
    sessionFile: undefined,
    acceptsImages: true,
    state: { status: null, output: "", error: null },
    subscribe: () => () => {},
    prompt: async (_text, accepted, paths) => {
      attachments = paths;
      accepted?.();
      return ok(undefined);
    },
    close: async () => ok(undefined),
  };
  const registry = new SessionRegistry(
    new RepositoryCatalog([]),
    async (created) => {
      context = created;
      return executor;
    },
    "chat",
  );
  const created = await registry.createChat();
  expect(created.ok).toBe(true);
  if (!created.ok) throw created.error;
  expect(context?.scope).toEqual({ kind: "chat" });
  expect(context?.worktreeId).toBeUndefined();
  expect(context?.cwd).toBe(homedir());
  expect(
    (await registry.prompt(created.value, "Analyze the image", undefined, ["Pictures/pic.png"])).ok,
  ).toBe(true);
  expect(attachments).toEqual([join(homedir(), "Pictures/pic.png")]);
  expect(registry.snapshot).toEqual([]);
  expect((await registry.shutdown()).ok).toBe(true);
});
