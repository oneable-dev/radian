import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type ToolCall } from "@earendil-works/pi-ai";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { expectOk } from "../testing/results.ts";
import { SessionRegistry, type SessionContext, type SessionExecutor } from "./session-registry.ts";
import { piSessionFactory, type PiSessionOptions } from "./pi-session-adapter.ts";
import { readTaskPlan, planFilePath, saveTaskPlan } from "./task-plan-store.ts";
import type { PlanningProposal } from "./planning-proposal.ts";

type Stream = NonNullable<PiSessionOptions["streamFn"]>;
function draft(): PlanningProposal {
  return {
    plan: {
      schemaVersion: 1,
      goal: "A delegated plan",
      outOfScope: [],
      assumptions: [],
      openQuestions: [],
      tasks: [
        {
          id: "inspect",
          title: "Inspect",
          agent: "main",
          dependsOn: [],
          inputs: [],
          outputs: ["Contract"],
          acceptanceCriteria: ["Reviewed"],
          files: [],
        },
      ],
    },
    review: { summary: "Reviewed scope and dependencies", warnings: [] },
  };
}
function response(
  model: Parameters<Stream>[0],
  tool?: { name: string; arguments: unknown },
  text = "Done.",
) {
  const stream = createAssistantMessageEventStream();
  const message = fixtureMessage(model.api, model.provider, model.id);
  message.content = tool
    ? [
        {
          type: "toolCall",
          id: crypto.randomUUID(),
          name: tool.name,
          arguments: tool.arguments as ToolCall["arguments"],
        },
      ]
    : [{ type: "text", text }];
  message.stopReason = tool ? "toolUse" : "stop";
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
  return stream;
}
const contentText = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === "string"
    ? content
    : content
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("");

