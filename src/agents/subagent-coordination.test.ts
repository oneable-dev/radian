import { expect, spyOn, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, getSystemMessageText } from "@earendil-works/pi-ai";
import { SessionRegistry, type SessionContext, type SessionExecutor } from "./session-registry.ts";
import { piSessionFactory, type PiSessionOptions } from "./pi-session-adapter.ts";
import { offlineRuntime, fixtureMessage } from "../testing/offline-runtime.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { ok } from "../result.ts";

type Run = {
  id: string;
  status: string;
  output: string;
  progress: { message: string }[];
  questions: { id: string; message: string }[];
};
type Stream = NonNullable<PiSessionOptions["streamFn"]>;
const text = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");

async function fixture(script?: (base: Stream) => Stream) {
  const files = await createWorktreeFixture();
  const agentDir = join(files.directory, "agent");
  const options = await offlineRuntime(agentDir);
  const contexts: SessionContext[] = [];
  const executors: SessionExecutor[] = [];
  const factory = piSessionFactory({
    ...options,
    defaultPackagePaths: [],
    streamFn: (model, context, request) =>
      request?.signal?.aborted
        ? options.streamFn!(model, context, request)
        : (script?.(options.streamFn!) ?? options.streamFn!)(model, context, request),
  });
  const registry = new SessionRegistry([files.repository], async (context) => {
    contexts.push(context);
    const executor = await factory(context);
    executors.push(executor);
    return executor;
  });
  const profile = (extra = "tools: [read, grep, find, ls]\n") =>
    writeFile(
      join(agentDir, "agents", "worker.md"),
      `---\nname: worker\ndescription: Coordination fixture\n${extra}---\nStay within the assigned scope.\n`,
    );
  await profile();
  const parent = expectOk(await registry.create(files.repository.worktrees[0]!.id));
  return {
    ...files,
    options,
    agentDir,
    parent,
    contexts,
    executors,
    registry,
    profile,
    coordinate: contexts[0]!.coordinateSubagents!,
    async cleanup() {
      await registry.shutdown();
      await files.cleanup();
    },
  };
}

function response(
  model: Parameters<Stream>[0],
  content: { tool?: string; args?: unknown; text?: string },
) {
  const stream = createAssistantMessageEventStream();
  const message = fixtureMessage(model.api, model.provider, model.id);
  message.content = content.tool
    ? [
        {
          type: "toolCall",
          id: crypto.randomUUID(),
          name: content.tool,
          arguments: content.args as Extract<
            ReturnType<typeof fixtureMessage>["content"][number],
            { type: "toolCall" }
          >["arguments"],
        },
      ]
    : [{ type: "text", text: content.text ?? "Child finished." }];
  message.stopReason = content.tool ? "toolUse" : "stop";
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
  return stream;
}

