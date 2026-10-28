import { expect, test } from "bun:test";
import { SessionRegistry, type ExecutionState, type SessionExecutor } from "./session-registry.ts";
import type { SessionResult } from "./session-attention.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { ok } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";

class Executor implements SessionExecutor {
  readonly savedSessionId = crypto.randomUUID();
  readonly sessionFile = undefined;
  private value: ExecutionState = { status: null, output: "", error: null };
  private readonly listeners = new Set<() => void>();

  get state(): ExecutionState {
    return { ...this.value, conversationId: this.savedSessionId };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(state: ExecutionState) {
    this.value = state;
    for (const listener of this.listeners) {
      listener();
    }
  }

  async prompt() {
    return ok(undefined);
  }

  async close() {
    return ok(undefined);
  }
}

const result = (
  id: string,
  outcome: SessionResult["outcome"] = "complete",
  cancellation?: SessionResult["cancellation"],
): SessionResult => ({
  id,
  outcome,
  completedAt: 1000,
  ...(cancellation ? { cancellation } : {}),
  request: { text: `Task ${id}`, images: 0, files: 0 },
});

function fixture(initial?: SessionResult) {
  const executors: Executor[] = [];
  const registry = new SessionRegistry(demoWorkspace(), async () => {
    const executor = new Executor();
    executors.push(executor);
    if (initial) {
      executor.publish({ status: "complete", output: "", error: null, result: initial });
    }

    return executor;
  });

  return { registry, executors };
}

test.each(["complete", "error", "unfinished", "cancelled"] as const)(
  "Only new %s results need attention and repeated updates never undo acknowledgement",
  async (outcome) => {
    // Prepare an outcome without a cause because cancellations with unknown intent need attention.
    const app = fixture();
    const id = expectOk(await app.registry.create("demo:main"));
    const executor = app.executors[0]!;
    try {
      executor.publish({
        status: outcome === "error" ? "failure" : outcome === "complete" ? "complete" : null,
        output: "",
        error: null,
        result: result("first", outcome),
      });
      expect(app.registry.details(id)?.attention?.id).toBe("first");

      // Acknowledgement clears only notifications, not run outcomes.
      expectOk(app.registry.acknowledge(id, executor.savedSessionId, "first"));
      executor.publish(executor.state);
      expect(app.registry.details(id)?.attention).toBeUndefined();
      expect(app.registry.details(id)?.result?.outcome).toBe(outcome);
      expect(app.registry.snapshot[0]?.worktrees[0]?.sessions[0]?.attention).toBeUndefined();
    } finally {
      expectOk(await app.registry.shutdown());
    }
  },
);

test("Late acknowledgements and new runs preserve newer results and earlier unread state", async () => {
  // Interleave completion of two runs with acknowledgement requests.
  const app = fixture();
  const id = expectOk(await app.registry.create("demo:main"));
  const executor = app.executors[0]!;
  try {
    executor.publish({ status: "complete", output: "", error: null, result: result("first") });
    executor.publish({ status: "working", output: "", error: null });
    expect(app.registry.details(id)?.attention?.id).toBe("first");
    executor.publish({ status: "complete", output: "", error: null, result: result("second") });

    // A late acknowledgement of the first run must preserve the second result.
    expectOk(app.registry.acknowledge(id, executor.savedSessionId, "first"));
    expect(app.registry.details(id)?.attention?.id).toBe("second");
    expect(expectError(app.registry.acknowledge(id, "outgoing-conversation", "second")).code).toBe(
      "SESSION_CONFLICT",
    );
    expect(app.registry.details(id)?.attention?.id).toBe("second");
  } finally {
    expectOk(await app.registry.shutdown());
  }
});

test.each(["user", "lifecycle"] as const)(
  "%s cancellation creates no new notification and preserves earlier unread results",
  async (cancellation) => {
    // Intentionally cancel a later run in a session with an unread result.
    const app = fixture();
    const id = expectOk(await app.registry.create("demo:main"));
    const executor = app.executors[0]!;
    try {
      executor.publish({ status: "complete", output: "", error: null, result: result("previous") });
      executor.publish({
        status: null,
        output: "",
        error: null,
        result: result("cancelled", "cancelled", cancellation),
      });

      expect(app.registry.details(id)?.attention?.id).toBe("previous");
      expectOk(app.registry.acknowledge(id, executor.savedSessionId, "previous"));
      executor.publish({
        status: null,
        output: "",
        error: null,
        result: result("cancelled-again", "cancelled", cancellation),
      });
      expect(app.registry.details(id)?.attention).toBeUndefined();
    } finally {
      expectOk(await app.registry.shutdown());
    }
  },
);

test("Opening historical conversations restores saved unread state without replaying notifications", async () => {
  // SDK history and runtime acknowledgement checkpoints have separate responsibilities.
  const app = fixture(result("history"));
  const id = expectOk(await app.registry.create("demo:main"));
  let restored: ReturnType<typeof fixture> | undefined;
  try {
    expect(app.registry.details(id)?.attention).toBeUndefined();
    app.executors[0]!.publish({
      status: "complete",
      output: "",
      error: null,
      result: result("unread"),
    });

    const record = app.registry.records[0]!;
    restored = fixture(result("reloaded-sdk-history"));

    expectOk(await restored.registry.restore(record));
    expect(restored.registry.details(id)?.attention?.id).toBe("unread");
    expectOk(restored.registry.acknowledge(id, restored.executors[0]!.savedSessionId, "unread"));
    restored.executors[0]!.publish(restored.executors[0]!.state);
    expect(restored.registry.details(id)?.attention).toBeUndefined();
  } finally {
    expectOk(await app.registry.shutdown());
    if (restored) {
      expectOk(await restored.registry.shutdown());
    }
  }
});

test("Runtime termination during execution restores Stopped as needing attention", async () => {
  // Runtime termination differs from user-initiated cancellation.
  const app = fixture();
  const id = expectOk(await app.registry.create("demo:main"));
  const restored = fixture();
  try {
    app.executors[0]!.publish({ status: "working", output: "", error: null });
    expectOk(await restored.registry.restore(app.registry.records[0]!));

    expect(restored.registry.details(id)?.status).toBeNull();
    expect(restored.registry.details(id)?.result?.outcome).toBe("unfinished");
    expect(restored.registry.details(id)?.attention?.outcome).toBe("unfinished");
  } finally {
    expectOk(await app.registry.shutdown());
    expectOk(await restored.registry.shutdown());
  }
});
