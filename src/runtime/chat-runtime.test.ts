import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../accounts/manager.ts";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
import { ChatRuntime } from "./chat-runtime.ts";
import { expectError, expectOk } from "../testing/results.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function open() {
  const directory = await mkdtemp(join(tmpdir(), "radian-chat-test-"));
  directories.push(directory);
  const accounts = await AccountManager.open(join(directory, "daemon"), { offline: true });
  if (!accounts.ok) throw accounts.error;
  const chat = await ChatRuntime.open(join(directory, "daemon"), accounts.value, true);
  if (!chat.ok) throw chat.error;
  return { chat: chat.value, accounts: accounts.value, directory };
}

test("CHAT uses homedir without repository or worktree and resumes a single saved conversation", async () => {
  // Only the daemon's CHAT scope is available; no project catalog or worktree exists.
  const { chat, accounts, directory } = await open();
  const created = await chat.create();
  expect(created.ok).toBe(true);
  if (!created.ok) throw created.error;
  const first = chat.snapshot.sessions.find((session) => session.id === created.value);
  expect(chat.snapshot.id).toBe(CHAT_SCOPE_ID);
  expect(chat.snapshot.path).toBe(homedir());
  expect(first?.id).toBe(created.value);
  expect(chat.registry.snapshot).toEqual([]);
  // Model selection requires completed SDK cleanup, not just the final streaming event.
  expectOk(await chat.registry.prompt(created.value, "hello"));
  const conversationId = chat.snapshot.details[created.value]?.conversationId;
  expect(conversationId).toBeTruthy();
  expect(chat.snapshot.details[created.value]?.output).toContain("Offline SDK fixture");

  // A second client choosing the same identity reuses the original executor.
  const resumed = await chat.resume(conversationId!);
  expect(resumed).toEqual({ ok: true, value: created.value });
  expect(chat.snapshot.sessions).toHaveLength(1);
  const changedModel = await chat.selectModel(created.value, conversationId!, {
    provider: "radian-offline",
    id: "fixture",
  });
  expectOk(changedModel);
  const listed = await chat.listHistory();
  expect(listed.ok).toBe(true);
  if (listed.ok)
    expect(listed.value.find((item) => item.id === conversationId)?.openSessionId).toBe(
      created.value,
    );
  const checkpoint = await chat.stop();
  expect(checkpoint.ok).toBe(true);
  const saved = JSON.parse(
    await readFile(join(directory, "daemon/chat/conversations.json"), "utf8"),
  );
  expect(saved.version).toBe(2);
  expect(saved.defaults).toMatchObject({ provider: "radian-offline", model: "fixture" });
  expect(saved.records[0].worktreeId).toBeUndefined();
  expect(saved.records[0].cwd).toBe(homedir());
  const body = JSON.parse(
    await readFile(join(directory, "daemon/chat/sessions", `${saved.records[0].key}.json`), "utf8"),
  );
  expect(body.scope).toEqual({ kind: "chat" });
  expect(body.worktreeId).toBeUndefined();
  const reopened = await ChatRuntime.open(join(directory, "daemon"), accounts, true);
  expect(reopened.ok).toBe(true);
  if (reopened.ok) {
    expect(reopened.value.snapshot.sessions).toHaveLength(1);
    expect(reopened.value.snapshot.details[created.value]?.status).not.toBe("working");
    expect((await reopened.value.stop()).ok).toBe(true);
  }
  await accounts.stop();
});

test("CHAT persists managed child cleanup without exposing a child as an independent conversation", async () => {
  // A real offline SDK delegation creates a child file under the daemon's owned CHAT directory.
  const { chat, accounts, directory } = await open();
  let reopened: ChatRuntime | undefined;
  try {
    const main = expectOk(await chat.create());
    const started = Promise.withResolvers<void>();
    const unsubscribe = chat.subscribe(() => {
      const child = chat.snapshot.sessions[0]?.subagents[0];
      if (child?.status === "working" && child.runTiming) started.resolve();
    });
    const timeout = setTimeout(
      () => started.reject(new Error("Owned CHAT child did not start.")),
      3000,
    );
    const running = chat.registry.prompt(main, "delegate");
    try {
      await started.promise;
      // Cancellation closes owned child execution without closing or replacing its parent.
      expectOk(await chat.registry.interrupt(main));
      expect(expectError(await running).code).toBe("CANCELLED");
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }
    const child = chat.registry.records[0]!.ownedSubagents![0]!;
    const childFile = child.sessionFile!;
    const childId = JSON.parse((await readFile(childFile, "utf8")).split("\n")[0]!).id;
    expect(childFile.startsWith(join(chat.store.sessionDir, "subagents") + "/")).toBe(true);
    expect(expectOk(await chat.listHistory()).map((item) => item.openSessionId)).toEqual([main]);
    expect(expectError(await chat.previewHistory(childId)).code).toBe("HISTORY_UNAVAILABLE");
    expect(expectError(await chat.resume(childId)).code).toBe("HISTORY_UNAVAILABLE");
    expectOk(await chat.stop());
    const saved = JSON.parse(
      await readFile(join(chat.store.directory, "conversations.json"), "utf8"),
    );
    expect(
      saved.records.find((record: { conversationId: string }) => record.conversationId === childId),
    ).toMatchObject({ role: "subagent", lifecycle: "closed", managed: true });

    // Restart restores only the parent, and retention safely removes the closed managed child.
    reopened = expectOk(await ChatRuntime.open(join(directory, "daemon"), accounts, true));
    expect(reopened.snapshot.sessions.map((item) => item.id)).toEqual([main]);
    expect(expectOk(await reopened.listHistory())).toHaveLength(1);
    expect(expectError(await reopened.previewHistory(childId)).code).toBe("HISTORY_UNAVAILABLE");
    expect(
      expectOk(
        await reopened.store.prune(0, (entry, file) =>
          reopened!.registry.reserveSnapshotCleanup({ ...entry, scope: { kind: "chat" } }, file),
        ),
      ),
    ).toBe(1);
    expect(await Bun.file(childFile).exists()).toBe(false);
    expect(await Bun.file(reopened.registry.sessionFile(main)!).exists()).toBe(true);
  } finally {
    if (reopened) expectOk(await reopened.stop());
    else expectOk(await chat.stop());
    expectOk(await accounts.stop());
  }
});

