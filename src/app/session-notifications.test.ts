import { expect, test } from "bun:test";
import type { SessionResult } from "../agents/session-attention.ts";
import type { SessionNotification } from "../agents/session-notification.ts";
import type { ExecutionState } from "../agents/session-registry.ts";
import type { WorkspaceSnapshot } from "../runtime/workspace-client.ts";
import { SessionNotifications } from "./session-notifications.ts";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";

class Source {
  recoveryVersion = 0;
  readonly listeners = new Set<() => void>();
  snapshot: WorkspaceSnapshot = {
    repositories: ["one", "two"].map((id) => ({
      id,
      name: id,
      worktrees: [
        {
          id: `${id}-tree`,
          name: "main",
          branch: "main",
          path: `/${id}`,
          sessions: [{ id, name: id, status: "working", subagents: [] }],
        },
      ],
    })),
    details: { one: working(), two: working() },
    preferences: { selection: { worktreeId: "one-tree", sessions: {} }, drafts: {} },
    closingCount: 0,
    notice: "",
  };

  subscribe(listener: () => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  changed() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  publish(id: string, state: ExecutionState) {
    this.snapshot = {
      ...this.snapshot,
      details: { ...this.snapshot.details, [id]: state },
      repositories: this.snapshot.repositories.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((tree) => ({
          ...tree,
          sessions: tree.sessions.map((session) => {
            if (session.id !== id) {
              return session;
            }

            const { result: _result, attention: _attention, ...rest } = session;

            return {
              ...rest,
              status: state.status,
              ...(state.result ? { result: state.result } : {}),
              ...(state.attention ? { attention: state.attention } : {}),
            };
          }),
        })),
      })),
    };
    this.changed();
  }
}

function working(): ExecutionState {
  return {
    conversationId: "conversation",
    status: "working",
    output: "Private response",
    error: null,
  };
}

function result(
  id: string,
  outcome: SessionResult["outcome"] = "complete",
  cancellation?: SessionResult["cancellation"],
): SessionResult {
  return {
    id,
    outcome,
    completedAt: 43000,
    request: { text: `Task ${id}`, images: 0, files: 0 },
    ...(cancellation ? { cancellation } : {}),
  };
}

function settled(value: SessionResult): ExecutionState {
  return {
    ...working(),
    status:
      value.outcome === "complete" ? "complete" : value.outcome === "error" ? "failure" : null,
    result: value,
    attention: value,
    sections: [
      {
        id: value.id,
        kind: "assistant",
        title: "Agent",
        text: "Private answer",
        status: "complete",
        completion: {
          startedAt: 1000,
          completedAt: 43000,
          durationMs: 42000,
          outcome: value.outcome,
        },
      },
    ],
  };
}

function fixture(source = new Source()) {
  const sent: SessionNotification[] = [];
  const notifications = new SessionNotifications(source, (notification) => sent.push(notification));

  return { source, sent, notifications };
}

test("CHAT results notify once without a synthetic repository or worktree", () => {
  // A workspace-free conversation exists before the terminal attaches.
  const source = new Source();
  source.snapshot = {
    ...source.snapshot,
    repositories: [],
    chat: {
      id: CHAT_SCOPE_ID,
      path: "/home/test",
      name: "CHAT",
      sessions: [{ id: "chat", name: "Question", status: "working", subagents: [] }],
      details: { chat: working() },
      historyRevision: 0,
      accountsRevision: 0,
      closingCount: 0,
    },
    details: { chat: working() },
  };
  const app = fixture(source);
  try {
    const finished = settled(result("chat-result"));
    source.snapshot = {
      ...source.snapshot,
      details: { chat: finished },
      chat: {
        ...source.snapshot.chat!,
        details: { chat: finished },
        sessions: [
          {
            id: "chat",
            name: "Question",
            status: "complete",
            subagents: [],
            result: finished.result!,
            attention: finished.attention!,
          },
        ],
      },
    };
    source.changed();
    source.changed();

    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]).toMatchObject({
      sessionId: "chat",
      worktreeId: CHAT_SCOPE_ID,
      durationMs: 42000,
    });
    expect(source.snapshot.repositories).toEqual([]);
    expect(JSON.stringify(app.sent)).not.toContain("Private answer");
  } finally {
    app.notifications.dispose();
  }
});

test.each(["complete", "error", "unfinished", "cancelled"] as const)(
  "New %s results from other repositories deliver once regardless of acknowledgement",
  (outcome) => {
    // The selected repository is unrelated to delivery; the other session already exists at attachment.
    const app = fixture();
    const finished = settled(result("new", outcome));
    try {
      app.source.publish("two", finished);

      const { attention: _attention, ...read } = finished;
      app.source.publish("two", read);
      app.source.changed();

      // Removing the bell does not retract or replay a delivery, nor expose response/error text.
      expect(app.sent).toHaveLength(1);
      expect(app.sent[0]).toMatchObject({
        sessionId: "two",
        worktreeId: "two-tree",
        repository: "two",
        worktree: "main",
        branch: "main",
        durationMs: 42000,
        result: { id: "new", outcome, request: { text: "Task new" } },
      });
      expect(JSON.stringify(app.sent)).not.toContain("Private");
      expect(app.source.snapshot.details.two?.result?.id).toBe("new");
    } finally {
      app.notifications.dispose();
    }
  },
);