async function observe(registry: SessionRegistry, predicate: () => boolean): Promise<void> {
  if (predicate()) return;
  const done = Promise.withResolvers<void>();
  const unsubscribe = registry.subscribe(() => {
    if (predicate()) done.resolve();
  });
  const timeout = setTimeout(
    () => done.reject(new Error("Expected SDK state did not arrive.")),
    5000,
  );
  try {
    await done.promise;
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
}

test("A busy parent consumes status and answers questions without replaying stale follow-up turns", async () => {
  // Reproduce the live smoke test: reports are handled while the original parent run is active.
  const holding = Promise.withResolvers<void>();
  const asked = Promise.withResolvers<void>();
  let finishParent: (() => void) | undefined;
  let parentRequests = 0;
  const app = await fixture((base) => (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    const input = user?.role === "user" ? text(user.content) : "";
    if (input === "hold-parent") {
      parentRequests++;
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      stream.push({ type: "start", partial: message });
      const finish = () => {
        message.content = [{ type: "text", text: "Parent finished its real user request." }];
        message.stopReason = options?.signal?.aborted ? "aborted" : "stop";
        stream.push(
          message.stopReason === "aborted"
            ? { type: "error", reason: "aborted", error: message }
            : { type: "done", reason: "stop", message },
        );
        stream.end();
      };
      finishParent = finish;
      options?.signal?.addEventListener("abort", finish, { once: true });
      holding.resolve();
      return stream;
    }
    if (input.startsWith("child-cycle")) {
      const calls = context.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.content)
        .filter((part) => part.type === "toolCall");
      if (!calls.length)
        return response(model, {
          tool: "radian-supervisor",
          args: { action: "progress", message: "A meaningful finding" },
        });
      if (calls.length === 1) return response(model, { tool: "read", args: { path: "trace.txt" } });
      if (calls.length === 2)
        return response(model, {
          tool: "radian-supervisor",
          args: { action: "ask", message: "Keep the API unchanged?" },
        });
      return response(model, { text: "FINAL_CHILD_ANSWER" });
    }
    parentRequests++;
    return base(model, context, options);
  });
  const notify = app.executors[0]!.notifySubagent!.bind(app.executors[0]);
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation((event, current) => {
    notify(event, current);
    if (event.type === "question") asked.resolve();
  });
  try {
    await writeFile(join(app.main, "trace.txt"), "SOURCE_ONLY_MARKER\n".repeat(20));
    const parentRun = app.registry.prompt(app.parent, "hold-parent");
    await holding.promise;
    const run = expectOk(
      await app.coordinate({
        action: "spawn",
        agent: "worker",
        task: "child-cycle PRIVATE_TASK_MARKER",
      }),
    ) as Run;
    await asked.promise;

    // Observe the pending report, answer it, and observe completion before the parent settles.
    const waiting = expectOk(await app.coordinate({ action: "status", id: run.id })) as Run[];
    expectOk(
      await app.coordinate({
        action: "reply",
        id: run.id,
        questionId: waiting[0]!.questions[0]!.id,
        message: "Keep it unchanged.",
      }),
    );
    const finished = expectOk(await app.coordinate({ action: "wait", id: run.id })) as Run[];
    finishParent!();
    expectOk(await parentRun);
    const saved = await readFile(app.executors[0]!.sessionFile!, "utf8");

    // No old question/progress/completion may wake the parent after its final answer.
    expect(parentRequests).toBe(1);
    expect(finished[0]!.output).toBe("FINAL_CHILD_ANSWER");
    expect(finished[0]!.output).not.toContain("SOURCE_ONLY_MARKER");
    expect(finished[0]!.output).not.toContain("PRIVATE_TASK_MARKER");
    expect((finished[0] as Run & { recentOutput: string }).recentOutput).toContain(
      "SOURCE_ONLY_MARKER",
    );
    expect(saved).not.toContain('"customType":"radian.subagent-event"');
    expect(app.registry.details(app.parent)?.finalOutput).toBe(
      "Parent finished its real user request.",
    );
  } finally {
    finishParent?.();
    await app.cleanup();
  }
});

test("An unseen completion wakes an idle parent once with only the final response and no visible control JSON", async () => {
  // Unlike the handled-report case, a genuinely new completion must still reach its parent.
  const received: string[] = [];
  const app = await fixture((base) => (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    const input = user?.role === "user" ? text(user.content) : "";
    if (input === "delegate-brief")
      return context.messages.at(-1)?.role === "user"
        ? response(model, {
            tool: "radian-subagent",
            args: { action: "spawn", agent: "worker", task: "child-with-logs" },
          })
        : response(model, { text: "Delegated the test." });
    if (input === "child-with-logs")
      return context.messages.at(-1)?.role === "user"
        ? response(model, { tool: "read", args: { path: "trace.txt" } })
        : response(model, { text: "ONLY_FINAL_RESPONSE" });
    if (input.startsWith("Internal subagent update")) {
      received.push(input);
      return response(model, { text: "Parent saw the final answer." });
    }
    return base(model, context, options);
  });
  try {
    await writeFile(join(app.main, "trace.txt"), "DO_NOT_LEAK_SOURCE\n".repeat(20));

    // Use the actual model-facing launch tool and the real notification path, not a mocked wake.
    expectOk(await app.registry.prompt(app.parent, "delegate-brief"));
    await observe(
      app.registry,
      () => app.registry.details(app.parent)?.finalOutput === "Parent saw the final answer.",
    );
    const state = app.registry.details(app.parent)!;
    const file = await readFile(app.executors[0]!.sessionFile!, "utf8");

    expect(received).toHaveLength(1);
    expect(received[0]).toContain("ONLY_FINAL_RESPONSE");
    expect(received[0]).not.toContain("DO_NOT_LEAK_SOURCE");
    expect(received[0]).not.toContain('"type":');
    expect(state.sections?.some((section) => section.title === "radian.subagent-event")).toBe(
      false,
    );
    expect(file).toContain('"display":false');
    expect(file).toContain('"kind":"radian.subagent-notifications"');
  } finally {
    await app.cleanup();
  }
});

