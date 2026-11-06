import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type ToolCall } from "@earendil-works/pi-ai";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { SessionRegistry, type SessionContext, type SessionExecutor } from "./session-registry.ts";
import { piSessionFactory, type PiSessionOptions } from "./pi-session-adapter.ts";
import { readTaskPlan, planFilePath, saveTaskPlan } from "./task-plan-store.ts";
import type { PlanningProposal } from "./planning-proposal.ts";
import { openWorkflow } from "./task-workflow-store.ts";

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
  let hierarchical = false;
  let publishTwice = false;
  const parentTools: { name: string; arguments: unknown }[] = [];
  const parentRequests: string[] = [];
  const childResults: { name: string; error: boolean; text: string }[] = [];
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
  const childLoadouts: string[][] = [];
  const profile = (id = "draft-a") =>
    writeFile(
      join(agentDir, "agents", "planner.md"),
      `---\nname: planner\ndescription: Planning fixture\nmodel: planner-fixture/${id}\nthinking: high\ntools: ['*']\n---\nDraft only.\n`,
    );
  await profile();
  for (const [name, model] of [
    ["tech-lead", "draft-a"],
    ["product-lead", "draft-b"],
  ])
    await writeFile(
      join(agentDir, "agents", `${name}.md`),
      `---\nname: ${name}\ndescription: Branch planning fixture\nmodel: planner-fixture/${model}\n---\nPublish only a bounded plan reference.\n`,
    );
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
        const active = new Set<string>();
        for (const message of context.messages) {
          if (message.role !== "system") continue;
          for (const tool of message.toolsRemoved ?? []) active.delete(tool.name);
          for (const tool of message.toolsAdded ?? []) active.add(tool.name);
        }
        childLoadouts.push([...active].sort());
        childModels.push(model.id);
        if (hierarchical) {
          if (last?.role === "toolResult")
            childResults.push({
              name: last.toolName,
              error: !!last.isError,
              text: contentText(last.content),
            });
          const branch = model.id === "draft-a" ? "tech" : "product";
          if (branch === "product" && last?.role !== "toolResult" && !ask)
            return response(model, {
              name: "radian-task",
              arguments: { action: "status", artifact: "tech-plan@2" },
            });
          if (forbidden && last?.role !== "toolResult")
            return response(model, {
              name: "write",
              arguments: { path: join(files.main, "forbidden.txt"), content: "unexpected" },
            });
          if (forbidden && last?.role === "toolResult" && last.toolName === "write")
            return response(model, {
              name: "edit",
              arguments: {
                path: join(files.main, "forbidden.txt"),
                edits: [{ oldText: "before", newText: "after" }],
              },
            });
          if (ask && last?.role !== "toolResult")
            return response(model, {
              name: "radian-supervisor",
              arguments: { action: "ask", message: "Which acceptance criterion applies?" },
            });
          if (
            last?.role !== "toolResult" ||
            last.toolName !== "radian-task" ||
            (branch === "product" &&
              ((last.isError && contentText(last.content).includes("Only the owning lead/root")) ||
                (!last.isError && contentText(last.content).includes('"schemaVersion"')))) ||
            (publishTwice &&
              branch === "tech" &&
              contentText(last.content).includes(`${branch}-plan@1`))
          )
            return response(model, {
              name: "radian-task",
              arguments: { action: "publish-plan", artifactId: `${branch}-plan`, ...proposal },
            });
          return response(model, undefined, `Published ${branch}-plan; see the durable summary.`);
        }
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
      parentRequests.push(JSON.stringify(context.messages));
      if (hierarchical) {
        const tool = parentTools.shift();
        return response(model, tool, "Planning summary only; execution not started.");
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
  let parent = expectOk(await (chat ? registry.createChat() : registry.create(files.main)));
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
    if (registry.details(parent)?.status === "working") {
      const done = Promise.withResolvers<void>();
      const unsubscribe = registry.subscribe(() => {
        if (registry.details(parent)?.status !== "working") done.resolve();
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
    get parent() {
      return parent;
    },
    async reopen() {
      const file = registry.sessionFile(parent)!;
      expectOk(await registry.close(parent));
      parent = expectOk(
        await (chat ? registry.createChat(file) : registry.create(files.main, file)),
      );
    },
    contexts,
    executors,
    childModels,
    childTasks,
    childLoadouts,
    parentRequests,
    childResults,
    hierarchy(tools: { name: string; arguments: unknown }[] = [], twice = false) {
      hierarchical = true;
      publishTwice = twice;
      parentTools.push(...tools);
    },
    profile,
    removeLegacyProfile: () => rm(join(agentDir, "agents", "planner.md")),
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
    stopAsking() {
      ask = false;
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

test("Legacy --single configured planning runs in the profile model and only the parent stores the complete proposal", async () => {
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
    expectOk(await app.run("/plan --single Investigate the feature without implementation"));
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

test("Legacy --single CHAT planning preserves the parent conversation owner without a repository-scoped sidecar", async () => {
  // CHAT has no worktree identity, but must use the same constrained planning protocol.
  const app = await fixture(true);
  try {
    expectOk(await app.run("/plan --single Plan the conversation task"));
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

test("Legacy --single editing only the planner profile selects a new model on the next invocation", async () => {
  // No product source or parent selection changes between planning requests.
  const app = await fixture();
  try {
    expectOk(await app.run("/plan --single First plan"));
    await app.profile("draft-b");
    const before = app.childModels.length;
    expectOk(await app.run("/plan --single Updated plan"));
    expect(app.childModels.slice(before).every((model) => model === "draft-b")).toBe(true);
    expect(app.childModels.slice(before).length).toBeGreaterThan(0);
    expect(app.executors[0]!.state.telemetry?.model).toBe("fixture");
  } finally {
    await app.close();
  }
});

test("Legacy --single planner questions return through the parent and writes remain denied even with a wildcard profile", async () => {
  // Host planning policy must dominate an overly broad user tool list.
  const app = await fixture();
  try {
    app.forbidWrite();
    expectOk(await app.run("/plan --single Read only"));
    expect(await Bun.file(join(app.main, "forbidden.txt")).exists()).toBe(false);
    expect(expectOk(await app.stored())?.plan.goal).toBe("A delegated plan");
    app.ask();
    expectOk(await app.run("/plan --single Clarify acceptance"));
    expect(expectOk(await app.stored())?.review.summary).toContain("Reviewed");
  } finally {
    await app.close();
  }
});

test("Legacy --single planner questions can continue in a later user turn without changing the parent model", async () => {
  // The parent may settle while waiting for user input; the request identity must survive.
  const app = await fixture();
  try {
    app.ask(true);
    expectOk(await app.run("/plan --single Clarify the feature"));
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

test("Legacy --single completed proposals cannot replace a newer authoritative plan", async () => {
  // A slow or reviewed proposal is based on the hash captured at command acceptance.
  const app = await fixture();
  try {
    expectOk(await app.run("/plan --single Original plan"));
    app.pauseAcceptance();
    expectOk(await app.run("/plan --single Draft a revision"));
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

test("Legacy --single unavailable configured model does not silently use the parent model", async () => {
  // Profile resolution may succeed while the requested model is unavailable.
  const app = await fixture();
  try {
    expectOk(await app.run("/plan --single Original plan"));
    const before = expectOk(await app.stored())!;
    const calls = app.childModels.length;
    await app.profile("missing");
    expectOk(await app.run("/plan --single Use the unavailable model"));
    expect(app.childModels).toHaveLength(calls);
    expect(expectOk(await app.stored())?.hash).toBe(before.hash);
  } finally {
    await app.close();
  }
});

test("Legacy --single invalid planner graphs preserve the previous authoritative plan", async () => {
  // Failed proposal validation must not replace a previously accepted graph.
  const app = await fixture();
  try {
    expectOk(await app.run("/plan --single Valid proposal"));
    const before = expectOk(await app.stored())!;
    const invalid = draft();
    invalid.plan.tasks[0]!.dependsOn = ["missing"];
    app.setProposal(invalid);
    expectOk(await app.run("/plan --single Invalid proposal"));
    expect(expectOk(await app.stored())?.hash).toBe(before.hash);
  } finally {
    await app.close();
  }
});

test("Legacy --single cancelling a planner waiting for a decision preserves the plan and releases the owned run", async () => {
  // An unanswered question must not trap the next user request in a blocked tool call.
  const app = await fixture();
  try {
    expectOk(await app.run("/plan --single Initial proposal"));
    const before = expectOk(await app.stored())!;
    app.ask(true);
    expectOk(await app.run("/plan --single Ask a material question"));
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

const branch = (id: string, profile = `${id}-lead`, dependsOn: string[] = []) => ({
  id,
  title: `${id} planning`,
  lead: { profile },
  scope: `Investigate ${id}`,
  dependsOn,
});
const declare = (branches = [branch("tech")]) => ({
  name: "radian-task",
  arguments: { action: "declare", goal: "Hierarchical feature", branches },
});
const spawn = (id: string) => ({
  name: "radian-subagent",
  arguments: {
    action: "spawn",
    agent: `${id}-lead`,
    task: `Plan ${id}; publish-plan and return only its reference.`,
    binding: { id, role: "lead" },
  },
});
const wait = { name: "radian-subagent", arguments: { action: "wait" } };
const reportReadiness = { name: "radian-plan", arguments: { action: "report" } };
const transcript = (executor: SessionExecutor) => Bun.file(executor.sessionFile!).text();
const legacyNotice =
  "commandAgents.plan (planner) is a legacy single-planner binding and is not used by hierarchical /plan; run /plan --single to use it.";

test("An ordinary turn spawns a plan-kind lead with only read-only and host protocol tools", async () => {
  const app = await fixture();
  app.hierarchy([declare(), spawn("tech"), wait]);
  try {
    // Task kind alone must protect the child when the root never invoked /plan.
    expectOk(await app.run("Investigate the declared branch"));

    expect(app.contexts[1]!.purpose).toBe("planning");
    expect(app.contexts[1]!.binding?.purpose).toBe("planning");
    expect(app.childLoadouts.length).toBeGreaterThan(0);
    // Built-in leads retain host-owned delegation eligibility even with legacy role prose.
    for (const tools of app.childLoadouts)
      expect(tools).toEqual([
        "find",
        "grep",
        "ls",
        "radian-subagent",
        "radian-supervisor",
        "radian-task",
        "read",
      ]);
    expect(app.childResults.some((result) => result.name === "radian-task" && !result.error)).toBe(
      true,
    );
  } finally {
    await app.close();
  }
});

test.each(["ordinary turn", "reload", "reopen"])(
  "An active hierarchical invocation retains read-only scope across %s",
  async (lifecycle) => {
    const app = await fixture();
    app.hierarchy([declare()]);
    const marker = join(app.main, "forbidden-followup.txt");
    try {
      expectOk(await app.run("/plan Investigate only"));
      if (lifecycle === "reload") expectOk(await app.registry.reload(app.parent));
      if (lifecycle === "reopen") await app.reopen();
      const contextsBeforeFollowup = app.contexts.length;
      app.hierarchy([
        { name: "write", arguments: { path: marker, content: "unexpected" } },
        {
          name: "radian-subagent",
          arguments: { action: "spawn", agent: "tech-lead", task: "Unbound escape" },
        },
        spawn("tech"),
        wait,
        reportReadiness,
      ]);

      // A plain user message neither ends the invocation nor admits unbound work.
      expectOk(await app.run("Continue the declared investigation"));

      expect(await Bun.file(marker).exists()).toBe(false);
      expect(app.contexts).toHaveLength(contextsBeforeFollowup + 1);
      expect(app.contexts.at(-1)!.purpose).toBe("planning");
      const rootIndex = app.contexts.findLastIndex((context) => context.role === "main");
      expect(await transcript(app.executors[rootIndex]!)).toContain(
        "Hierarchical spawning requires",
      );
      const workflow = expectOk(
        await openWorkflow(app.executors[rootIndex]!.sessionFile!, {
          cwd: app.contexts[rootIndex]!.cwd,
          conversationId: app.executors[rootIndex]!.savedSessionId,
        }),
      )!;
      expect(workflow.doc.artifacts["tech-plan"]!.revisions).toHaveLength(1);
    } finally {
      await app.close();
    }
  },
);

test.each(["cancel", "single"])(
  "Explicit %s ends an earlier hierarchical invocation durably without changing legacy scope",
  async (ending) => {
    const app = await fixture();
    app.hierarchy([declare()]);
    const marker = join(app.main, "ordinary-after-planning.txt");
    try {
      expectOk(await app.run("/plan Investigate only"));
      await app.reopen();
      if (ending === "cancel") {
        app.hierarchy([{ name: "radian-plan", arguments: { action: "cancel" } }]);
        expectOk(await app.run("Cancel the planning request"));
      } else {
        // Explicit legacy mode remains turn-scoped and supersedes the durable hierarchy.
        expectOk(await app.run("/plan --single Legacy investigation"));
      }
      await app.reopen();
      app.hierarchy([{ name: "write", arguments: { path: marker, content: "ordinary tool" } }]);

      expectOk(await app.run("Perform ordinary user-authorized work"));

      expect(await Bun.file(marker).text()).toBe("ordinary tool");
      expect(app.contexts.every((context) => context.role === "main")).toBe(true);
    } finally {
      await app.close();
    }
  },
);

test("Q02 real host rejects a prior-run lead after its branch is re-declared", async () => {
  // Keep an actual SDK lead waiting while the root commits a new declaration.
  const app = await fixture();
  app.ask(true);
  app.hierarchy([declare(), spawn("tech"), wait]);
  try {
    expectOk(await app.run("/plan Initial declaration"));
    const root = app.contexts[0]!;
    expectOk(
      await root.coordinateTask!(
        { action: "declare", goal: "Replanned", branches: [branch("tech")] },
        "redeclare",
      ),
    );

    // The old assignment version is still valid, but the binding predates this declaration.
    const denied = expectError(
      await app.contexts[1]!.coordinateTask!(
        { action: "publish-plan", artifactId: "tech-plan", ...draft() },
        "stale-publish",
      ),
    );
    expect(denied.code).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(denied.message).toBe("Binding predates the current declaration; respawn the lead.");
    const doc = expectOk(
      await openWorkflow(app.executors[0]!.sessionFile!, {
        cwd: root.cwd,
        conversationId: app.executors[0]!.savedSessionId,
      }),
    )!.doc;
    expect(doc.tasks.tech!.assignmentVersion).toBe(0);
    expect(doc.artifacts["tech-plan"]).toBeUndefined();
  } finally {
    await app.close();
  }
});

test("Q02 real host freezes upstream receipts at dependent spawn and respawn refreshes coverage", async () => {
  // The upstream is published before a dependent lead starts its read-only investigation.
  const app = await fixture();
  const proposal = draft();
  const sentinel = "PRIVATE_FROZEN_INPUT_BODY_D10";
  proposal.plan.tasks[0]!.acceptanceCriteria = [sentinel];
  proposal.plan.goal = "Upstream frozen summary one";
  app.setProposal(proposal);
  app.hierarchy([
    declare([branch("tech"), branch("product", "product-lead", ["tech"])]),
    spawn("tech"),
    wait,
  ]);
  try {
    expectOk(await app.run("/plan Dependency coverage"));
    const root = app.contexts[0]!;
    app.ask(true);
    const dependent = expectOk(
      await root.coordinateSubagents!(
        spawn("product").arguments as Parameters<
          NonNullable<SessionContext["coordinateSubagents"]>
        >[0],
      ),
    ) as { id: string };
    expectOk(await root.coordinateSubagents!({ action: "wait", id: dependent.id }));
    const runs = expectOk(await root.coordinateSubagents!({ action: "status" })) as {
      id: string;
      questions: { id: string }[];
    }[];
    const question = runs.find((run) => run.id === dependent.id)!.questions[0]!;
    const dependentContext = app.contexts.at(-1)!;
    const ownStatus = expectOk(
      await dependentContext.coordinateTask!({ action: "status" }, "own-status"),
    ) as string;
    expect(ownStatus).toContain("tech-plan@1 (tech):");
    expect(ownStatus).toContain("Upstream frozen summary one");
    expect(ownStatus).toContain("radian-task status artifact=<ref@revision>");
    expect(ownStatus).not.toContain(sentinel);
    expect(ownStatus.length).toBeLessThanOrEqual(16000);
    const readInput = (context: SessionContext, artifact: string) =>
      context.coordinateTask!({ action: "status", artifact }, `read-${artifact}`);
    expect(JSON.stringify(expectOk(await readInput(dependentContext, "tech-plan@1")))).toContain(
      sentinel,
    );
    for (const artifact of [
      "absent@1",
      "product-plan@1",
      "tech-plan",
      "tech-plan@latest",
      "tech-plan@1.0",
      "tech-plan@1@2",
      "tech-plan@+1",
      "tech-plan@1\n",
      "tech-plan@ 1",
      "tech-plan@1e0",
    ]) {
      const denied = expectError(await readInput(dependentContext, artifact));
      expect(denied.code).toBe("WORKFLOW_NOT_AUTHORIZED");
      expect(denied.message).not.toContain(sentinel);
    }
    expect(expectOk(await root.coordinateTask!({ action: "status" }, "root-status"))).not.toContain(
      "Frozen inputs for",
    );
    expect(
      expectOk(
        await dependentContext.coordinateTask!({ action: "status", id: "tech" }, "other-status"),
      ),
    ).not.toContain("Frozen inputs for");

    // Republish upstream while the dependent is still working, then allow it to publish.
    app.stopAsking();
    const newer = structuredClone(proposal);
    newer.plan.goal = "Upstream replacement summary two";
    app.setProposal(newer);
    const upstream = expectOk(
      await root.coordinateSubagents!(
        spawn("tech").arguments as Parameters<
          NonNullable<SessionContext["coordinateSubagents"]>
        >[0],
      ),
    ) as { id: string };
    expectOk(await root.coordinateSubagents!({ action: "wait", id: upstream.id }));
    for (const artifact of ["tech-plan@2", "tech-plan"])
      expect(expectError(await readInput(dependentContext, artifact)).code).toBe(
        "WORKFLOW_NOT_AUTHORIZED",
      );
    expect(JSON.stringify(expectOk(await readInput(dependentContext, "tech-plan@1")))).toContain(
      sentinel,
    );
    const frozenStatus = expectOk(
      await dependentContext.coordinateTask!({ action: "status", id: "product" }, "frozen-status"),
    ) as string;
    const frozenSection = frozenStatus.slice(frozenStatus.indexOf("Frozen inputs for"));
    expect(frozenSection).toContain("tech-plan@1");
    expect(frozenSection).toContain("Upstream frozen summary one");
    expect(frozenSection).not.toContain("tech-plan@2");
    expect(frozenSection).not.toContain("Upstream replacement summary two");
    expect(frozenStatus).not.toContain(sentinel);
    expectOk(
      await root.coordinateSubagents!({
        action: "reply",
        id: dependent.id,
        questionId: question.id,
        message: "Continue the review.",
      }),
    );
    expectOk(await root.coordinateSubagents!({ action: "wait", id: dependent.id }));
    const read = async () =>
      expectOk(
        await openWorkflow(app.executors[0]!.sessionFile!, {
          cwd: root.cwd,
          conversationId: app.executors[0]!.savedSessionId,
        }),
      )!.doc;
    let doc = await read();
    expect(doc.artifacts["tech-plan"]!.revisions).toHaveLength(2);
    expect(doc.artifacts["product-plan"]!.revisions.at(-1)!.dependencies).toEqual([
      { artifactId: "tech-plan", revision: 1 },
    ]);
    app.hierarchy([reportReadiness]);
    expectOk(await app.run("Report coverage"));
    expect(await transcript(app.executors[0]!)).toContain(
      "Dependency coverage obsolete: product reviewed tech-plan@1; current tech-plan@2.",
    );

    // A replacement dependent receives the current upstream revision at its own spawn.
    app.ask(true);
    const replacement = expectOk(
      await root.coordinateSubagents!(
        spawn("product").arguments as Parameters<
          NonNullable<SessionContext["coordinateSubagents"]>
        >[0],
      ),
    ) as { id: string };
    expectOk(await root.coordinateSubagents!({ action: "wait", id: replacement.id }));
    const replacementContext = app.contexts.at(-1)!;
    const replacementStatus = expectOk(
      await replacementContext.coordinateTask!({ action: "status" }, "replacement-status"),
    ) as string;
    expect(replacementStatus).toContain("tech-plan@2 (tech):");
    expect(replacementStatus).not.toContain(sentinel);
    expect(JSON.stringify(expectOk(await readInput(replacementContext, "tech-plan@2")))).toContain(
      sentinel,
    );
    expect(expectError(await readInput(replacementContext, "tech-plan@1")).code).toBe(
      "WORKFLOW_NOT_AUTHORIZED",
    );
    for (const artifact of ["tech-plan@1", "tech-plan@2", "tech-plan"])
      expect(JSON.stringify(expectOk(await readInput(root, artifact)))).toContain(sentinel);
    const replacementRuns = expectOk(await root.coordinateSubagents!({ action: "status" })) as {
      id: string;
      questions: { id: string }[];
    }[];
    app.stopAsking();
    expectOk(
      await root.coordinateSubagents!({
        action: "reply",
        id: replacement.id,
        questionId: replacementRuns.find((run) => run.id === replacement.id)!.questions[0]!.id,
        message: "Publish refreshed coverage.",
      }),
    );
    expectOk(await root.coordinateSubagents!({ action: "wait", id: replacement.id }));
    doc = await read();
    expect(doc.artifacts["product-plan"]!.revisions.at(-1)!.dependencies).toEqual([
      { artifactId: "tech-plan", revision: 2 },
    ]);
    app.hierarchy([reportReadiness]);
    expectOk(await app.run("Report refreshed coverage"));
    const text = await transcript(app.executors[0]!);
    expect(text.slice(text.lastIndexOf('"toolName":"radian-plan"'))).toContain(
      "Planning: ready for review",
    );
    expect(text).not.toContain(sentinel);
    expect(app.parentRequests.join("\n")).not.toContain(sentinel);
  } finally {
    await app.close();
  }
});

test.each(["redeclare", "reassign"] as const)(
  "D10 dependent reads reject a binding after %s",
  async (change) => {
    // A real SDK dependent holds a valid frozen input until the host revokes its declaration or assignment.
    const app = await fixture();
    const branches = [branch("tech"), branch("product", "product-lead", ["tech"])];
    app.hierarchy([declare(branches), spawn("tech"), wait]);
    try {
      expectOk(await app.run("/plan Read current dependencies"));
      const root = app.contexts[0]!;
      app.ask(true);
      const dependent = expectOk(
        await root.coordinateSubagents!(
          spawn("product").arguments as Parameters<
            NonNullable<SessionContext["coordinateSubagents"]>
          >[0],
        ),
      ) as { id: string };
      expectOk(await root.coordinateSubagents!({ action: "wait", id: dependent.id }));
      const context = app.contexts.at(-1)!;
      expectOk(
        await context.coordinateTask!(
          { action: "status", artifact: "tech-plan@1" },
          "before-change",
        ),
      );

      if (change === "redeclare")
        expectOk(
          await root.coordinateTask!(
            { action: "declare", goal: "New declaration", branches },
            "redeclare",
          ),
        );
      else
        expectOk(
          await root.coordinateTask!(
            { action: "reassign", taskId: "product", role: "lead", profile: "product-lead" },
            "reassign",
            undefined,
            ["product-lead"],
          ),
        );

      // Old snapshots must never bypass current binding and declaration authorization.
      const denied = expectError(
        await context.coordinateTask!(
          { action: "status", artifact: "tech-plan@1" },
          "after-change",
        ),
      );
      expect(denied.code).toBe("WORKFLOW_NOT_AUTHORIZED");
      expect(denied.message).toBe(
        change === "redeclare"
          ? "Binding predates the current declaration; respawn the lead."
          : "Workflow binding is missing, revoked or cancelled.",
      );
    } finally {
      await app.close();
    }
  },
);

test("D10 a dependent spawned before publication retains missing coverage", async () => {
  // Publishing upstream later cannot fabricate a review receipt for an already-running dependent.
  const app = await fixture();
  app.hierarchy([declare([branch("tech"), branch("product", "product-lead", ["tech"])])]);
  try {
    expectOk(await app.run("/plan Missing prerequisite"));
    const root = app.contexts[0]!;
    app.ask(true);
    const dependent = expectOk(
      await root.coordinateSubagents!(
        spawn("product").arguments as Parameters<
          NonNullable<SessionContext["coordinateSubagents"]>
        >[0],
      ),
    ) as { id: string };
    expectOk(await root.coordinateSubagents!({ action: "wait", id: dependent.id }));
    const context = app.contexts.at(-1)!;
    const status = expectOk(
      await context.coordinateTask!({ action: "status" }, "missing-status"),
    ) as string;
    expect(status).toContain("tech: missing (no current artifact at spawn)");
    app.stopAsking();
    const upstream = expectOk(
      await root.coordinateSubagents!(
        spawn("tech").arguments as Parameters<
          NonNullable<SessionContext["coordinateSubagents"]>
        >[0],
      ),
    ) as { id: string };
    expectOk(await root.coordinateSubagents!({ action: "wait", id: upstream.id }));

    const laterStatus = expectOk(
      await context.coordinateTask!({ action: "status" }, "still-missing"),
    ) as string;
    expect(laterStatus).toContain("tech: missing (no current artifact at spawn)");
    expect(
      expectError(
        await context.coordinateTask!({ action: "status", artifact: "tech-plan@1" }, "late-read"),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expectOk(
      await context.coordinateTask!(
        { action: "publish-plan", artifactId: "product-plan", ...draft() },
        "publish-missing",
      ),
    );
    app.hierarchy([reportReadiness]);
    expectOk(await app.run("Report missing coverage"));
    const text = await transcript(app.executors[0]!);
    expect(text).toContain(
      "Dependency coverage missing: product has no host-captured review of tech-plan@1.",
    );
    expect(text).not.toContain("Planning: ready for review");
  } finally {
    await app.close();
  }
});

test("D10 dependent verifier receives the same frozen read-only input authority", async () => {
  // Verifiers run through the ordinary bound SDK path, not the planning-only lead spawn path.
  const app = await fixture();
  app.hierarchy([
    declare([branch("tech"), branch("product", "product-lead", ["tech"])]),
    spawn("tech"),
    wait,
  ]);
  try {
    expectOk(await app.run("/plan Prepare verifier input"));
    const root = app.contexts[0]!;
    expectOk(
      await root.coordinateTask!(
        { action: "reassign", taskId: "product", role: "verifier", profile: "product-lead" },
        "assign-qa",
        undefined,
        ["product-lead"],
      ),
    );
    app.ask(true);
    const verifier = expectOk(
      await root.coordinateSubagents!({
        action: "spawn",
        agent: "product-lead",
        task: "Review the frozen prerequisite only.",
        binding: { id: "product", role: "verifier" },
      }),
    ) as { id: string };
    expectOk(await root.coordinateSubagents!({ action: "wait", id: verifier.id }));
    const context = app.contexts.at(-1)!;

    expect(context.binding?.role).toBe("verifier");
    expect(expectOk(await context.coordinateTask!({ action: "status" }, "qa-status"))).toContain(
      "tech-plan@1 (tech):",
    );
    expect(
      expectOk(
        await context.coordinateTask!({ action: "status", artifact: "tech-plan@1" }, "qa-read"),
      ),
    ).toEqual(draft());
    expect(
      expectError(
        await context.coordinateTask!({ action: "status", artifact: "tech-plan" }, "qa-latest"),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(
      expectError(
        await context.coordinateTask!(
          { action: "publish-plan", artifactId: "product-plan", ...draft() },
          "qa-publish",
        ),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
    expect(
      expectError(
        await context.coordinateTask!(
          { action: "reassign", taskId: "tech", role: "lead", profile: "product-lead" },
          "qa-control",
        ),
      ).code,
    ).toBe("WORKFLOW_NOT_AUTHORIZED");
  } finally {
    await app.close();
  }
});

test("Q01 hierarchical leads publish revision provenance while root sees references, not bodies", async () => {
  // Two independently owned branches must not share artifact body authority.
  const app = await fixture();
  const proposal = draft();
  const sentinel = "PRIVATE_ACCEPTANCE_BODY_SENTINEL_Q01";
  proposal.plan.tasks[0]!.acceptanceCriteria = [sentinel];
  app.setProposal(proposal);
  app.hierarchy(
    [
      declare([branch("tech"), branch("product")]),
      spawn("tech"),
      wait,
      spawn("product"),
      wait,
      reportReadiness,
    ],
    true,
  );
  try {
    // The real command, adapter and host persist lead-owned artifacts without parent acceptance.
    expectOk(await app.run("/plan Plan the feature"));
    const owner = { cwd: app.contexts[0]!.cwd, conversationId: app.executors[0]!.savedSessionId };
    const workflow = expectOk(await openWorkflow(app.executors[0]!.sessionFile!, owner))!.doc;
    const revisions = workflow.artifacts["tech-plan"]!.revisions;

    // Parent-visible results/context carry bounded references and summaries only.
    expect(revisions.map((revision) => revision.revision)).toEqual([1, 2]);
    const runs = expectOk(await app.contexts[0]!.coordinateSubagents!({ action: "status" })) as {
      id: string;
      agent: string;
    }[];
    expect(revisions[1]!.author).toEqual({
      runId: runs.find((run) => run.agent === "tech-lead")!.id,
      profile: "tech-lead",
      role: "lead",
    });
    const visible = app.parentRequests.join("\n");
    expect(visible).toContain("tech-plan@2");
    expect(visible).toContain("external dependencies");
    expect(visible).not.toContain(sentinel);
    expect(await transcript(app.executors[0]!)).not.toContain(sentinel);
    expect(await transcript(app.executors[0]!)).toContain("ready for review");
    expect(expectOk(await app.stored())).toBeNull();
    const retrieved = expectOk(
      await app.contexts[0]!.coordinateTask!(
        { action: "status", artifact: "tech-plan@2" },
        "root-read",
      ),
    );
    expect(JSON.stringify(retrieved)).toContain(sentinel);
    const denied = app.childResults.find((result) => result.name === "radian-task" && result.error);
    expect(denied?.text).toContain(
      "Only the owning lead/root or a dependent run with this frozen input revision may request this artifact",
    );
    expect(denied?.text).not.toContain(sentinel);
  } finally {
    await app.close();
  }
});

test("Q02 hierarchical readiness preserves missing artifacts and manifest diagnostics as incomplete", async () => {
  // Unknown assignments, missing edges and a cycle remain durable review blockers.
  const app = await fixture();
  app.hierarchy([
    declare([
      branch("tech", "unknown-profile", ["product", "absent"]),
      branch("product", "product-lead", ["tech"]),
    ]),
    reportReadiness,
  ]);
  try {
    expectOk(await app.run("/plan Diagnose the scope"));

    const text = await transcript(app.executors[0]!);
    expect(text).toContain("Planning: incomplete");
    expect(text).toContain("Missing branch artifact: tech");
    expect(text).toContain("Unknown profile: unknown-profile");
    expect(text).toContain("absent");
    expect(text.toLowerCase()).toContain("cycle");
    expect(text).toContain("Cross-branch dependency tech -> product has no artifact");
    expect(text).not.toContain("Planning: ready for review");
    expect(text).toContain(legacyNotice);
  } finally {
    await app.close();
  }
});

test("Q03 hierarchical /plan spawns only bound read-only leads and blocks parent and child writes", async () => {
  // Wildcard tools must not override planning purpose or permit an unbound spawn.
  const app = await fixture();
  app.forbidWrite();
  app.hierarchy([
    declare(),
    {
      name: "write",
      arguments: { path: join(app.main, "parent-forbidden.txt"), content: "unexpected" },
    },
    {
      name: "edit",
      arguments: {
        path: join(app.main, "parent-forbidden.txt"),
        edits: [{ oldText: "before", newText: "after" }],
      },
    },
    {
      name: "radian-subagent",
      arguments: { action: "spawn", agent: "planner", task: "Unbound work" },
    },
    spawn("tech"),
    wait,
    reportReadiness,
  ]);
  try {
    expectOk(await app.run("/plan Investigate without implementation"));

    expect(app.contexts).toHaveLength(2);
    expect(app.contexts[1]!.purpose).toBe("planning");
    expect(app.contexts[1]!.binding).toMatchObject({
      taskId: "tech",
      role: "lead",
      purpose: "planning",
    });
    expect(
      app.childResults
        .filter((result) => ["edit", "write"].includes(result.name))
        .map((result) => [result.name, result.error]),
    ).toEqual([
      ["write", true],
      ["edit", true],
    ]);
    expect(await Bun.file(join(app.main, "forbidden.txt")).exists()).toBe(false);
    expect(await Bun.file(join(app.main, "parent-forbidden.txt")).exists()).toBe(false);
    expect(await transcript(app.executors[0]!)).toContain("declared branch lead binding");
  } finally {
    await app.close();
  }
});

test("Q02 unresolved planner questions remain incomplete and cancel stops runs without deleting scope", async () => {
  // A waiting lead has not published a plan; cancellation cannot fabricate readiness.
  const app = await fixture();
  app.ask(true);
  app.hierarchy([
    declare(),
    spawn("tech"),
    wait,
    reportReadiness,
    { name: "radian-plan", arguments: { action: "cancel" } },
    reportReadiness,
  ]);
  try {
    expectOk(await app.run("/plan Clarify before planning"));

    const text = await transcript(app.executors[0]!);
    expect(text).toContain("Unresolved planner question:");
    expect(text).toContain("Which acceptance criterion applies?");
    expect(text).not.toContain("Planning: ready for review");
    const runs = expectOk(await app.contexts[0]!.coordinateSubagents!({ action: "status" })) as {
      status: string;
      questions: unknown[];
    }[];
    expect(runs.every((run) => run.status !== "working" && run.questions.length === 0)).toBe(true);
    const workflow = expectOk(
      await openWorkflow(app.executors[0]!.sessionFile!, {
        cwd: app.contexts[0]!.cwd,
        conversationId: app.executors[0]!.savedSessionId,
      }),
    );
    expect(workflow!.doc.tasks.tech).toBeDefined();
    expect(workflow!.doc.artifacts).toEqual({});
  } finally {
    await app.close();
  }
});

test("Q03 plain /plan ignores an unavailable legacy binding with an explicit request and report notice", async () => {
  // An obsolete legacy profile cannot prevent hierarchical planning or become a super-planner.
  const app = await fixture();
  await app.removeLegacyProfile();
  app.hierarchy();
  try {
    expectOk(await app.run("/plan Inspect requirements"));

    expect(app.contexts).toHaveLength(1);
    expect(app.parentRequests[0]).toContain(legacyNotice);
    expect(await transcript(app.executors[0]!)).toContain(legacyNotice);
    expect(await transcript(app.executors[0]!)).toContain("Planning: incomplete");
    expect(expectOk(await app.stored())).toBeNull();
  } finally {
    await app.close();
  }
});