async function fixture(chat = false) {
  const files = await createWorktreeFixture();
  const agentDir = join(files.directory, "agent");
  const options = await offlineRuntime(agentDir);
  options.modelRuntime!.registerProvider("planner-fixture", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "fixture",
    models: ["draft-a", "draft-b"].map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text" as const],
      contextWindow: 200000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  let proposal = draft();
  let ask = false;
  let holdQuestion = false;
  let forbidden = false;
  let parentFirst = true;
  let initialAction: Record<string, unknown> = { action: "delegate" };
  let holdAcceptance = false;
  const contexts: SessionContext[] = [];
  const executors: SessionExecutor[] = [];
  const childModels: string[] = [];
  const childTasks: string[] = [];
  const profile = (id = "draft-a") =>
    writeFile(
      join(agentDir, "agents", "planner.md"),
      `---\nname: planner\ndescription: Planning fixture\nmodel: planner-fixture/${id}\nthinking: high\ntools: ['*']\n---\nDraft only.\n`,
    );
  await profile();
  const settings = {
    retry: { enabled: false },
    compaction: { enabled: false },
    commandAgents: { plan: "planner" },
  };
  const factory = piSessionFactory({
    ...options,
    settings,
    defaultPackagePaths: [],
    streamFn(model, context) {
      const last = context.messages.at(-1);
      if (model.provider === "planner-fixture") {
        childModels.push(model.id);
        if (last?.role !== "toolResult") {
          childTasks.push(last?.role === "user" ? contentText(last.content) : JSON.stringify(last));
          if (forbidden)
            return response(model, {
              name: "write",
              arguments: { path: join(files.main, "forbidden.txt"), content: "unexpected" },
            });
          if (ask)
            return response(model, {
              name: "radian-supervisor",
              arguments: { action: "ask", message: "Which acceptance criterion applies?" },
            });
          return response(model, {
            name: "radian-supervisor",
            arguments: { action: "proposal", proposal },
          });
        }
        if (last.toolName !== "radian-supervisor")
          return response(model, {
            name: "radian-supervisor",
            arguments: { action: "proposal", proposal },
          });
        let result: Record<string, unknown> = {};
        try {
          result = JSON.parse(contentText(last.content));
        } catch {}
        if (result.questionId)
          return response(model, {
            name: "radian-supervisor",
            arguments: { action: "proposal", proposal },
          });
        return response(model, undefined, "Planner complete.");
      }
      if (parentFirst) {
        parentFirst = false;
        return response(model, { name: "radian-plan", arguments: initialAction });
      }
      const parentResult = context.messages.findLast((message) => message.role === "toolResult");
      if (parentResult?.role !== "toolResult" || parentResult.isError)
        return response(model, undefined, "Planning failed; previous plan retained.");
      let status: { status?: string; questions?: { id: string }[] };
      try {
        status = JSON.parse(contentText(parentResult.content));
      } catch {
        return response(model, undefined, "Plan saved.");
      }
      if (status.status === "complete")
        return holdAcceptance
          ? response(model, undefined, "Inspect the proposal before accepting it.")
          : response(model, { name: "radian-plan", arguments: { action: "accept" } });
      if (status.status === "waiting" && status.questions?.length) {
        if (holdQuestion) return response(model, undefined, "Please answer the planner question.");
        return response(model, {
          name: "radian-plan",
          arguments: {
            action: "reply",
            questionId: status.questions[0]!.id,
            message: "Use the documented acceptance criterion.",
          },
        });
      }
      return response(model, { name: "radian-plan", arguments: { action: "wait" } });
    },
  });
  const registry = new SessionRegistry(
    [files.repository],
    async (context) => {
      contexts.push(context);
      const executor = await factory(context);
      executors.push(executor);
      return executor;
    },
    chat ? "chat" : "code",
  );
  const parent = expectOk(await (chat ? registry.createChat() : registry.create(files.main)));
  const stored = () =>
    readTaskPlan(executors[0]!.sessionFile!, {
      cwd: contexts[0]!.cwd,
      conversationId: executors[0]!.savedSessionId,
    });
  const run = async (
    input: string,
    action: Record<string, unknown> = {
      action: input === "Cancel planner" ? "cancel" : "delegate",
    },
  ) => {
    parentFirst = true;
    initialAction = action;
    const result = await registry.prompt(parent, input);
    if (!result.ok) throw result.error;
    if (executors[0]!.state.status === "working") {
      const done = Promise.withResolvers<void>();
      const unsubscribe = executors[0]!.subscribe(() => {
        if (executors[0]!.state.status !== "working") done.resolve();
      });
      const timer = setTimeout(
        () => done.reject(new Error("Planning fixture did not settle.")),
        5000,
      );
      try {
        await done.promise;
      } finally {
        clearTimeout(timer);
        unsubscribe();
      }
    }
    return result;
  };
  return {
    ...files,
    options,
    registry,
    parent,
    contexts,
    executors,
    childModels,
    childTasks,
    profile,
    stored,
    run,
    setProposal(value: PlanningProposal) {
      proposal = value;
    },
    ask(hold = false) {
      ask = true;
      holdQuestion = hold;
      forbidden = false;
    },
    forbidWrite() {
      forbidden = true;
    },
    pauseAcceptance() {
      holdAcceptance = true;
    },
    async close() {
      expectOk(await registry.shutdown());
      await files.cleanup();
    },
  };
}

test("Configured planning runs in the profile model and only the parent stores the complete proposal", async () => {
  // A proposal larger than status text must survive the entire hosted path.
  const app = await fixture();
  const proposal = draft();
  proposal.plan.tasks = Array.from({ length: 50 }, (_, i) => ({
    ...proposal.plan.tasks[0]!,
    id: `task${i}`,
    outputs: ["x".repeat(512)],
  }));
  app.setProposal(proposal);
  try {
    expectOk(await app.run("/plan Investigate the feature without implementation"));
    expect(expectOk(await app.stored())?.plan).toEqual(proposal.plan);
    expect(app.childModels.every((model) => model === "draft-a")).toBe(true);
    expect(app.childModels.length).toBeGreaterThan(0);
    expect(app.contexts[1]?.purpose).toBe("planning");
    expect(app.childTasks[0]).toContain("Investigate the feature");
    expect(app.executors[0]!.state.telemetry?.model).toBe("fixture");
    expect(await Bun.file(planFilePath(app.executors[1]!.sessionFile!)).exists()).toBe(false);
  } finally {
    await app.close();
  }
});

test("CHAT planning preserves the parent conversation owner without a repository-scoped sidecar", async () => {
  // CHAT has no worktree identity, but must use the same constrained planning protocol.
  const app = await fixture(true);
  try {
    expectOk(await app.run("/plan Plan the conversation task"));
    const current = expectOk(await app.stored())!;
    expect(current.owner.conversationId).toBe(app.executors[0]!.savedSessionId);
    expect(current.owner.cwd).toBe(app.contexts[0]!.cwd);
    expect(app.contexts[1]!.scope?.kind).toBe("chat");
    expect(app.contexts[1]!.purpose).toBe("planning");
    expect(await Bun.file(planFilePath(app.executors[1]!.sessionFile!)).exists()).toBe(false);
  } finally {
    await app.close();
  }
});

test("Editing only the planner profile selects a new model on the next invocation", async () => {
  // No product source or parent selection changes between planning requests.
  const app = await fixture();
  try {
    expectOk(await app.run("/plan First plan"));
    await app.profile("draft-b");
    const before = app.childModels.length;
    expectOk(await app.run("/plan Updated plan"));
    expect(app.childModels.slice(before).every((model) => model === "draft-b")).toBe(true);
    expect(app.childModels.slice(before).length).toBeGreaterThan(0);
    expect(app.executors[0]!.state.telemetry?.model).toBe("fixture");
  } finally {
    await app.close();
  }
});

test("Planner questions return through the parent and writes remain denied even with a wildcard profile", async () => {
  // Host planning policy must dominate an overly broad user tool list.
  const app = await fixture();
  try {
    app.forbidWrite();
    expectOk(await app.run("/plan Read only"));
    expect(await Bun.file(join(app.main, "forbidden.txt")).exists()).toBe(false);
    expect(expectOk(await app.stored())?.plan.goal).toBe("A delegated plan");
    app.ask();
    expectOk(await app.run("/plan Clarify acceptance"));
    expect(expectOk(await app.stored())?.review.summary).toContain("Reviewed");
  } finally {
    await app.close();
  }
});

test("A planner question can continue in a later user turn without changing the parent model", async () => {
  // The parent may settle while waiting for user input; the request identity must survive.
  const app = await fixture();
  try {
    app.ask(true);
    expectOk(await app.run("/plan Clarify the feature"));
    const runs = expectOk(await app.contexts[0]!.coordinateSubagents!({ action: "status" })) as {
      questions: { id: string }[];
    }[];
    const question = runs.flatMap((run) => run.questions)[0]!;
    expect(question).toBeDefined();
    expectOk(
      await app.run("Use the documented criterion.", {
        action: "reply",
        questionId: question.id,
        message: "Use the documented criterion.",
      }),
    );
    expect(expectOk(await app.stored())?.plan.goal).toBe("A delegated plan");
    expect(app.executors[0]!.state.telemetry?.model).toBe("fixture");
  } finally {
    await app.close();
  }
});

test("A completed proposal cannot replace a newer authoritative plan", async () => {
  // A slow or reviewed proposal is based on the hash captured at command acceptance.
  const app = await fixture();
  try {
    expectOk(await app.run("/plan Original plan"));
    app.pauseAcceptance();
    expectOk(await app.run("/plan Draft a revision"));
    const newer = draft();
    newer.plan.goal = "A newer accepted request";
    const stored = expectOk(
      await saveTaskPlan(
        app.executors[0]!.sessionFile!,
        { cwd: app.main, conversationId: app.executors[0]!.savedSessionId },
        newer.plan,
        newer.review,
      ),
    );
    expectOk(await app.run("Accept the earlier proposal", { action: "accept" }));
    expect(expectOk(await app.stored())?.hash).toBe(stored.hash);
  } finally {
    await app.close();
  }
});

test("An unavailable configured model does not silently use the parent model", async () => {
  // Profile resolution may succeed while the requested model is unavailable.
  const app = await fixture();
  try {
    expectOk(await app.run("/plan Original plan"));
    const before = expectOk(await app.stored())!;
    const calls = app.childModels.length;
    await app.profile("missing");
    expectOk(await app.run("/plan Use the unavailable model"));
    expect(app.childModels).toHaveLength(calls);
    expect(expectOk(await app.stored())?.hash).toBe(before.hash);
  } finally {
    await app.close();
  }
});

test("Invalid planner graphs preserve the previous authoritative plan", async () => {
  // Failed proposal validation must not replace a previously accepted graph.
  const app = await fixture();
  try {
    expectOk(await app.run("/plan Valid proposal"));
    const before = expectOk(await app.stored())!;
    const invalid = draft();
    invalid.plan.tasks[0]!.dependsOn = ["missing"];
    app.setProposal(invalid);
    expectOk(await app.run("/plan Invalid proposal"));
    expect(expectOk(await app.stored())?.hash).toBe(before.hash);
  } finally {
    await app.close();
  }
});

test("Cancelling a planner waiting for a decision preserves the plan and releases the owned run", async () => {
  // An unanswered question must not trap the next user request in a blocked tool call.
  const app = await fixture();
  try {
    expectOk(await app.run("/plan Initial proposal"));
    const before = expectOk(await app.stored())!;
    app.ask(true);
    expectOk(await app.run("/plan Ask a material question"));
    expectOk(await app.run("Cancel planner"));
    expect(expectOk(await app.stored())?.hash).toBe(before.hash);
    const runs = expectOk(await app.contexts[0]!.coordinateSubagents!({ action: "status" })) as {
      questions: unknown[];
      status: string;
    }[];
    expect(runs.every((run) => !run.questions.length && run.status !== "working")).toBe(true);
  } finally {
    await app.close();
  }
});
