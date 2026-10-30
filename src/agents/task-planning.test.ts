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
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureMessage, offlineRuntime } from "../testing/offline-runtime.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { checkPlanFile } from "./check-plan.ts";
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
  let submit = true;

  async function open(file?: string) {
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
      const userIndex = context.messages.findLastIndex(
        (entry) =>
          entry.role === "user" &&
          !(
            typeof entry.content === "string"
              ? entry.content
              : entry.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("")
          ).startsWith("The conversation-wide current plan"),
      );
      const user = context.messages[userIndex];
      const text =
        user?.role === "user"
          ? typeof user.content === "string"
            ? user.content
            : user.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("")
          : "";
      requests.push(JSON.stringify(context.messages));
      const hasResult = context.messages
        .slice(userIndex + 1)
        .some((entry) => entry.role === "toolResult");
      const tool = !hasResult
        ? (nextTool ??
          (submit && text.startsWith("<radian-graph-plan>")
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
        : undefined;
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
    const candidates =
      await session.extensionRunner.getCommand("plan")!.getArgumentCompletions!("ch");
    expect(candidates?.some((candidate) => candidate.value === "check")).toBe(true);

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

    // Inspect persisted data directly; these controls must not invoke the provider.
    await app.run(resumed, "/plan show");
    await app.run(resumed, "/plan check");
    expect(app.requests).toHaveLength(count);
    expect(
      expectOk(await readTaskPlan(fresh.sessionManager.getSessionFile()!, owner(fresh))),
    ).toBeNull();
    await app.run(resumed, "What remains in the plan?");

    // The next ordinary request receives the authoritative pointer even after session recreation.
    expect(app.requests.at(-1)).toContain(hash);
    expect(app.requests.at(-1)).toContain("conversation-wide current plan");
  } finally {
    await app.close();
  }
});

test.each(["write", "radian-subagent"])(
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

test("Exported plans survive clearing and exports never overwrite existing files", async () => {
  // Retention owns the sidecar, but explicitly exported artifacts have an independent lifetime.
  const app = await fixture();
  try {
    const session = await app.open();
    await app.run(session, "/plan Feature requirements");
    const count = app.requests.length;

    // Export, validate the exported envelope, then clear only the current plan.
    await app.run(session, "/plan export shared-plan.json");
    const exported = join(app.directory, "shared-plan.json");
    expect(expectOk(await checkPlanFile(exported)).goal).toBe("Deliver a reviewed feature");
    const original = await Bun.file(exported).text();
    await app.run(session, "/plan export shared-plan.json");
    await app.run(session, "/plan clear");

    // Command errors remain visible, exported bytes remain untouched, and controls make no model calls.
    expect(await Bun.file(exported).text()).toBe(original);
    expect(app.errors.some((error) => error.includes("EEXIST"))).toBe(true);
    expect(await Bun.file(planFilePath(session.sessionManager.getSessionFile()!)).exists()).toBe(
      false,
    );
    expect(app.requests).toHaveLength(count);
  } finally {
    await app.close();
  }
});

test("Standalone structural validation accepts raw JSON and rejects invalid references without executing criteria", async () => {
  // Acceptance criteria describe future checks; they are never shell commands to run during validation.
  const app = await fixture();
  try {
    const plan = proposal();
    plan.tasks[0]!.acceptanceCriteria = ["touch must-not-execute.txt"];
    const path = join(app.directory, "raw-plan.json");
    await writeFile(path, JSON.stringify(plan));

    // Check a valid plan and then the same file with a missing prerequisite.
    expectOk(await checkPlanFile(path));
    plan.tasks[1]!.dependsOn = ["absent"];
    await writeFile(path, JSON.stringify(plan));
    const error = expectError(await checkPlanFile(path));

    // Return a domain diagnostic without running any acceptance text.
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("absent");
    expect(await Bun.file(join(app.directory, "must-not-execute.txt")).exists()).toBe(false);
  } finally {
    await app.close();
  }
});

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