test("CHAT shutdown checkpoints children that settle during teardown while keeping main open intent", async () => {
  // A live child must remain eligible for safe cleanup even when daemon shutdown causes its termination.
  const { chat, accounts, directory } = await open();
  let reopened: ChatRuntime | undefined;
  try {
    const main = expectOk(await chat.create());
    const mainConversation = chat.snapshot.details[main]!.conversationId;
    const started = Promise.withResolvers<void>();
    const unsubscribe = chat.subscribe(() => {
      const child = chat.snapshot.sessions[0]?.subagents[0];
      if (child?.status === "working" && child.runTiming) started.resolve();
    });
    const timeout = setTimeout(
      () => started.reject(new Error("Owned CHAT child did not start.")),
      3000,
    );
    const running = chat.registry.prompt(main, "delegate");
    try {
      await started.promise;
      expectOk(await chat.stop());
      expect(expectError(await running).code).toBe("CANCELLED");
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }
    const saved = JSON.parse(
      await readFile(join(chat.store.directory, "conversations.json"), "utf8"),
    );
    const child = saved.records.find((record: { role?: string }) => record.role === "subagent");
    expect(child).toMatchObject({ role: "subagent", lifecycle: "closed", managed: true });
    expect(
      saved.records.find(
        (record: { conversationId: string }) => record.conversationId === mainConversation,
      ),
    ).toMatchObject({ lifecycle: "open" });

    // Only the parent returns as a conversation; the teardown child's SDK file can expire.
    reopened = expectOk(await ChatRuntime.open(join(directory, "daemon"), accounts, true));
    expect(reopened.snapshot.sessions.map((item) => item.id)).toEqual([main]);
    expect(expectOk(await reopened.listHistory())).toHaveLength(1);
    expect(
      expectOk(
        await reopened.store.prune(0, (entry, file) =>
          reopened!.registry.reserveSnapshotCleanup({ ...entry, scope: { kind: "chat" } }, file),
        ),
      ),
    ).toBe(1);
    expect(await Bun.file(child.sessionFile).exists()).toBe(false);
    expect(await Bun.file(reopened.registry.sessionFile(main)!).exists()).toBe(true);
  } finally {
    expectOk(await (reopened ?? chat).stop());
    expectOk(await accounts.stop());
  }
});

test.each(["id", "cwd"] as const)(
  "CHAT archived history lists index summaries and validates selected SDK %s lazily",
  async (field) => {
    // Closed conversations have snapshots, but neither startup nor listing may read their bodies.
    const { chat, accounts, directory } = await open();
    let reopened: ChatRuntime | undefined;
    const id = expectOk(await chat.create());
    expectOk(await chat.registry.prompt(id, "Archived summary"));
    const savedId = chat.snapshot.details[id]!.conversationId!;
    const sessionFile = chat.registry.sessionFile(id)!;
    expectOk(await chat.close(id));
    expectOk(await chat.stop());
    await writeFile(
      join(chat.store.sessionDir, "unindexed.jsonl"),
      "External files are not CHAT conversations.\n",
    );
    const source = await readFile(sessionFile, "utf8");
    const lines = source.split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), [field]: "changed-externally" });
    await writeFile(sessionFile, lines.join("\n"));
    const scan = spyOn(SessionManager, "listAll").mockRejectedValue(
      new Error("CHAT must not scan archived SDK transcripts."),
    );
    const reads = spyOn(fs, "readFile");
    const opens = spyOn(fs, "open");
    try {
      reopened = expectOk(await ChatRuntime.open(join(directory, "daemon"), accounts, true));
      const history = expectOk(await reopened.listHistory());

      // Even a changed archived body keeps its cached summary; arbitrary external files stay undiscovered.
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        id: savedId,
        title: "Archived summary",
        openSessionId: null,
      });
      expect(reads.mock.calls.map(([path]) => path)).toEqual([
        join(chat.store.directory, "conversations.json"),
      ]);
      expect(opens).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(reopened.snapshot.sessions).toHaveLength(0);

      // Cached previews and resume still refuse the selected file's changed identity or cwd.
      expect(expectError(await reopened.previewHistory(savedId)).code).toBe("HISTORY_UNAVAILABLE");
      expect(expectError(await reopened.resume(savedId)).code).toBe("HISTORY_UNAVAILABLE");
      expect(scan).not.toHaveBeenCalled();
      expect(reopened.snapshot.sessions).toHaveLength(0);
    } finally {
      scan.mockRestore();
      reads.mockRestore();
      opens.mockRestore();
      if (reopened) expectOk(await reopened.stop());
      expectOk(await accounts.stop());
    }
  },
);

test("CHAT rejects file completion but retains command and skill completion", async () => {
  // File completion must never start a watcher or enumerate the home directory.
  const { chat, accounts } = await open();
  const created = await chat.create();
  if (!created.ok) throw created.error;
  const files = await chat.registry.complete(created.value, { kind: "file", query: "secret" });
  expect(files.ok).toBe(false);
  const commands = await chat.registry.complete(created.value, { kind: "command", query: "model" });
  expect(commands.ok).toBe(true);
  expect((await chat.stop()).ok).toBe(true);
  await accounts.stop();
});