test("An unseen question wakes an idle parent and is answered without a second stale completion wake", async () => {
  // Idle delivery must preserve real decisions, not suppress every child event as a workaround.
  let deliveries = 0;
  const app = await fixture((base) => (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    const input = user?.role === "user" ? text(user.content) : "";
    const last = context.messages.at(-1);
    if (input === "delegate-question")
      return last?.role === "user"
        ? response(model, {
            tool: "radian-subagent",
            args: { action: "spawn", agent: "worker", task: "child-needs-decision" },
          })
        : response(model, { text: "Delegated the decision test." });
    if (input === "child-needs-decision")
      return last?.role === "user"
        ? response(model, {
            tool: "radian-supervisor",
            args: { action: "ask", message: "May I finish the test?" },
          })
        : response(model, { text: "CHILD_AFTER_REPLY" });
    if (input.startsWith("Internal subagent update")) {
      const id = /\nRun: ([^\n]+)/u.exec(input)?.[1];
      if (last?.role === "user") {
        deliveries++;
        const questionId = /Question ([^:]+):/u.exec(input)?.[1];
        if (!id || !questionId)
          throw new Error("The parent did not receive a correlated question.");
        return response(model, {
          tool: "radian-subagent",
          args: {
            action: "reply",
            id,
            questionId,
            message: "Finish within the approved read-only test.",
          },
        });
      }
      if (
        last?.role === "toolResult" &&
        context.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.content)
          .filter((part) => part.type === "toolCall")
          .filter((part) => part.name === "radian-subagent")
          .at(-1)?.arguments.action === "reply"
      )
        return response(model, { tool: "radian-subagent", args: { action: "wait", id } });
      return response(model, { text: "Parent handled the child decision." });
    }
    return base(model, context, options);
  });
  try {
    expectOk(await app.registry.prompt(app.parent, "delegate-question"));
    await observe(
      app.registry,
      () => app.registry.details(app.parent)?.finalOutput === "Parent handled the child decision.",
    );
    const saved = await readFile(app.executors[0]!.sessionFile!, "utf8");
    const records = app.registry
      .details(app.parent)!
      .sections!.filter((section) => section.toolCallId && section.title === "radian-subagent");

    expect(deliveries).toBe(1);
    expect(saved.match(/"kind":"radian.subagent-notifications"/gu)).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]!.text).toContain("May I finish the test?");
    expect(records[0]!.text).toContain("Finish within the approved read-only test.");
    expect(records[0]!.text).toContain("CHILD_AFTER_REPLY");
    expect(records[0]!.summary).toContain("Complete");
  } finally {
    await app.cleanup();
  }
});

test.each(["failure", "cancel"])(
  "A %s never reuses an earlier successful final response",
  async (outcome) => {
    // A conversation can retain old prose in its debug tail without exposing it as a new result.
    const app = await fixture();
    try {
      expectOk(await app.registry.prompt(app.parent, "First successful request"));
      expect(app.registry.details(app.parent)?.finalOutput).toContain("Offline SDK fixture");

      if (outcome === "failure")
        expect(expectError(await app.registry.prompt(app.parent, "fail")).code).toBe(
          "AGENT_FAILED",
        );
      else {
        const accepted = Promise.withResolvers<void>();
        const running = app.registry.prompt(app.parent, "slow", () => accepted.resolve());
        await accepted.promise;
        expectOk(await app.registry.interrupt(app.parent));
        expect(expectError(await running).code).toBe("CANCELLED");
      }

      expect(app.registry.details(app.parent)?.finalOutput).toBeUndefined();
    } finally {
      await app.cleanup();
    }
  },
);

test("A rejected launch is reported by its tool result without an additional completion wake", async () => {
  // Factory errors are not accepted background jobs and must not be reported twice.
  let requests = 0;
  const app = await fixture((base) => (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    const input = user?.role === "user" ? text(user.content) : "";
    requests++;
    if (input === "delegate-invalid")
      return context.messages.at(-1)?.role === "user"
        ? response(model, {
            tool: "radian-subagent",
            args: { action: "spawn", agent: "worker", task: "Should be rejected" },
          })
        : response(model, { text: "The required role dependency is unavailable." });
    return base(model, context, options);
  });
  try {
    await app.profile("tools: [read]\nskills: [missing-required-skill]\n");

    expectOk(await app.registry.prompt(app.parent, "delegate-invalid"));
    const file = await readFile(app.executors[0]!.sessionFile!, "utf8");

    expect(requests).toBe(2);
    expect(file).not.toContain('"customType":"radian.subagent-event"');
    expect(app.registry.details(app.parent)?.finalOutput).toBe(
      "The required role dependency is unavailable.",
    );
  } finally {
    await app.cleanup();
  }
});

