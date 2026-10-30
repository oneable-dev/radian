import { expect, test } from "bun:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdtemp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { expectOk } from "../testing/results.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { planFilePath, readTaskPlan } from "./task-plan-store.ts";
import type { TaskPlan } from "./task-plan.ts";
import { taskPlanningExtension } from "./task-planning.ts";

function proposal(goal = "Deliver a reviewed feature"): TaskPlan {
  return {
    schemaVersion: 1,
    goal,
    outOfScope: ["Deployment"],
    assumptions: [],
    openQuestions: [],
    tasks: [
      {
        id: "contract",
        title: "Define the contract",
        agent: "main",
        dependsOn: [],
        inputs: [],
        outputs: ["API contract"],
        acceptanceCriteria: ["Inputs and outputs are documented"],
        files: [],
      },
      {
        id: "implement",
        title: "Implement the contract",
        agent: "probe",
        dependsOn: ["contract"],
        inputs: ["API contract"],
        outputs: ["Feature patch"],
        acceptanceCriteria: ["Relevant tests pass"],
        files: ["src/feature.ts"],
      },
    ],
  };
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-task-planning-")));
  const options = await offlineRuntime(join(directory, "agent"));
  await mkdir(options.sessionDir!, { recursive: true });
  const sessions: AgentSession[] = [];
  const requests: string[] = [];
  const errors: string[] = [];
  let delegations = 0;
  let plan = proposal();
  let nextTool: Pick<ToolCall, "name" | "arguments"> | undefined;
  const queuedTools: Pick<ToolCall, "name" | "arguments">[] = [];
  let submit = true;
  let transformInput = false;

  async function open(file?: string) {
    let planRequestStarted = false;
    let callsInRun = 0;
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: options.agentDir!,
      settingsManager,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        taskPlanningExtension(),
        (pi) => {
          pi.on("before_agent_start", (event) => {
            planRequestStarted =
              event.messageType === "custom" &&
              event.message.customType === "radian.task-plan-request";
            callsInRun = 0;
          });
          pi.on("input", (event) =>
            transformInput
              ? { action: "transform", text: `Additional context:\n${event.text}` }
              : undefined,
          );
          pi.registerTool({
            name: "radian-subagent",
            label: "Delegation probe",
            description: "Fixture delegation boundary",
            parameters: Type.Object({
              action: Type.String(),
              agent: Type.String(),
              task: Type.String(),
            }),
            execute: async () => {
              delegations++;
              return {
                content: [{ type: "text", text: "Delegation executed" }],
                details: undefined,
              };
            },
          });
        },
      ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: options.agentDir!,
      modelRuntime: options.modelRuntime!,
      model: options.model!,
      settingsManager,
      resourceLoader,
      sessionManager: file
        ? SessionManager.open(file, options.sessionDir, directory)
        : SessionManager.create(directory, options.sessionDir),
    });
    session.agent.streamFunction = (model, context) => {
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      requests.push(JSON.stringify(context.messages));
      const firstCall = callsInRun++ === 0;
      const tool =
        queuedTools.shift() ??
        (firstCall
          ? (nextTool ??
            (submit && planRequestStarted
              ? {
                  name: "radian-plan",
                  arguments: {
                    action: "submit",
                    plan,
                    review: {
                      summary: "Checked requirement coverage, roles and shared-file risks.",
                      warnings: ["Implementation has not started."],
                    },
                  },
                }
              : undefined))
          : undefined);
      if (tool) {
        nextTool = undefined;
        message.content = [{ type: "toolCall", id: crypto.randomUUID(), ...tool }];
        message.stopReason = "toolUse";
      } else {
        message.content = [{ type: "text", text: "Planning response finished." }];
      }
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      return stream;
    };
    await session.bindExtensions({ onError: (error) => errors.push(error.error) });
    sessions.push(session);
    return session;
  }

  return {
    directory,
    options,
    requests,
    errors,
    get delegations() {
      return delegations;
    },
    open,
    setPlan(value: TaskPlan) {
      plan = value;
    },
    setTool(value: NonNullable<typeof nextTool>) {
      nextTool = value;
    },
    queueTools(...values: NonNullable<typeof nextTool>[]) {
      queuedTools.push(...values);
    },
    withInputTransform() {
      transformInput = true;
    },
    withoutSubmission() {
      submit = false;
    },
    async run(session: AgentSession, text: string) {
      await session.prompt(text);
      await session.waitForIdle();
    },
    async close() {
      for (const session of sessions) {
        await session.abort();
        session.dispose();
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function transcript(session: AgentSession) {
  return JSON.stringify(session.sessionManager.getBranch());
}

function owner(session: AgentSession) {
  return {
    conversationId: session.sessionManager.getSessionId(),
    cwd: session.sessionManager.getCwd(),
  };
}

test("The planning command loads its skill, validates a graph and retains only one current sidecar", async () => {
  // Use a real SDK session with scripted provider responses, not a live model.
  const app = await fixture();
  try {
    const session = await app.open();
    // Planning has one entry point, with no management subcommand completion.
    const command = session.extensionRunner.getCommand("plan")!;
    expect(command.getArgumentCompletions).toBeUndefined();

    // Generate a plan, then replace it through the same planning workflow.
    await app.run(session, "/plan Add the feature without deployment");
    const file = session.sessionManager.getSessionFile()!;
    const first = expectOk(await readTaskPlan(file, owner(session)))!;
    app.setPlan(proposal("Deliver the revised feature"));
    await app.run(session, "/plan Revise the goal");
    const saved = expectOk(await readTaskPlan(file, owner(session)))!;

    // The submitted graph is authoritative and no revision files or task execution appear.
    expect(first.plan.goal).toBe("Deliver a reviewed feature");
    expect(saved.plan.goal).toBe("Deliver the revised feature");
    expect(saved.hash).not.toBe(first.hash);
    expect(
      (await readdir(app.options.sessionDir!)).filter((name) => name.endsWith(".plan.json")),
    ).toHaveLength(1);
    expect(app.requests[0]).toContain("Read repository instructions");
    expect(app.requests[0]).toContain("Add the feature without deployment");
    expect(transcript(session)).toContain("contract -> implement");
    expect(transcript(session)).toContain("Semantic review (agent assessment)");
    expect(transcript(session)).toContain("Approval: not implied");
    expect(await Bun.file(join(app.directory, "src/feature.ts")).exists()).toBe(false);
  } finally {
    await app.close();
  }
});

test("Invalid updates preserve the last valid plan and cannot claim a newly saved plan", async () => {
  // Preserve an accepted current plan before trying an invalid dependency graph.
  const app = await fixture();
  try {
    const session = await app.open();
    await app.run(session, "/plan Initial requirements");
    const file = session.sessionManager.getSessionFile()!;
    const before = await Bun.file(planFilePath(file)).text();
    const invalid = proposal();
    invalid.tasks[0]!.dependsOn = ["implement"];
    app.setPlan(invalid);

    // A structurally invalid submission is a failed tool call, not a replacement.
    await app.run(session, "/plan Try a cyclic update");

    // Keep the original bytes and explicitly report that nothing new was saved.
    expect(await Bun.file(planFilePath(file)).text()).toBe(before);
    expect(transcript(session)).toContain("Dependency cycle");
    expect(transcript(session)).toContain("No new structurally validated plan was saved");
  } finally {
    await app.close();
  }
});

test("Resume restores the current plan without model work and fresh conversations remain isolated", async () => {
  // The sidecar belongs to the SDK conversation, not a tab or worktree alone.
  const app = await fixture();
  try {
    const first = await app.open();
    await app.run(first, "/plan Create a feature plan");
    const file = first.sessionManager.getSessionFile()!;
    const hash = expectOk(await readTaskPlan(file, owner(first)))!.hash;
    first.dispose();
    const count = app.requests.length;
    const resumed = await app.open(file);
    const fresh = await app.open();

    // Internal restoration does not require a management command or model call.
    expect(expectOk(await readTaskPlan(file, owner(resumed)))?.hash).toBe(hash);
    expect(app.requests).toHaveLength(count);
    expect(
      expectOk(await readTaskPlan(fresh.sessionManager.getSessionFile()!, owner(fresh))),
    ).toBeNull();
    await app.run(resumed, "What remains in the plan?");

    // The next ordinary request receives the authoritative pointer even after session recreation.
    expect(app.requests.at(-1)).toContain(hash);
    expect(app.requests.at(-1)).toContain("conversation-wide current plan");
    expect(app.requests.at(-1)).toContain("compare its applicable acceptance criteria");
    expect(app.requests.at(-1)).toContain("Do not apply this plan to unrelated requests");
  } finally {
    await app.close();
  }
});

test.each(["edit", "write", "radian-subagent"])(
  "Planning blocks %s but restores ordinary tool ownership afterward",
  async (name) => {
    // /plan is a planning-only workflow even if a provider proposes implementation tools.
    const app = await fixture();
    try {
      const session = await app.open();
      app.setTool({
        name,
        arguments:
          name === "write"
            ? { path: "unplanned.txt", content: "unexpected" }
            : name === "edit"
              ? { path: "unplanned.txt", edits: [{ oldText: "before", newText: "after" }] }
              : { action: "spawn", agent: "probe", task: "Execute" },
      });

      // Attempt task execution from within the planning turn.
      await app.run(session, "/plan Investigate only");

      // No product write or delegation is accepted; a later ordinary request may write normally.
      expect(await Bun.file(join(app.directory, "unplanned.txt")).exists()).toBe(false);
      expect(transcript(session)).toContain("does not edit product files");
      expect(app.delegations).toBe(0);
      app.setTool({
        name: "write",
        arguments: { path: "accepted.txt", content: "explicit later work" },
      });
      await app.run(session, "Now perform the explicitly requested write");
      expect(await Bun.file(join(app.directory, "accepted.txt")).text()).toBe(
        "explicit later work",
      );
    } finally {
      await app.close();
    }
  },
);

test("Input transformations cannot disable planning guards or reject a later valid submission", async () => {
  const app = await fixture();
  try {
    app.withInputTransform();
    const session = await app.open();
    app.queueTools(
      { name: "write", arguments: { path: "unplanned.txt", content: "unexpected" } },
      { name: "radian-subagent", arguments: { action: "spawn", agent: "probe", task: "Execute" } },
      { name: "radian-subagent", arguments: { action: "list", agent: "probe", task: "List" } },
      {
        name: "radian-plan",
        arguments: {
          action: "submit",
          plan: proposal("Submitted after investigation"),
          review: { summary: "Checked coverage", warnings: [] },
        },
      },
    );

    await app.run(session, "/plan Investigate only");

    const file = session.sessionManager.getSessionFile()!;
    expect(await Bun.file(join(app.directory, "unplanned.txt")).exists()).toBe(false);
    expect(app.delegations).toBe(1);
    expect(transcript(session)).toContain("does not edit product files");
    expect(expectOk(await readTaskPlan(file, owner(session)))?.plan.goal).toBe(
      "Submitted after investigation",
    );
    await app.run(session, "Ordinary input after planning");
    expect(app.requests.at(-1)).toContain("Additional context:");
  } finally {
    await app.close();
  }
});

test("Old planning markers in ordinary user text do not authorize plan submission", async () => {
  const app = await fixture();
  try {
    const session = await app.open();
    app.setTool({
      name: "radian-plan",
      arguments: {
        action: "submit",
        plan: proposal(),
        review: { summary: "Not authorized", warnings: [] },
      },
    });
    await app.run(session, "<radian-graph-plan> This is ordinary user text");

    expect(transcript(session)).toContain("Start /plan before submitting");
    expect(
      expectOk(await readTaskPlan(session.sessionManager.getSessionFile()!, owner(session))),
    ).toBeNull();
  } finally {
    await app.close();
  }
});

test("A retried planning run keeps the guard through tool turns and allows valid submission", async () => {
  const app = await fixture();
  try {
    const session = await app.open();
    session.settingsManager.applyOverrides({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
    });
    const originalStream = session.agent.streamFunction;
    let requests = 0;
    session.agent.streamFunction = (model, context, request) => {
      if (++requests !== 1) return originalStream(model, context, request);
      const stream = createAssistantMessageEventStream();
      const failure = fixtureMessage(model.api, model.provider, model.id);
      failure.stopReason = "error";
      failure.errorMessage = "429 Too Many Requests";
      stream.push({ type: "error", reason: "error", error: failure });
      stream.end();
      return stream;
    };
    app.queueTools(
      { name: "write", arguments: { path: "retry-write.txt", content: "unexpected" } },
      {
        name: "radian-plan",
        arguments: {
          action: "submit",
          plan: proposal("Recovered plan"),
          review: { summary: "Checked recovery", warnings: [] },
        },
      },
    );
    await app.run(session, "/plan Recover from provider error");

    expect(requests).toBeGreaterThanOrEqual(3);
    expect(await Bun.file(join(app.directory, "retry-write.txt")).exists()).toBe(false);
    expect(transcript(session)).toContain("does not edit product files");
    expect(
      expectOk(await readTaskPlan(session.sessionManager.getSessionFile()!, owner(session)))?.plan
        .goal,
    ).toBe("Recovered plan");
  } finally {
    await app.close();
  }
});

test("Cancelling a planning run restores ordinary tool access", async () => {
  const app = await fixture();
  try {
    const session = await app.open();
    const originalStream = session.agent.streamFunction;
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    session.agent.streamFunction = (model, _context, request) => {
      const stream = createAssistantMessageEventStream();
      const message = fixtureMessage(model.api, model.provider, model.id);
      request?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      stream.push({ type: "start", partial: message });
      started.resolve();
      void release.promise.then(() => {
        message.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end();
      });
      return stream;
    };
    await session.prompt("/plan Hold until cancelled");
    await started.promise;
    const cancellation = session.abort();
    try {
      await aborted.promise;
    } finally {
      release.resolve();
    }
    await cancellation;
    await session.waitForIdle();
    session.agent.streamFunction = originalStream;
    app.setTool({
      name: "write",
      arguments: { path: "after-cancellation.txt", content: "ordinary work" },
    });
    await app.run(session, "Now write after cancellation");

    expect(await Bun.file(join(app.directory, "after-cancellation.txt")).text()).toBe(
      "ordinary work",
    );
  } finally {
    await app.close();
  }
});

test("A failed planning run restores ordinary tool access", async () => {
  const app = await fixture();
  try {
    const session = await app.open();
    const originalStream = session.agent.streamFunction;
    session.agent.streamFunction = (model) => {
      const stream = createAssistantMessageEventStream();
      const failure = fixtureMessage(model.api, model.provider, model.id);
      failure.stopReason = "error";
      failure.errorMessage = "Fixture provider failure";
      stream.push({ type: "error", reason: "error", error: failure });
      stream.end();
      return stream;
    };
    await app.run(session, "/plan Fail the provider");
    session.agent.streamFunction = originalStream;
    app.setTool({
      name: "write",
      arguments: { path: "after-failure.txt", content: "ordinary work" },
    });
    await app.run(session, "Now write after failure");

    expect(transcript(session)).toContain("Fixture provider failure");
    expect(await Bun.file(join(app.directory, "after-failure.txt")).text()).toBe("ordinary work");
  } finally {
    await app.close();
  }
});

test("A busy session rejects planning without changing its artifact or starting model work", async () => {
  const app = await fixture();
  try {
    const session = await app.open();
    await app.run(session, "/plan Initial plan");
    const file = session.sessionManager.getSessionFile()!;
    const before = await Bun.file(planFilePath(file)).text();
    const requests = app.requests.length;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    session.agent.streamFunction = (model) => {
      const stream = createAssistantMessageEventStream();
      started.resolve();
      void release.promise.then(() => {
        const message = fixtureMessage(model.api, model.provider, model.id);
        message.content = [{ type: "text", text: "Held run finished" }];
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    };
    const active = session.prompt("Hold this run");
    await started.promise;
    try {
      // A second planning request must not race the active ordinary run.
      await session.prompt("/plan Revised requirements");
      expect(app.errors.filter((error) => error.includes("Wait for the current run"))).toHaveLength(
        1,
      );
      expect(await Bun.file(planFilePath(file)).text()).toBe(before);
      expect(app.requests).toHaveLength(requests);
    } finally {
      release.resolve();
      await active;
      await session.waitForIdle();
    }
  } finally {
    await app.close();
  }
});

test("Compaction retains the current plan pointer for a subsequent ordinary request", async () => {
  const app = await fixture();
  try {
    const session = await app.open();
    await app.run(session, "/plan Initial plan");
    const file = session.sessionManager.getSessionFile()!;
    const saved = expectOk(await readTaskPlan(file, owner(session)))!;
    await app.run(session, "Discuss the implementation risks");
    session.settingsManager.applyOverrides({
      compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 },
    });
    await session.compact("Keep the plan constraints");
    await app.run(session, "Which task comes first?");
    expect(app.requests.at(-1)).toContain("conversation-wide current plan");
    expect(app.requests.at(-1)).toContain(saved.hash);
    expect(expectOk(await readTaskPlan(file, owner(session)))?.hash).toBe(saved.hash);
  } finally {
    await app.close();
  }
});

test.each(["show", "check", "clear", "export shared-plan.json"])(
  "Every /plan argument is a planning requirement, not a management operation: %s",
  async (requirements) => {
    // An existing plan is replaced only by a valid submission, never by an argument keyword.
    const app = await fixture();
    try {
      const session = await app.open();
      await app.run(session, "/plan Initial requirements");
      const file = planFilePath(session.sessionManager.getSessionFile()!);
      const before = await Bun.file(file).text();
      const count = app.requests.length;
      app.withoutSubmission();

      // Former management words now enter the same planning workflow as any other requirement.
      await app.run(session, `/plan ${requirements}`);

      // Without a new submission there is no removal, export, or silent state change.
      expect(app.requests).toHaveLength(count + 1);
      expect(app.requests.at(-1)).toContain(requirements);
      expect(await Bun.file(file).text()).toBe(before);
      expect(await Bun.file(join(app.directory, "shared-plan.json")).exists()).toBe(false);
      expect(app.errors).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("The hosted parent exposes /plan while owned child agents do not become planners", async () => {
  // Main-only registration preserves the existing non-orchestrating child contract.
  const app = await fixture();
  const executors = [];
  try {
    const factory = piSessionFactory(app.options);
    const base = {
      cwd: app.directory,
      spawnSubagent: async () => {
        throw new Error("Unexpected delegation");
      },
    };
    const parent = await factory({ ...base, role: "main" });
    executors.push(parent);
    const child = await factory({ ...base, role: "subagent" });
    executors.push(child);

    // Read command catalogs without model execution or package discovery.
    const parentCommands = parent.commands!();
    const childCommands = child.commands!();

    // Planning is advertised to parents only and offers explicit lifecycle controls.
    expect(parentCommands.some((command) => command.value === "plan")).toBe(true);
    expect(childCommands.some((command) => command.value === "plan")).toBe(false);
  } finally {
    for (const executor of executors) expectOk(await executor.close());
    await app.close();
  }
});