test.each(["feature/auth", null])(
  "New notifications include names and branches for worktrees with branch %s",
  (branch) => {
    // A worktree name need not match its repository or branch, and detached HEAD has no branch.
    const source = new Source();
    source.snapshot = {
      ...source.snapshot,
      repositories: source.snapshot.repositories.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((tree) => ({ ...tree, name: "auth-checkout", branch })),
      })),
    };

    const app = fixture(source);
    try {
      // The newly completed result captures the checkout metadata from its own workspace.
      source.publish("two", settled(result("new")));

      // Delivery preserves the actual branch, including the absence of one.
      expect(app.sent).toHaveLength(1);
      expect(app.sent[0]).toMatchObject({
        worktreeId: "two-tree",
        worktree: "auth-checkout",
        branch,
      });
    } finally {
      app.notifications.dispose();
    }
  },
);

test.each(["user", "lifecycle"] as const)(
  "%s cancellation preserves existing bells without creating popups",
  (cancellation) => {
    // A previous unread result can survive deliberate cancellation of a later run.
    const source = new Source();
    const old = result("old");

    source.publish("two", settled(old));

    const app = fixture(source);
    try {
      source.publish("two", {
        ...settled(result("cancel", "cancelled", cancellation)),
        attention: old,
      });
      source.changed();

      expect(app.sent).toEqual([]);
      expect(source.snapshot.details.two?.attention?.id).toBe("old");
    } finally {
      app.notifications.dispose();
    }
  },
);

test("New runs remain distinct when starting and completing with an existing bell", () => {
  // Boolean unread transitions would miss the second completion or replay the first on restart.
  const app = fixture();
  const first = result("first");
  const second = result("second");
  try {
    app.source.publish("two", settled(first));
    app.source.publish("two", { ...working(), attention: first });
    app.source.publish("two", settled(second));
    app.source.changed();

    expect(app.sent.map((item) => item.result.id)).toEqual(["first", "second"]);
  } finally {
    app.notifications.dispose();
  }
});

test("Snapshots already running the next request still deliver preserved unread results", () => {
  // Full snapshots can coalesce completion with the next agent_start, which clears result.
  const app = fixture();
  try {
    app.source.publish("two", { ...working(), attention: result("retained") });
    app.source.changed();

    expect(app.sent.map((item) => item.result.id)).toEqual(["retained"]);
    expect(app.sent[0]?.durationMs).toBeUndefined();
  } finally {
    app.notifications.dispose();
  }
});

test("Initial history, conversation replacement, and reconnection never replay old popups", () => {
  // A restored bell is persistent unread state, not a fresh transient delivery.
  const source = new Source();
  source.publish("two", settled(result("history")));

  const app = fixture(source);
  try {
    source.changed();
    source.publish("two", { ...settled(result("replacement")), conversationId: "replacement" });
    source.recoveryVersion++;
    source.publish("two", {
      ...settled(result("recovered", "unfinished")),
      conversationId: "replacement",
    });
    expect(app.sent).toEqual([]);

    source.publish("two", { ...settled(result("after")), conversationId: "replacement" });

    expect(app.sent.map((item) => item.result.id)).toEqual(["after"]);
  } finally {
    app.notifications.dispose();
  }
});

test("Individual messages, tools, child state, and persistence warnings never create popups", () => {
  // Only identified main-session results count, not transient failure/status changes.
  const app = fixture();
  try {
    app.source.publish("two", { ...working(), status: "failure", error: "Retrying" });
    app.source.snapshot = {
      ...app.source.snapshot,
      repositories: app.source.snapshot.repositories.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((tree) => ({
          ...tree,
          sessions: tree.sessions.map((session) => ({
            ...session,
            subagents: [{ id: "child", name: "child", status: "complete" as const }],
          })),
        })),
      })),
    };
    app.source.changed();
    expect(app.sent).toEqual([]);

    const finished = settled(result("settled"));
    app.source.publish("two", finished);
    app.source.publish("two", {
      ...finished,
      sections: finished.sections!.map((section) => ({
        ...section,
        completion: { ...section.completion!, warning: "Persistence warning" },
      })),
    });

    expect(app.sent).toHaveLength(1);
  } finally {
    app.notifications.dispose();
  }
});

test("Synchronous callback snapshots and disposal never replay the same result", () => {
  // Commit observation before invoking UI callbacks that can publish acknowledgements.
  const source = new Source();
  const sent: SessionNotification[] = [];
  const notifications = new SessionNotifications(source, (notification) => {
    sent.push(notification);
    source.changed();
  });

  source.publish("two", settled(result("first")));
  notifications.dispose();
  notifications.dispose();
  source.publish("two", settled(result("second")));

  expect(sent.map((item) => item.result.id)).toEqual(["first"]);
  expect(source.listeners.size).toBe(0);
});