test("Host protocols remain role-scoped without an installed orchestration skill and preserve normal context", async () => {
  // Empty user skills must not remove the runtime's parent or child API instructions.
  const prompts = new Map<string, string>();
  const toolNames = new Map<string, string[]>();
  const app = await fixture((base) => (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    const input = user?.role === "user" ? text(user.content) : "";
    if (input.startsWith("inspect-")) {
      prompts.set(
        input,
        context.messages
          .filter((message) => message.role === "system")
          .map(getSystemMessageText)
          .join("\n"),
      );
      toolNames.set(
        input,
        context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
        ),
      );
    }
    return base(model, context, options);
  });
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation(() => {});
  try {
    await writeFile(join(app.agentDir, "APPEND_SYSTEM.md"), "PRESERVED_APPEND_GUIDANCE");
    await writeFile(join(app.agentDir, "AGENTS.md"), "PRESERVED_GLOBAL_GUIDANCE");
    await writeFile(join(app.main, "AGENTS.md"), "PRESERVED_PROJECT_GUIDANCE");

    // Discover common context and run both real SDK session roles.
    expectOk(await app.registry.reload(app.parent));
    expectOk(await app.registry.prompt(app.parent, "inspect-parent"));
    const run = expectOk(
      await app.coordinate({ action: "spawn", agent: "worker", task: "inspect-child" }),
    ) as Run;
    expectOk(await app.coordinate({ action: "wait", id: run.id }));
    const parent = prompts.get("inspect-parent")!;
    const child = prompts.get("inspect-child")!;

    // Preserve the base prompt and user instructions while keeping orchestration parent-only.
    for (const prompt of [parent, child]) {
      expect(prompt).toContain("expert coding assistant operating inside pi");
      expect(prompt).toContain("PRESERVED_APPEND_GUIDANCE");
      expect(prompt).toContain("PRESERVED_GLOBAL_GUIDANCE");
      expect(prompt).toContain("PRESERVED_PROJECT_GUIDANCE");
    }
    expect(parent).toContain('<radian_subagents role="parent">');
    expect(parent).not.toContain('<radian_subagents role="child">');
    expect(parent).toContain("radian-subagent");
    expect(child).toContain('<radian_subagents role="child">');
    expect(child).not.toContain('<radian_subagents role="parent">');
    expect(child).not.toContain("Available agent profiles");
    expect(child).toContain("radian-supervisor");
    expect(child).toContain("Stay within the assigned scope.");
    expect(toolNames.get("inspect-parent")).toContain("radian-subagent");
    expect(toolNames.get("inspect-child")).toContain("radian-supervisor");
    expect(toolNames.get("inspect-child")).not.toContain("radian-subagent");
    expect(await Bun.file(join(app.agentDir, "skills", "subagent", "SKILL.md")).exists()).toBe(
      false,
    );
  } finally {
    await app.cleanup();
  }
});

