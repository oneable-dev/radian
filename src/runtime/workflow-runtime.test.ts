import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { SessionRegistry } from "../agents/session-registry.ts";
import { ok } from "../result.ts";
import { openRepositoryRuntime } from "./service.ts";
import { RuntimeClient } from "./client.ts";
import { runtimePaths } from "./storage.ts";
import { replySchema, type RuntimeCommand } from "./protocol.ts";
import { AccountManager } from "../accounts/manager.ts";
import { ChatRuntime } from "./chat-runtime.ts";

test("workflow client and legacy wire commands acquire user provenance only at the repository host", async () => {
  // Use a real loopback runtime while replacing the workflow operation, never model transport.
  const fixture = await createWorktreeFixture();
  const paths = runtimePaths(fixture.repository.id, true, join(fixture.directory, "state"));
  const runtime = expectOk(
    await openRepositoryRuntime(
      fixture.repository.id,
      true,
      crypto.randomUUID(),
      join(fixture.directory, "state"),
    ),
  );
  const server = Bun.serve({ unix: paths.socket, fetch: (request) => runtime.fetch(request) });
  const request = (command: RuntimeCommand) =>
    runtime.fetch(
      new Request("http://localhost/command", {
        method: "POST",
        headers: { "X-Radian-Instance": runtime.instance },
        body: JSON.stringify(command),
      }),
    );
  const created: unknown = await (
    await request({ type: "create", worktreeId: fixture.repository.worktrees[0]!.id })
  ).json();
  if (!Value.Check(replySchema, created) || !created.ok || !created.value)
    throw new Error("Missing fixture session.");
  const sessionId = created.value;
  const conversationId = runtime.snapshot.details[sessionId]!.conversationId!;
  const client = new RuntimeClient(paths, runtime.snapshot);
  const workflow = spyOn(SessionRegistry.prototype, "workflow").mockResolvedValue(
    ok("Host workflow notice"),
  );
  const prompt = spyOn(SessionRegistry.prototype, "prompt").mockResolvedValue(ok(undefined));
  try {
    expectOk(await client.prompt(sessionId, "/workflow start A --auto-repair"));
    expectOk(await client.prompt(sessionId, "/workflow confirm receipt"));
    const legacy = { type: "prompt", sessionId, conversationId, text: "/workflow status" } as const;
    expect((await request(legacy)).status).toBe(200);
    expect(workflow).toHaveBeenCalledTimes(3);
    expect(workflow.mock.calls[0]!.slice(0, 3)).toEqual([
      sessionId,
      conversationId,
      { kind: "start", tasks: ["A"], autoRepair: true },
    ]);
    for (const call of workflow.mock.calls)
      expect(call[3]).toMatchObject({ kind: "user-command", conversationId });
    expect(prompt).not.toHaveBeenCalled();
    for (const command of [
      { ...legacy, conversationId: "stale" },
      { ...legacy, images: ["/image.png"] },
      { ...legacy, text: "/workflow confirm" },
    ])
      expect(await (await request(command)).json()).toMatchObject({ ok: false });
    expect(workflow).toHaveBeenCalledTimes(3);
    const catalog = expectOk(await client.catalog(sessionId));
    expect(catalog.items.filter((item) => item.value === "workflow")).toHaveLength(1);
  } finally {
    workflow.mockRestore();
    prompt.mockRestore();
    await client.disconnect();
    await server.stop(true);
    expectOk(await runtime.stop());
    await fixture.cleanup();
  }
});

test("CHAT enforces the same workflow command identity and never forwards it to model prompts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-workflow-chat-"));
  const accounts = expectOk(
    await AccountManager.open(join(directory, "daemon"), { offline: true }),
  );
  const chat = expectOk(await ChatRuntime.open(join(directory, "daemon"), accounts, true));
  const id = expectOk(await chat.create());
  const conversationId = chat.snapshot.details[id]!.conversationId!;
  const workflow = spyOn(chat.registry, "workflow").mockResolvedValue(ok("Workflow status"));
  const prompt = spyOn(chat.registry, "prompt").mockResolvedValue(ok(undefined));
  try {
    expectOk(
      await chat.command({
        type: "workflow-control",
        sessionId: id,
        conversationId,
        command: { kind: "pause" },
      }),
    );
    expectOk(
      await chat.command({
        type: "prompt",
        sessionId: id,
        conversationId,
        text: "/workflow cancel inv",
      }),
    );
    expect(
      await chat.command({
        type: "workflow-control",
        sessionId: id,
        conversationId: "stale",
        command: { kind: "confirm", id: "receipt" },
      }),
    ).toMatchObject({ ok: false });
    expect(workflow).toHaveBeenCalledTimes(2);
    expect(workflow.mock.calls[1]![2]).toEqual({ kind: "cancel", id: "inv" });
    expect(workflow.mock.calls[1]![3]).toMatchObject({ kind: "user-command", conversationId });
    expect(prompt).not.toHaveBeenCalled();
  } finally {
    workflow.mockRestore();
    prompt.mockRestore();
    expectOk(await chat.stop());
    expectOk(await accounts.stop());
    await rm(directory, { recursive: true, force: true });
  }
});
