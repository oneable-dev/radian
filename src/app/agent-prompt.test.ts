import { expect, test } from "bun:test";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
import type { WorkspaceSnapshot } from "../runtime/workspace-client.ts";
import { ok, type Result } from "../result.ts";
import type { ExpectedError } from "../errors.ts";
import { expectOk } from "../testing/results.ts";
import { WorkspaceSelection } from "./workspace-selection.ts";
import { submitAgentPrompt } from "./agent-prompt.ts";

function fixture() {
  const snapshot: WorkspaceSnapshot = {
    repositories: [],
    chat: {
      id: CHAT_SCOPE_ID,
      path: "/home/test",
      name: "CHAT",
      sessions: [{ id: "original", name: "Question", status: null, subagents: [] }],
      details: {},
      accountsRevision: 0,
      historyRevision: 0,
      closingCount: 0,
    },
    details: {
      original: { conversationId: "conversation-one", status: null, output: "", error: null },
    },
    preferences: { selection: { worktreeId: null, sessions: {} }, drafts: {} },
    closingCount: 0,
    notice: "",
  };
  const selected: string[] = [];
  const requests: string[] = [];
  let current = true;
  const next = Promise.withResolvers<Result<string, ExpectedError>>();
  const client = {
    snapshot,
    prompt: async (_id: string, text: string) => {
      requests.push(text);
      return ok(undefined);
    },
    newTab: async () => next.promise,
  };
  return {
    client,
    selected,
    requests,
    next,
    selection: new WorkspaceSelection([]),
    chat: { isCurrent: () => current, select: (id: string) => selected.push(id) },
    leave: () => {
      current = false;
    },
  };
}

test("CHAT new conversation selects the result without requiring a worktree", async () => {
  // A workspace-free input can create another conversation through the existing /new command.
  const app = fixture();
  const pending = submitAgentPrompt(app.client, app.selection, "original", "/new", [], app.chat);

  app.next.resolve(ok("next-chat"));
  expectOk(await pending);

  expect(app.selected).toEqual(["next-chat"]);
  expect(app.requests).toEqual([]);
  expect(app.selection.worktree).toBeNull();
});

test("Late CHAT creation does not steal selection after leaving its conversation", async () => {
  // Accepted creation continues even after the user moves elsewhere.
  const app = fixture();
  const pending = submitAgentPrompt(app.client, app.selection, "original", "/new", [], app.chat);

  app.leave();
  app.next.resolve(ok("background-chat"));
  expectOk(await pending);

  expect(app.selected).toEqual([]);
});

test("Literal CHAT file-like mentions reach the normal prompt unchanged", async () => {
  // The host must not turn @ text into file selection or a new conversation.
  const app = fixture();
  const text = "Explain @Downloads/report.pdf and user@example.com";

  expectOk(await submitAgentPrompt(app.client, app.selection, "original", text, [], app.chat));

  expect(app.requests).toEqual([text]);
  expect(app.selected).toEqual([]);
});