test("Real SDK delegation reports progress, waits for decisions, rejects steer-as-reply and retains final output", async () => {
  // The model calls the actual parent and child tools; only the model transport is scripted.
  const app = await fixture((base) => (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    const input = user?.role === "user" ? text(user.content) : "";
    if (input === "coordinate" && context.messages.at(-1)?.role === "user")
      return response(model, {
        tool: "radian-subagent",
        args: { action: "spawn", agent: "worker", task: "child-task" },
      });
    if (input !== "child-task") return base(model, context, options);
    const calls = context.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .filter((part) => part.type === "toolCall");
    if (!calls.length)
      return response(model, {
        tool: "radian-supervisor",
        args: { action: "progress", message: "Found a shared contract." },
      });
    if (calls.length === 1)
      return response(model, {
        tool: "radian-supervisor",
        args: { action: "ask", message: "May I change the API?" },
      });
    return response(model, { text: "Kept the existing API." });
  });
  const question = Promise.withResolvers<void>();
  const events: unknown[] = [];
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation((event) => {
    events.push(event);
    if (event && typeof event === "object" && "type" in event && event.type === "question")
      question.resolve();
  });
  try {
    expectOk(await app.registry.prompt(app.parent, "coordinate"));
    await question.promise;

    const waiting = expectOk(await app.coordinate({ action: "wait" })) as Run[];
    const run = waiting[0]!;
    const rejected = await app.coordinate({
      action: "steer",
      id: run.id,
      message: "Keep the API.",
    });
    expect(run.status).toBe("waiting");
    expect(run.progress).toEqual([
      expect.objectContaining({ message: "Found a shared contract." }),
    ]);
    expect(expectError(rejected).code).toBe("INVALID_INPUT");
    expectOk(
      await app.coordinate({
        action: "reply",
        id: run.id,
        questionId: run.questions[0]!.id,
        message: "Keep the public API.",
      }),
    );
    const finished = expectOk(await app.coordinate({ action: "wait", id: run.id })) as Run[];

    expect(finished[0]).toMatchObject({ status: "complete", questions: [] });
    expect(finished[0]!.output).toContain("Kept the existing API.");
    expect(
      expectError(
        await app.coordinate({
          action: "reply",
          id: run.id,
          questionId: run.questions[0]!.id,
          message: "Duplicate",
        }),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(events).toContainEqual(expect.objectContaining({ type: "progress" }));
    expect(
      app.registry.checkpointRecords.some(
        (record) =>
          record.name === "worker" && record.state.output.includes("Kept the existing API."),
      ),
    ).toBe(true);
  } finally {
    await app.cleanup();
  }
});

test("SDK role tools deny unlisted writes while required skills are injected and parent-only skills stay hidden", async () => {
  // Role skill selection and tool permissions affect the real SDK model request, not just profile parsing.
  let prompt = "";
  let tools: string[] = [];
  const app = await fixture((base) => (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    if (user?.role !== "user" || text(user.content) !== "write-forbidden")
      return base(model, context, options);
    prompt = JSON.stringify(context.messages.filter((message) => message.role === "system"));
    tools = context.messages.flatMap((message) =>
      message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
    );
    return context.messages.at(-1)?.role === "user"
      ? response(model, {
          tool: "write",
          args: { path: "forbidden.txt", content: "Must not write" },
        })
      : response(model, { text: "Write was unavailable." });
  });
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation(() => {});
  try {
    for (const [name, metadata, body] of [
      ["required-fixture", "", "REQUIRED_ROLE_GUIDANCE"],
      ["orchestrate-fixture", 'metadata:\n  parentOnly: "true"\n', "PARENT_ONLY_GUIDANCE"],
    ]) {
      const path = join(app.agentDir, "skills", name!);
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, "SKILL.md"),
        `---\nname: ${name}\ndescription: Fixture\n${metadata}---\n${body}\n`,
      );
    }
    await app.profile(
      "tools: [read, grep, find, ls]\nskills: [required-fixture]\nmodel: radian-offline/fixture\n",
    );

    const spawned = expectOk(
      await app.coordinate({ action: "spawn", agent: "worker", task: "write-forbidden" }),
    ) as Run;
    const done = expectOk(await app.coordinate({ action: "wait", id: spawned.id })) as Run[];

    expect(done[0]?.status).toBe("complete");
    expect(tools).toContain("radian-supervisor");
    expect(tools).toContain("grep");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("radian-subagent");
    expect(prompt).toContain("REQUIRED_ROLE_GUIDANCE");
    expect(prompt).not.toContain("orchestrate-fixture");
    expect(await Bun.file(join(app.main, "forbidden.txt")).exists()).toBe(false);
  } finally {
    await app.cleanup();
  }
});

test("Closing a parent releases blocked questions and scopes run identities to their owner", async () => {
  // A question tool must never prevent parent shutdown or become reachable from another tab.
  const app = await fixture((base) => (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    if (user?.role !== "user" || text(user.content) !== "ask-forever")
      return base(model, context, options);
    return response(model, {
      tool: "radian-supervisor",
      args: { action: "ask", message: "Waiting for a decision." },
    });
  });
  const asked = Promise.withResolvers<void>();
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation((event) => {
    if (event && typeof event === "object" && "type" in event && event.type === "question")
      asked.resolve();
  });
  try {
    const run = expectOk(
      await app.coordinate({ action: "spawn", agent: "worker", task: "ask-forever" }),
    ) as Run;
    await asked.promise;
    const other = expectOk(await app.registry.create(app.repository.worktrees[0]!.id));
    const otherContext = app.contexts.find(
      (context, index) => index > 0 && context.role === "main",
    )!;

    expect(
      expectError(await otherContext.coordinateSubagents!({ action: "status", id: run.id })).code,
    ).toBe("INVALID_INPUT");
    expectOk(await app.registry.close(app.parent));

    expect(app.registry.details(other)).not.toBeNull();
    expect(
      expectError(
        await app.coordinate({ action: "reply", id: run.id, questionId: "late", message: "Late" }),
      ).code,
    ).toBe("SESSION_NOT_OPEN");
  } finally {
    await app.cleanup();
  }
});

test("Steer reaches an active SDK child without replacing its conversation", async () => {
  // Guidance is queued at an SDK boundary and does not claim immediate compliance.
  const started = Promise.withResolvers<void>();
  let finish: (() => void) | undefined;
  const app = await fixture((base) => (model, context, options) => {
    const last = context.messages.at(-1);
    if (last?.role !== "user" || text(last.content) !== "hold-child")
      return base(model, context, options);
    const stream = createAssistantMessageEventStream();
    const message = fixtureMessage(model.api, model.provider, model.id);
    stream.push({ type: "start", partial: message });
    finish = () => {
      message.content = [{ type: "text", text: "Initial step" }];
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    };
    started.resolve();
    return stream;
  });
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation(() => {});
  try {
    const run = expectOk(
      await app.coordinate({ action: "spawn", agent: "worker", task: "hold-child" }),
    ) as Run;
    await started.promise;
    const child = app.executors[1]!;
    const identity = child.savedSessionId;

    const queued = expectOk(
      await app.coordinate({
        action: "steer",
        id: run.id,
        message: "Limit changes to the API client.",
      }),
    );
    finish!();
    expectOk(await app.coordinate({ action: "wait", id: run.id }));

    expect(queued).toMatchObject({ disposition: "queued", compliance: "not-confirmed" });
    expect(child.savedSessionId).toBe(identity);
    expect(await readFile(child.sessionFile!, "utf8")).toContain(
      "Limit changes to the API client.",
    );
  } finally {
    finish?.();
    await app.cleanup();
  }
});

