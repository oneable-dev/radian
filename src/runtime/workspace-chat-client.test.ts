import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
import { ok } from "../result.ts";
import { expectOk } from "../testing/results.ts";
import { RuntimeClient, defaultPreferences } from "./client.ts";
import * as lifecycle from "./lifecycle.ts";
import type { RuntimeSnapshot } from "./protocol.ts";
import { daemonPaths } from "./storage.ts";
import { WorkspaceClient } from "./workspace-client.ts";

class SnapshotClient extends RuntimeClient {
  online = true;
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
    return this.online;
  }
  override subscribe(listener: () => void) {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }
  publish() {
    for (const observer of this.observers) observer();
  }
}

async function fixture(
  run: (workspace: WorkspaceClient, code: SnapshotClient, chat: SnapshotClient) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "radian-workspace-chat-"));
  const repository = {
    id: "/fixture/.git",
    name: "fixture",
    worktrees: [
      {
        id: "tree",
        path: "/fixture",
        name: "main",
        branch: "main",
        sessions: [{ id: "code", name: "CODE", status: null, subagents: [] }],
      },
    ],
  };
  const snapshot: RuntimeSnapshot = {
    version: 1,
    pid: process.pid,
    instance: "daemon",
    repositoryId: repository.id,
    mode: "offline",
    repositories: [repository],
    preferences: defaultPreferences(),
    details: {
      code: {
        conversationId: "code-old",
        resourceRevision: 0,
        status: null,
        output: "stale",
        error: null,
      },
    },
    closingCount: 0,
    notice: "",
    capabilities: ["shared-daemon"],
    chat: {
      id: CHAT_SCOPE_ID,
      path: homedir(),
      name: "CHAT",
      sessions: [{ id: "chat", name: "CHAT", status: null, subagents: [] }],
      details: {
        chat: {
          conversationId: "chat-first",
          resourceRevision: 0,
          status: null,
          output: "chat",
          error: null,
        },
      },
      historyRevision: 0,
      accountsRevision: 0,
      closingCount: 0,
    },
  };
  const code = new SnapshotClient(root, structuredClone(snapshot));
  const chat = new SnapshotClient(root, structuredClone(snapshot));
  const connectCode = spyOn(lifecycle, "connectRuntime").mockResolvedValue(ok(code));
  const connectChat = spyOn(lifecycle, "connectChatRuntime").mockResolvedValue(ok(chat));
  let workspace: WorkspaceClient | undefined;
  try {
    workspace = expectOk(
      await WorkspaceClient.open(
        [repository],
        "/fixture",
        { stateRoot: root },
        lifecycle.connectRuntime,
      ),
    );
    await run(workspace, code, chat);
  } finally {
    await workspace?.disconnect();
    connectCode.mockRestore();
    connectChat.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}

test("CHAT channel snapshots never overwrite fresh CODE streaming, model or replacement details", () =>
  fixture(async (workspace, code, chat) => {
    // CHAT attached after a CODE conversation already existed and retained its stale daemon-wide details.
    expect(workspace.snapshot.details.code?.output).toBe("stale");
    for (const state of [
      {
        conversationId: "code-old",
        resourceRevision: 1,
        status: "working" as const,
        output: "streaming",
        error: null,
      },
      {
        conversationId: "code-old",
        resourceRevision: 2,
        status: "complete" as const,
        output: "done",
        error: null,
      },
      { conversationId: "code-new", resourceRevision: 0, status: null, output: "", error: null },
    ]) {
      // Only the repository event stream has observed the prompt, model change, or /clear.
      code.current = { ...code.current, details: { code: state } };
      code.publish();

      // The workspace must expose each update immediately, without waiting for a CHAT heartbeat.
      expect(workspace.snapshot.details.code).toEqual(state);
      expect(workspace.snapshot.details.chat).toEqual(chat.current.chat!.details.chat);
      expect(chat.current.details.code?.output).toBe("stale");
    }
  }));

test.each(["models", "accounts", "history"] as const)(
  "CHAT %s cache identity tracks reload, conversation replacement, reconnect and daemon replacement",
  (kind) =>
    fixture(async (workspace, _code, chat) => {
      // A failed preload can be cached even when the daemon has no new account or history revision.
      const initial = workspace.dataIdentity(CHAT_SCOPE_ID, kind);
      expect(initial).toBeDefined();
      chat.publish();
      expect(workspace.dataIdentity(CHAT_SCOPE_ID, kind)).toBe(initial);
      const identities = [initial];

      // Reload and replacement can change model/resources without changing account or history revisions.
      for (const state of [
        { conversationId: "chat-first", resourceRevision: 1 },
        { conversationId: "chat-next", resourceRevision: 0 },
      ]) {
        chat.current = {
          ...chat.current,
          chat: {
            ...chat.current.chat!,
            details: { chat: { ...chat.current.chat!.details.chat!, ...state } },
          },
        };
        chat.publish();
        identities.push(workspace.dataIdentity(CHAT_SCOPE_ID, kind));
      }
      chat.online = false;
      chat.publish();
      chat.online = true;
      chat.publish();
      identities.push(workspace.dataIdentity(CHAT_SCOPE_ID, kind));
      chat.current = { ...chat.current, instance: "daemon-next" };
      chat.publish();
      identities.push(workspace.dataIdentity(CHAT_SCOPE_ID, kind));

      // All invalidation boundaries remain distinct even if shared data revisions have not changed.
      expect(new Set(identities).size).toBe(5);
      expect(chat.current.chat).toMatchObject({ accountsRevision: 0, historyRevision: 0 });
      expect(workspace.recoveryVersion).toBe(1);
    }),
);

test("CHAT completion identity changes on reload, clear, reconnect and daemon replacement", () =>
  fixture(async (workspace, _code, chat) => {
    // Unrelated snapshots keep an exact cache key; CHAT never needs a file index to invalidate it.
    const initial = workspace.completionIdentity("chat");
    chat.publish();
    expect(workspace.completionIdentity("chat")).toBe(initial);
    const identities = [initial];

    chat.current = {
      ...chat.current,
      chat: {
        ...chat.current.chat!,
        details: { chat: { ...chat.current.chat!.details.chat!, resourceRevision: 1 } },
      },
    };
    chat.publish();
    identities.push(workspace.completionIdentity("chat"));
    chat.current = {
      ...chat.current,
      chat: {
        ...chat.current.chat!,
        details: {
          chat: {
            ...chat.current.chat!.details.chat!,
            conversationId: "chat-next",
            resourceRevision: 0,
          },
        },
      },
    };
    chat.publish();
    identities.push(workspace.completionIdentity("chat"));
    chat.online = false;
    chat.publish();
    chat.online = true;
    chat.publish();
    identities.push(workspace.completionIdentity("chat"));
    chat.current = { ...chat.current, instance: "daemon-next" };
    chat.publish();
    identities.push(workspace.completionIdentity("chat"));

    // Identical resource revisions after reconnect must still reject cached command/skill catalogs.
    expect(new Set(identities).size).toBe(5);
    expect(workspace.recoveryVersion).toBe(1);
  }));