test("All completed children hide as one group after ten seconds without removing retained records", async () => {
  // A clock boundary proves the deadline without a real ten-second sleep.
  let now = 1000;
  let deadline: (() => void) | undefined;
  let context: SessionContext | undefined;
  const registry = new SessionRegistry(demoWorkspace(), async (received) => {
    if (received.role === "main") context = received;
    return {
      savedSessionId: crypto.randomUUID(),
      sessionFile: undefined,
      state: { status: "complete", output: "Retained result", error: null },
      subscribe: () => () => {},
      prompt: async () => ok(undefined),
      close: async () => ok(undefined),
    };
  });
  const date = spyOn(Date, "now").mockImplementation(() => now);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      (...args: Parameters<typeof globalThis.setTimeout>) => {
        expect(args[1]).toBe(10_000);
        deadline = args[0] as () => void;
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      { __promisify__: globalThis.setTimeout.__promisify__ },
    ),
  );
  try {
    expectOk(await registry.create("demo:main"));
    expectOk(await context!.spawnSubagent("worker", "Task"));
    const children = () => registry.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents;

    now = 10_999;
    expect(children()).toHaveLength(1);
    now = 11_000;
    deadline!();

    expect(children()).toEqual([]);
    expect(registry.records[0]!.subagents).toHaveLength(1);
    expect(
      registry.checkpointRecords.some(
        (record) => record.name === "worker" && record.state.output === "Retained result",
      ),
    ).toBe(true);
    const first = registry.records[0]!.subagents[0]!.id;
    expectOk(await context!.spawnSubagent("worker", "New batch"));
    expect(children()).toHaveLength(1);
    expect(children()[0]!.id).not.toBe(first);
    expect(registry.records[0]!.ownedSubagents![0]!.hidden).toBe(true);
  } finally {
    await registry.shutdown();
    timeout.mockRestore();
    clear.mockRestore();
    date.mockRestore();
  }
});

test("Waiting for one child returns another child's pending question instead of deadlocking", async () => {
  // A blocking wait for A must not prevent the parent from answering B.
  const app = await fixture((base) => (model, context, options) => {
    const last = context.messages.at(-1);
    if (last?.role === "user" && text(last.content) === "ask-other")
      return response(model, {
        tool: "radian-supervisor",
        args: { action: "ask", message: "Other child needs a decision" },
      });
    return base(model, context, options);
  });
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation(() => {});
  try {
    const a = expectOk(
      await app.coordinate({ action: "spawn", agent: "worker", task: "slow" }),
    ) as Run;
    const waiting = app.coordinate({ action: "wait", id: a.id });
    const b = expectOk(
      await app.coordinate({ action: "spawn", agent: "worker", task: "ask-other" }),
    ) as Run;

    const attention = expectOk(await waiting) as Run[];
    const question = attention.find((run) => run.id === b.id)!.questions[0]!;
    expectOk(
      await app.coordinate({
        action: "reply",
        id: b.id,
        questionId: question.id,
        message: "Continue",
      }),
    );
    expectOk(await app.coordinate({ action: "stop", id: a.id }));
    expectOk(await app.coordinate({ action: "wait" }));

    expect(attention.map((run) => run.id)).toEqual([a.id, b.id]);
    expect(question.message).toBe("Other child needs a decision");
  } finally {
    await app.cleanup();
  }
});

test("SDK nested MCP calls cannot escape a role allowlist", async () => {
  // SDK 1.2 normally retains unmatched MCP tools for codemode; native roles must not.
  const app = await fixture((base) => (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    if (user?.role !== "user" || text(user.content) !== "nested-denied")
      return base(model, context, options);
    return context.messages.at(-1)?.role === "user"
      ? response(model, { tool: "proxy", args: {} })
      : base(model, context, options);
  });
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation(() => {});
  const marker = join(app.directory, "forbidden-mcp-call");
  try {
    const extensions = join(app.agentDir, "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "nested.ts"),
      `
      import { writeFileSync } from "node:fs";
      export default function(pi) {
        pi.registerTool({ name: "mcp__fixture__danger", exposure: "codemode", label: "Danger", description: "Unallowed MCP operation", parameters: {type: "object", properties: {}}, execute: async () => { writeFileSync(${JSON.stringify(marker)}, "forbidden"); return {content:[{type:"text",text:"Executed"}]}; } });
        pi.registerTool({ name: "proxy", label: "Proxy", description: "Nested call fixture", parameters: {type: "object", properties: {}}, execute: async (_id, _args, _signal, _update, ctx) => { const result = await ctx.executeTool("mcp__fixture__danger", {}); return {content:[{type:"text",text:JSON.stringify(result)}]}; } });
      }
    `,
    );
    await app.profile("tools: [read, proxy]\n");

    const run = expectOk(
      await app.coordinate({ action: "spawn", agent: "worker", task: "nested-denied" }),
    ) as Run;
    const done = expectOk(await app.coordinate({ action: "wait", id: run.id })) as Run[];

    expect(done[0]!.output).toContain('"isError":true');
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await app.cleanup();
  }
});

test("Role dependencies registered at session_start and resources_discover are validated after discovery", async () => {
  // Extensions may contribute tools and skills only after the SDK binds them.
  let prompt = "";
  const app = await fixture((base) => (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    if (user?.role !== "user" || text(user.content) !== "late-dependencies")
      return base(model, context, options);
    prompt = JSON.stringify(context.messages.filter((message) => message.role === "system"));
    return context.messages.at(-1)?.role === "user"
      ? response(model, { tool: "late-helper", args: {} })
      : base(model, context, options);
  });
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation(() => {});
  try {
    const extensions = join(app.agentDir, "extensions");
    const skill = join(app.directory, "late-skill");
    await mkdir(extensions, { recursive: true });
    await mkdir(skill);
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: late-skill\ndescription: Extension-provided role dependency\n---\nLATE_REQUIRED_GUIDANCE\n",
    );
    await writeFile(
      join(extensions, "late.ts"),
      `export default function(pi) {
      pi.on("session_start", () => pi.registerTool({name:"late-helper",label:"Late",description:"Late registration",parameters:{type:"object",properties:{}},execute:async()=>({content:[{type:"text",text:"Late dependency executed"}]})}));
      pi.on("resources_discover", () => ({skillPaths:[${JSON.stringify(skill)}]}));
    }`,
    );
    await app.profile("tools: [read, late-helper]\nskills: [late-skill]\n");

    const run = expectOk(
      await app.coordinate({ action: "spawn", agent: "worker", task: "late-dependencies" }),
    ) as Run;
    const done = expectOk(await app.coordinate({ action: "wait", id: run.id })) as Run[];

    expect(done[0]!.status).toBe("complete");
    expect(done[0]!.output).toContain("Late dependency executed");
    expect(prompt).toContain("LATE_REQUIRED_GUIDANCE");
  } finally {
    await app.cleanup();
  }
});

test("Role validation failure after extension startup still runs provider shutdown hooks", async () => {
  // Discovering a missing dependency must not leak resources started by extensions.
  const app = await fixture();
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation(() => {});
  const marker = join(app.directory, "provider-lifecycle");
  try {
    const extensions = join(app.agentDir, "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "lifecycle.ts"),
      `import {appendFileSync} from "node:fs"; export default function(pi) {
      pi.on("session_start", () => appendFileSync(${JSON.stringify(marker)}, "started\\n"));
      pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(marker)}, "closed\\n"));
    }`,
    );
    await app.profile("tools: [read, unavailable-dependency]\n");

    const failed = await app.coordinate({
      action: "spawn",
      agent: "worker",
      task: "Do not start the model",
    });

    expect(expectError(failed).code).toBe("INVALID_INPUT");
    expect(await readFile(marker, "utf8")).toBe("started\nclosed\n");
  } finally {
    await app.cleanup();
  }
});

test("Delayed child cleanup cannot notify and restart an interrupted parent", async () => {
  // Parent SDK interruption may finish before the child's cleanup acknowledgement.
  let context: SessionContext | undefined;
  const run = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const notifications: unknown[] = [];
  const registry = new SessionRegistry(demoWorkspace(), async (received) => {
    if (received.role === "main") {
      context = received;
      return {
        savedSessionId: crypto.randomUUID(),
        sessionFile: undefined,
        state: { status: null, output: "", error: null },
        subscribe: () => () => {},
        prompt: async () => ok(undefined),
        interrupt: async () => ok(undefined),
        close: async () => ok(undefined),
        notifySubagent: (event) => notifications.push(event),
      };
    }
    return {
      savedSessionId: crypto.randomUUID(),
      sessionFile: undefined,
      state: { status: "working", output: "Partial child", error: null },
      subscribe: () => () => {},
      prompt: async () => {
        await run.promise;
        return ok(undefined);
      },
      close: async () => {
        run.resolve();
        closing.resolve();
        await release.promise;
        return ok(undefined);
      },
    };
  });
  try {
    const parent = expectOk(await registry.create("demo:main"));
    expectOk(
      await context!.coordinateSubagents!({ action: "spawn", agent: "worker", task: "Cancelable" }),
    );

    const stopped = registry.interrupt(parent);
    await closing.promise;
    release.resolve();
    expectOk(await stopped);
    expectOk(await context!.coordinateSubagents!({ action: "wait" }));

    expect(notifications).toEqual([]);
    expect(registry.details(parent)).not.toBeNull();
  } finally {
    release.resolve();
    run.resolve();
    await registry.shutdown();
  }
});

test.each(["slow", "blocked-question"])(
  "Clearing a conversation releases %s and fences its old coordination handles",
  async (task) => {
    // Replacement must cancel old awaits without granting them access to the new conversation.
    const app = await fixture((base) => (model, context, options) => {
      const last = context.messages.at(-1);
      if (last?.role === "user" && text(last.content) === "blocked-question")
        return response(model, {
          tool: "radian-supervisor",
          args: { action: "ask", message: "Unanswered decision" },
        });
      return base(model, context, options);
    });
    const asked = Promise.withResolvers<void>();
    let finishes = 0;
    spyOn(app.executors[0]!, "notifySubagent").mockImplementation((event) => {
      if (event && typeof event === "object" && "type" in event) {
        if (event.type === "question") asked.resolve();
        if (event.type === "finished") finishes++;
      }
    });
    try {
      const run = expectOk(await app.coordinate({ action: "spawn", agent: "worker", task })) as Run;
      if (task === "blocked-question") await asked.promise;
      const wait = app.coordinate({ action: "wait", id: run.id });

      expectOk(await app.registry.clearSession(app.parent));
      const result = await wait;
      if (task === "slow") expect(expectError(result).code).toBe("CANCELLED");
      else expect(expectOk(result)).toEqual([expect.objectContaining({ status: "waiting" })]);

      expect(expectError(await app.coordinate({ action: "status", id: run.id })).code).toBe(
        "SESSION_CONFLICT",
      );
      expect(app.registry.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents).toEqual([]);
      expect(finishes).toBe(0);
    } finally {
      await app.cleanup();
    }
  },
);

test("Checkpoint restore retains results and archive paths without resurrecting hidden batches", async () => {
  // Hidden UI state and queryable results have independent persistence contracts.
  const app = await fixture();
  spyOn(app.executors[0]!, "notifySubagent").mockImplementation(() => {});
  let restored: SessionRegistry | undefined;
  try {
    const first = expectOk(
      await app.coordinate({ action: "spawn", agent: "worker", task: "First completed task" }),
    ) as Run;
    expectOk(await app.coordinate({ action: "wait", id: first.id }));
    const checkpoint = app.registry.records[0]!;
    const saved = checkpoint.ownedSubagents![0]!;
    const secondId = crypto.randomUUID();
    const record = {
      ...checkpoint,
      ownedSubagents: [
        { ...saved, hidden: true, finishedAt: Date.now() - 20_000 },
        {
          id: secondId,
          name: "worker",
          status: "working" as const,
          output: "Interrupted progress",
          hidden: false,
          progress: [],
          task: "Second task",
        },
      ],
    };
    expectOk(await app.registry.close(app.parent));
    const contexts: SessionContext[] = [];
    const factory = piSessionFactory(app.options);
    restored = new SessionRegistry([app.repository], async (context) => {
      contexts.push(context);
      return factory(context);
    });

    expectOk(await restored.restore(record));
    const statuses = expectOk(
      await contexts[0]!.coordinateSubagents!({ action: "status" }),
    ) as Run[];
    const rows = restored.snapshot[0]!.worktrees[0]!.sessions[0]!.subagents;

    expect(statuses.find((run) => run.id === first.id)).toMatchObject({
      output: saved.finalOutput,
      recentOutput: saved.output,
      sessionFile: saved.sessionFile,
      status: "complete",
    });
    expect(statuses.find((run) => run.id === secondId)).toMatchObject({
      output: "",
      recentOutput: "Interrupted progress",
      status: "stopped",
    });
    expect(rows.map((row) => row.id)).not.toContain(first.id);
    expect(restored.records[0]!.ownedSubagents![0]!.hidden).toBe(true);
    expect(restored.details(record.id)?.attention?.outcome).toBe("unfinished");
  } finally {
    await restored?.shutdown();
    await app.cleanup();
  }
});
