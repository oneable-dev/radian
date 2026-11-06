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
import { expectOk } from "../testing/results.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { planFilePath, readTaskPlan } from "./task-plan-store.ts";
import { migrateWorkflowToV2, mutateWorkflow, workflowFilePath } from "./task-workflow-store.ts";
import { createWorkflowDocument, type WorkflowDocument } from "./task-workflow.ts";
import { declareScope, declareSubtasks, publishPlanArtifact } from "./verification-policy.ts";
import type { TaskPlan } from "./task-plan.ts";
import {
  legacyPlanningInstructions,
  taskPlanningExtension,
  type PlanningHost,
} from "./task-planning.ts";
import { ok, err } from "../result.ts";
import { CancelledError } from "../errors.ts";
import type { PlanningSchedulerControl } from "./workflow-scheduler-driver.ts";

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

async function fixture(host?: PlanningHost) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-task-planning-")));
  const options = await offlineRuntime(join(directory, "agent"));
  await mkdir(options.sessionDir!, { recursive: true });
  const sessions: AgentSession[] = [];
  const requests: string[] = [];
  const errors: string[] = [];
  const notifications: { message: string; type: string | undefined }[] = [];
  const workflowContexts: { content: unknown; display: boolean }[] = [];
  let delegations = 0;
  let plan = proposal();
  let nextTool: Pick<ToolCall, "name" | "arguments"> | undefined;
  const queuedTools: Pick<ToolCall, "name" | "arguments">[] = [];
  let submit = true;
  let transformInput = false;
  let beforePlanRequest: (() => Promise<void>) | undefined;

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
        taskPlanningExtension(undefined, host),
        (pi) => {
          pi.on("before_agent_start", async (event) => {
            planRequestStarted =
              event.messageType === "custom" &&
              event.message.customType === "radian.task-plan-request";
            callsInRun = 0;
            if (planRequestStarted) await beforePlanRequest?.();
          });
          pi.on("context", (event) => {
            for (const message of event.messages) {
              if (message.role === "custom" && message.customType === "radian.task-plan-context")
                workflowContexts.push({
                  content: message.content,
                  display: message.display,
                });
            }
          });
          pi.on("input", (event) =>
            transformInput
              ? {
                  action: "transform",
                  text: `Additional context:\n${event.text}`,
                }
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
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end();
      return stream;
    };
    await session.bindExtensions({
      onError: (error) => errors.push(error.error),
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: (message, type) => notifications.push({ message, type }),
      },
    });
    sessions.push(session);
    return session;
  }

  return {
    directory,
    options,
    requests,
    errors,
    notifications,
    workflowContexts,
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
    beforePlanRequest(callback: () => Promise<void>) {
      beforePlanRequest = callback;
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

async function persistWorkflow(session: AgentSession, doc: WorkflowDocument) {
  expectOk(
    await mutateWorkflow(
      { originSessionFile: session.sessionManager.getSessionFile()! },
      owner(session),
      () => ok({ doc, effects: [], outcome: { kind: "applied" } }),
    ),
  );
}

function scope(doc: WorkflowDocument, at: number, ids: string[], goal = "Reviewed scope") {
  return expectOk(
    declareScope(doc, {
      eventKey: `scope-${at}-${doc.revision}`,
      at,
      goal,
      knownProfiles: ["lead"],
      branches: ids.map((id) => ({
        id,
        title: id,
        lead: { profile: "lead" },
        scope: "src",
        dependsOn: [],
      })),
    }),
  ).doc;
}

function publish(
  doc: WorkflowDocument,
  id: string,
  at: number,
  plan = proposal(),
  warnings: string[] = [],
  reviewedDependencies?: { artifactId: string; revision: number }[],
) {
  return expectOk(
    publishPlanArtifact(doc, {
      eventKey: `publish-${id}-${at}-${doc.revision}`,
      at,
      binding: {
        workflowId: doc.workflowId,
        taskId: id,
        role: "lead",
        assignmentVersion: 0,
      },
      artifactId: `${id}-plan`,
      plan,
      review: { summary: "Reviewed", warnings },
      author: { runId: `${id}-run`, profile: "lead", role: "lead" },
      ...(reviewedDependencies === undefined ? {} : { reviewedDependencies }),
    }),
  ).doc;
}

function latestToolReport(session: AgentSession): string {
  const entry = session.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "message" && entry.message.role === "toolResult");
  if (!entry || entry.type !== "message") throw new Error("Missing tool result");
  return JSON.stringify(entry.message);
}

function settledReport(session: AgentSession): string {
  const entry = session.sessionManager
    .getBranch()
    .findLast(
      (entry) => entry.type === "custom_message" && entry.customType === "radian.task-plan",
    );
  if (!entry || entry.type !== "custom_message") throw new Error("Missing settled planning report");
  return typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
}

test("Q02 same-millisecond requests require a new declaration and stable IDs retain publication history", async () => {
  // Request identity must not depend on wall-clock resolution.
  const app = await fixture();
  const now = Date.now;
  try {
    const session = await app.open();
    app.withoutSubmission();
    await app.run(session, "Initialize");
    const at = now();
    Date.now = () => at;
    let doc = createWorkflowDocument(
      { ...owner(session), sessionFile: session.sessionManager.getSessionFile()! },
      crypto.randomUUID(),
      at,
    );
    app.beforePlanRequest(async () => {
      doc = publish(scope(doc, at, ["branch"]), "branch", at);
      await persistWorkflow(session, doc);
    });
    await app.run(session, "/plan First scope");
    expect(settledReport(session)).toContain("Planning: ready for review");

    // A second request at exactly the same time cannot reuse the first scope.
    app.beforePlanRequest(async () => {});
    await app.run(session, "/plan New requirements");
    expect(settledReport(session)).toContain(
      "Scope was not declared for the current /plan request",
    );
    expect(settledReport(session)).toContain("Planning: incomplete");

    // Re-declaring the stable ID refreshes scope without erasing its earlier revision.
    app.beforePlanRequest(async () => {
      doc = scope(doc, at, ["branch"]);
      await persistWorkflow(session, doc);
      doc = publish(doc, "branch", at);
      await persistWorkflow(session, doc);
    });
    await app.run(session, "/plan Replan the same branch");
    expect(settledReport(session)).toContain("Planning: ready for review");
    expect(doc.artifacts["branch-plan"]!.revisions.map((item) => item.revision)).toEqual([1, 2]);
  } finally {
    Date.now = now;
    await app.close();
  }
});

test("Q02 dependency coverage requires current host receipts rather than plan input text", async () => {
  // Both branch plans are fresh, but only structured host receipts establish coverage.
  const app = await fixture();
  try {
    const session = await app.open();
    app.withoutSubmission();
    await app.run(session, "Initialize");
    let doc = createWorkflowDocument(
      { ...owner(session), sessionFile: session.sessionManager.getSessionFile()! },
      crypto.randomUUID(),
      0,
    );
    app.beforePlanRequest(async () => {
      doc = scope(doc, 1, ["feature", "qa"]);
      doc.tasks.qa!.dependsOn = ["feature"];
      doc = publish(doc, "feature", 1);
      const plan = proposal();
      plan.tasks[0]!.inputs = ["feature-plan@1"];
      doc = publish(doc, "qa", 1, plan);
      await persistWorkflow(session, doc);
    });
    await app.run(session, "/plan Review dependencies");
    expect(settledReport(session)).toContain(
      "Dependency coverage missing: qa has no host-captured review of feature-plan@1.",
    );
    expect(settledReport(session)).toContain("Planning: incomplete");

    // Republishing upstream invalidates a real receipt, even within the same declaration.
    doc = publish(doc, "qa", 2, proposal(), [], [{ artifactId: "feature-plan", revision: 1 }]);
    await persistWorkflow(session, doc);
    doc = publish(doc, "feature", 2);
    await persistWorkflow(session, doc);
    app.setTool({ name: "radian-plan", arguments: { action: "report" } });
    await app.run(session, "Check coverage");
    expect(latestToolReport(session)).toContain(
      "Dependency coverage obsolete: qa reviewed feature-plan@1; current feature-plan@2.",
    );
    expect(latestToolReport(session)).toContain("Planning: incomplete");

    // A new receipt of the current upstream revision restores readiness.
    doc = publish(doc, "qa", 3, proposal(), [], [{ artifactId: "feature-plan", revision: 2 }]);
    await persistWorkflow(session, doc);
    app.setTool({ name: "radian-plan", arguments: { action: "report" } });
    await app.run(session, "Check refreshed coverage");
    expect(latestToolReport(session)).toContain("Planning: ready for review");
  } finally {
    await app.close();
  }
});

test("Q02 restart restores invocation correlation and cancellation while legacy metadata stays incomplete", async () => {
  // Durable request entries, not extension memory, determine readiness after reopening.
  const app = await fixture();
  try {
    const session = await app.open();
    app.withoutSubmission();
    await app.run(session, "Initialize");
    let doc = createWorkflowDocument(
      { ...owner(session), sessionFile: session.sessionManager.getSessionFile()! },
      crypto.randomUUID(),
      0,
    );
    app.beforePlanRequest(async () => {
      doc = publish(scope(doc, 1, ["branch"]), "branch", 1);
      await persistWorkflow(session, doc);
    });
    await app.run(session, "/plan Current scope");
    app.beforePlanRequest(async () => {});
    await app.run(session, "/plan Not yet declared");
    const reopened = await app.open(session.sessionManager.getSessionFile()!);
    app.setTool({ name: "radian-plan", arguments: { action: "report" } });
    await app.run(reopened, "Report after restart");
    expect(latestToolReport(reopened)).toContain(
      "Scope was not declared for the current /plan request",
    );
    expect(latestToolReport(reopened)).toContain("Planning: incomplete");

    // Cancellation is persisted and cannot present retained artifacts as ready.
    app.setTool({ name: "radian-plan", arguments: { action: "cancel" } });
    await app.run(reopened, "/plan Cancel this request");
    expect(settledReport(reopened)).toContain(
      "Reason: Planning request was cancelled; artifacts were retained.",
    );
    const cancelled = await app.open(reopened.sessionManager.getSessionFile()!);
    app.setTool({ name: "radian-plan", arguments: { action: "report" } });
    await app.run(cancelled, "Report retained artifacts");
    expect(latestToolReport(cancelled)).toContain(
      "Reason: Planning request was cancelled; artifacts were retained.",
    );
    expect(latestToolReport(cancelled)).toContain("Planning: incomplete");

    // Legacy documents validate, but lack the metadata needed to establish current readiness.
    delete doc.manifest!.declaredRevision;
    delete doc.manifest!.branches;
    delete doc.tasks.branch!.declaredRevision;
    delete doc.artifacts["branch-plan"]!.revisions[0]!.docRevision;
    doc.revision++;
    await persistWorkflow(cancelled, doc);
    app.setTool({ name: "radian-plan", arguments: { action: "report" } });
    await app.run(cancelled, "Report legacy workflow");
    expect(latestToolReport(cancelled)).toContain(
      "Scope predates request correlation; declare it again.",
    );
    expect(latestToolReport(cancelled)).toContain("Planning: incomplete");
    expect(doc.artifacts["branch-plan"]!.revisions).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("Q02 a legacy request or invocation without a baseline cannot inherit readiness", async () => {
  // A restored fresh workflow alone cannot prove which request declared it.
  const app = await fixture();
  try {
    const session = await app.open();
    app.withoutSubmission();
    await app.run(session, "Initialize");
    const doc = publish(
      scope(
        createWorkflowDocument(
          { ...owner(session), sessionFile: session.sessionManager.getSessionFile()! },
          crypto.randomUUID(),
          0,
        ),
        1,
        ["branch"],
      ),
      "branch",
      1,
    );
    await persistWorkflow(session, doc);
    session.sessionManager.appendCustomEntry("radian.task-plan-invocation", {
      requestId: "unavailable-baseline",
      state: "active",
    });
    app.setTool({ name: "radian-plan", arguments: { action: "report" } });
    await app.run(session, "Report unknown baseline");
    expect(latestToolReport(session)).toContain(
      "Scope was not declared for the current /plan request",
    );
    expect(latestToolReport(session)).toContain("Planning: incomplete");

    // Even an earlier correlated invocation must not authorize a later legacy request message.
    session.sessionManager.appendCustomEntry("radian.task-plan-invocation", {
      requestId: "prior",
      baselineRevision: 0,
      state: "active",
    });
    session.sessionManager.appendCustomMessageEntry(
      "radian.task-plan-request",
      "Legacy requirements",
      false,
    );
    app.setTool({ name: "radian-plan", arguments: { action: "report" } });
    await app.run(session, "Report legacy request");
    expect(latestToolReport(session)).toContain(
      "Scope was not declared for the current /plan request",
    );
    expect(latestToolReport(session)).toContain("Planning: incomplete");
  } finally {
    await app.close();
  }
});

test("Q02 stale scope and required plan questions keep readiness incomplete", async () => {
  // A durable publication from an earlier request must not satisfy unrelated new requirements.
  const app = await fixture();
  try {
    const session = await app.open();
    app.withoutSubmission();
    await app.run(session, "Initialize the file-backed conversation");
    let doc = scope(
      createWorkflowDocument(
        {
          ...owner(session),
          sessionFile: session.sessionManager.getSessionFile()!,
        },
        crypto.randomUUID(),
        0,
      ),
      1,
      ["branch"],
      "Old security scope",
    );
    const plan = proposal("Old goal");
    plan.openQuestions = ["REQUIRED: user has not selected security policy"];
    doc = publish(doc, "branch", 2, plan, ["Security QA has not run"]);
    await persistWorkflow(session, doc);

    // Tool reporting, settlement and hidden context all derive the same freshness decision.
    app.setTool({ name: "radian-plan", arguments: { action: "report" } });
    await app.run(session, "/plan Brand new unrelated requirements");
    const text = settledReport(session);

    expect(text).toContain("Planning: incomplete");
    expect(text).toContain("Scope was not declared for the current /plan request");
    expect(text).toContain("Previous scope: Old security scope");
    expect(text).toContain(
      "Open question (branch): REQUIRED: user has not selected security policy",
    );
    expect(text).toContain("Warning (branch): Security QA has not run");
    expect(text).toContain("questions: 1");
    expect(text).toContain("branch-plan@1");
    expect(text).toContain("Approval: not implied");
    const contexts = app.workflowContexts.map((message) => String(message.content));
    expect(
      contexts.some(
        (content) =>
          content.includes("Previous scope: Old security scope") &&
          content.includes("Scope was not declared for the current /plan request"),
      ),
    ).toBe(true);
    expect(transcript(session)).not.toContain("Planning: ready for review");
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Q02 fresh declarations exclude historical branches and diagnostics but retain artifacts", async () => {
  // History remains retrievable without becoming required for unrelated current scope.
  const app = await fixture();
  try {
    const session = await app.open();
    app.withoutSubmission();
    await app.run(session, "Initialize");
    let doc = scope(
      createWorkflowDocument(
        {
          ...owner(session),
          sessionFile: session.sessionManager.getSessionFile()!,
        },
        crypto.randomUUID(),
        0,
      ),
      1,
      ["old-branch"],
    );
    doc = expectOk(
      declareSubtasks(doc, {
        eventKey: "old-diagnostics",
        at: 2,
        parentTaskId: "old-branch",
        knownProfiles: ["lead"],
        subtasks: [
          {
            id: "child",
            title: "Child",
            kind: "implement",
            scope: "src",
            dependsOn: ["missing"],
          },
        ],
      }),
    ).doc;
    doc = publish(doc, "old-branch", 3);
    await persistWorkflow(session, doc);
    app.beforePlanRequest(async () => {
      doc = scope(doc, Date.now(), ["new-branch"], "Current scope");
      await persistWorkflow(session, doc);
      const declaredAt = doc.manifest!.declaredAt;
      doc = expectOk(
        declareSubtasks(doc, {
          eventKey: "fresh-subtasks",
          at: Date.now() + 1,
          parentTaskId: "new-branch",
          knownProfiles: ["lead"],
          subtasks: [],
        }),
      ).doc;
      expect(doc.manifest!.declaredAt).toBe(declaredAt);
      await persistWorkflow(session, doc);
      doc = publish(doc, "new-branch", Date.now() + 2);
      await persistWorkflow(session, doc);
    });

    await app.run(session, "/plan Declare current scope without replacing history");
    const text = settledReport(session);

    expect(text).toContain("Planning: ready for review");
    expect(text).toContain("Goal: Current scope");
    expect(text).not.toContain("Scope was not declared for the current /plan request");
    expect(text).not.toContain("old-branch");
    expect(text).toContain("Branches: 1; missing: 0; diagnostics: 0");
    expect(text).not.toContain("Missing dependency: child -> missing");
    expect(text).not.toContain("Diagnostic: shared file");
    expect(doc.artifacts["old-branch-plan"]!.revisions[0]!.body).toEqual({
      plan: proposal(),
      review: { summary: "Reviewed", warnings: [] },
    });
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Q02 fresh reviewed artifacts show non-blocking shared files and warnings without implying approval", async () => {
  // Warnings and file overlap inform review without pretending to be execution authorization.
  const app = await fixture();
  try {
    const session = await app.open();
    app.withoutSubmission();
    await app.run(session, "Initialize");
    app.beforePlanRequest(async () => {
      const at = Date.now();
      let doc = scope(
        createWorkflowDocument(
          {
            ...owner(session),
            sessionFile: session.sessionManager.getSessionFile()!,
          },
          crypto.randomUUID(),
          0,
        ),
        at,
        ["branch-a", "branch-b"],
      );
      doc = publish(doc, "branch-a", at, proposal(), ["Review shared edits"]);
      doc = publish(doc, "branch-b", at);
      await persistWorkflow(session, doc);
    });

    await app.run(session, "/plan Fresh reviewed scope");
    const text = settledReport(session);

    expect(text).toContain("Planning: ready for review");
    expect(text).toContain("Warning (branch-a): Review shared edits");
    expect(text).toContain("Diagnostic: shared file src/feature.ts in branch-a, branch-b");
    expect(text).toContain("missing: 0; diagnostics: 0; questions: 0");
    expect(text).toContain("Approval: not implied. Task execution: not started by /plan.");
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Q02 bounded readiness prioritizes required questions before non-blocking warnings", async () => {
  // Many review warnings cannot push a required question out of the bounded report.
  const app = await fixture();
  try {
    const session = await app.open();
    app.withoutSubmission();
    await app.run(session, "Initialize");
    app.beforePlanRequest(async () => {
      const at = Date.now();
      let doc = scope(
        createWorkflowDocument(
          {
            ...owner(session),
            sessionFile: session.sessionManager.getSessionFile()!,
          },
          crypto.randomUUID(),
          0,
        ),
        at,
        ["branch"],
      );
      const plan = proposal();
      plan.openQuestions = ["REQUIRED decision before review"];
      doc = publish(
        doc,
        "branch",
        at,
        plan,
        Array.from({ length: 64 }, (_, index) => `${index}: ${"warning ".repeat(120)}`),
      );
      await persistWorkflow(session, doc);
    });

    await app.run(session, "/plan Keep required questions visible");
    const text = settledReport(session);

    expect(text.length).toBeLessThanOrEqual(12000);
    expect(text).toContain("Planning: incomplete");
    expect(text).toContain("Open question (branch): REQUIRED decision before review");
    expect(text.indexOf("Open question")).toBeLessThan(text.indexOf("Warning (branch)"));
    expect(text).toContain("[Truncated;");
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Q02 default /plan rejects parent submission and settles with an incomplete host report", async () => {
  // A legacy submit-shaped provider response must not silently select single-planner mode.
  const app = await fixture();
  const session = await app.open();
  try {
    await app.run(session, "/plan Investigate the hierarchical scope");

    // No parent sidecar or success is manufactured without lead-owned publications.
    expect(
      expectOk(await readTaskPlan(session.sessionManager.getSessionFile()!, owner(session))),
    ).toBeNull();
    expect(transcript(session)).toContain("Hierarchical /plan uses radian-task declare");
    expect(transcript(session)).toContain("Planning: incomplete");
    expect(transcript(session)).toContain("No plan branches declared");
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([
  { state: "corrupt", payload: "{invalid", mode: 0o600 },
  { state: "non-private", payload: "{}", mode: 0o644 },
])(
  "A $state workflow preserves ordinary turns with a warning and hidden uncertainty context",
  async ({ payload, mode }) => {
    // A present but unusable sidecar must never look like an empty, unlocked workflow.
    const app = await fixture();
    try {
      const session = await app.open();
      await writeFile(workflowFilePath(session.sessionManager.getSessionFile()!), payload, {
        mode,
      });

      // Ordinary conversation remains available even when durable workflow state cannot be read.
      await app.run(session, "Explain what can safely be established");

      // The provider sees bounded uncertainty, while the user receives a warning rather than a failed turn.
      const note =
        "Workflow state unavailable [STORAGE_FAILED]; task status, repair admission and plan readiness cannot be trusted; do not assume an empty or unlocked workflow.";
      expect(app.requests).toHaveLength(1);
      expect(app.requests[0]).toContain(note);
      expect(app.workflowContexts).toContainEqual({
        content: note,
        display: false,
      });
      expect(note.length).toBeLessThanOrEqual(512);
      expect(app.notifications).toEqual([
        {
          message: expect.stringMatching(/^\[STORAGE_FAILED\] .+/),
          type: "warning",
        },
      ]);
      expect(transcript(session)).toContain("Planning response finished.");
      expect(transcript(session)).not.toContain(note);
      expect(app.errors).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("A corrupt workflow produces unavailable incomplete tool and settlement reports", async () => {
  // Both reporting boundaries must distinguish unreadable state from absent plan branches.
  const app = await fixture();
  try {
    const session = await app.open();
    await writeFile(workflowFilePath(session.sessionManager.getSessionFile()!), "{invalid", {
      mode: 0o600,
    });
    app.setTool({ name: "radian-plan", arguments: { action: "report" } });

    // Reporting during hierarchical planning reaches both the tool and final settlement boundary.
    await app.run(session, "/plan Report durable readiness");

    // Neither report can imply readiness or synthesize an empty workflow after a storage failure.
    const messages = session.sessionManager
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    const tool = messages.find((message) => message.role === "toolResult");
    const settled = session.sessionManager
      .getBranch()
      .find((entry) => entry.type === "custom_message" && entry.customType === "radian.task-plan");
    for (const message of [tool, settled]) {
      expect(JSON.stringify(message)).toContain("Planning: incomplete");
      expect(JSON.stringify(message)).toContain("Workflow state unavailable [STORAGE_FAILED]");
      expect(JSON.stringify(message)).not.toContain("No plan branches declared");
      expect(JSON.stringify(message)).not.toContain("ready for review");
    }
    expect(tool?.role === "toolResult" && tool.isError).toBe(false);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("A corrupt workflow blocks hierarchical spawning without a handler exception", async () => {
  // Workflow uncertainty cannot grant permission to spawn a branch lead.
  const app = await fixture();
  try {
    const session = await app.open();
    await writeFile(workflowFilePath(session.sessionManager.getSessionFile()!), "{invalid", {
      mode: 0o600,
    });
    app.setTool({
      name: "radian-subagent",
      arguments: {
        action: "spawn",
        agent: "probe",
        task: "Plan a branch",
        binding: { id: "branch", role: "lead" },
      },
    });

    // A provider-proposed spawn is rejected before reaching the delegation boundary.
    await app.run(session, "/plan Investigate only");

    // The model receives an explicit fail-closed reason and the run still settles normally.
    expect(app.delegations).toBe(0);
    expect(transcript(session)).toContain("Workflow state unavailable [STORAGE_FAILED]");
    expect(transcript(session)).toContain("do not assume an empty or unlocked workflow");
    expect(transcript(session)).toContain("Planning response finished.");
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Legacy --single delegated planning timeout stops only its bound run and preserves the prior artifact", async () => {
  // Deadline cleanup must not rely on another model turn or poll unrelated children.
  const stopped = Promise.withResolvers<string | undefined>();
  const host: PlanningHost = {
    timeoutMs: 10,
    resolveAgent: async () =>
      ok({
        name: "planner",
        description: "Fixture",
        skills: [],
        prompt: "Plan only",
        path: "/fixture/planner.md",
      }),
    coordinate: async (command) => {
      if (command.action === "stop") {
        stopped.resolve(command.id);
        return ok(null);
      }
      const run = { id: "owned-planner", status: "working", questions: [] };
      return ok(command.action === "spawn" ? run : [run]);
    },
  };
  const app = await fixture(host);
  try {
    app.withoutSubmission();
    app.queueTools({ name: "radian-plan", arguments: { action: "delegate" } });
    const session = await app.open();
    await app.run(session, "/plan --single Read only");
    expect(await stopped.promise).toBe("owned-planner");
    expect(
      expectOk(await readTaskPlan(session.sessionManager.getSessionFile()!, owner(session))),
    ).toBeNull();
  } finally {
    await app.close();
  }
});

test("Legacy --single aborting a delegated wait explicitly cancels the owned planning run", async () => {
  // Cancelling a wait alone is not proof that its background child was stopped.
  const waiting = Promise.withResolvers<void>();
  const stopped: string[] = [];
  const app = await fixture({
    resolveAgent: async () =>
      ok({
        name: "planner",
        description: "Fixture",
        skills: [],
        prompt: "Plan only",
        path: "/fixture/planner.md",
      }),
    coordinate: async (command, signal) => {
      if (command.action === "stop") {
        stopped.push(command.id);
        return ok(null);
      }
      if (command.action === "wait") {
        waiting.resolve();
        return new Promise((resolve) => {
          const abort = () => resolve(err(new CancelledError()));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      const run = { id: "owned-planner", status: "working", questions: [] };
      return ok(command.action === "spawn" ? run : [run]);
    },
  });
  try {
    app.withoutSubmission();
    app.queueTools(
      { name: "radian-plan", arguments: { action: "delegate" } },
      { name: "radian-plan", arguments: { action: "wait" } },
    );
    const session = await app.open();
    const run = app.run(session, "/plan --single Read only");
    await waiting.promise;
    await session.abort();
    await run;
    expect(stopped).toEqual(["owned-planner"]);
    expect(
      expectOk(await readTaskPlan(session.sessionManager.getSessionFile()!, owner(session))),
    ).toBeNull();
  } finally {
    await app.close();
  }
});

test("Cancelling through the planning tool does not unlock writes or submission in the same turn", async () => {
  // A model cannot escape read-only planning by cancelling and immediately executing work.
  const app = await fixture();
  try {
    const session = await app.open();
    await app.run(session, "/plan --single Original plan");
    const original = expectOk(
      await readTaskPlan(session.sessionManager.getSessionFile()!, owner(session)),
    )!;
    app.queueTools(
      { name: "radian-plan", arguments: { action: "cancel" } },
      {
        name: "radian-plan",
        arguments: {
          action: "submit",
          plan: proposal("Unexpected replacement"),
          review: { summary: "Unexpected", warnings: [] },
        },
      },
      {
        name: "write",
        arguments: { path: "cancel-escape.txt", content: "unexpected" },
      },
    );
    await app.run(session, "/plan --single Cancel without implementation");
    expect(await Bun.file(join(app.directory, "cancel-escape.txt")).exists()).toBe(false);
    expect(
      expectOk(await readTaskPlan(session.sessionManager.getSessionFile()!, owner(session)))?.hash,
    ).toBe(original.hash);
    app.setTool({
      name: "write",
      arguments: { path: "later-authorized.txt", content: "approved" },
    });
    await app.run(session, "Now perform this authorized write");
    expect(await Bun.file(join(app.directory, "later-authorized.txt")).text()).toBe("approved");
  } finally {
    await app.close();
  }
});

test("Legacy --single planning loads its skill, validates a graph and retains only one current sidecar", async () => {
  // Use a real SDK session with scripted provider responses, not a live model.
  const app = await fixture();
  try {
    const session = await app.open();
    // Planning has one entry point, with no management subcommand completion.
    const command = session.extensionRunner.getCommand("plan")!;
    expect(command.getArgumentCompletions).toBeUndefined();

    // Generate a plan, then replace it through the same planning workflow.
    await app.run(session, "/plan --single Add the feature without deployment");
    const file = session.sessionManager.getSessionFile()!;
    const first = expectOk(await readTaskPlan(file, owner(session)))!;
    app.setPlan(proposal("Deliver the revised feature"));
    await app.run(session, "/plan --single Revise the goal");
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
    await app.run(session, "/plan --single Initial requirements");
    const file = session.sessionManager.getSessionFile()!;
    const before = await Bun.file(planFilePath(file)).text();
    const invalid = proposal();
    invalid.tasks[0]!.dependsOn = ["implement"];
    app.setPlan(invalid);

    // A structurally invalid submission is a failed tool call, not a replacement.
    await app.run(session, "/plan --single Try a cyclic update");

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
    await app.run(first, "/plan --single Create a feature plan");
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
              ? {
                  path: "unplanned.txt",
                  edits: [{ oldText: "before", newText: "after" }],
                }
              : { action: "spawn", agent: "probe", task: "Execute" },
      });

      // Attempt task execution from within the planning turn.
      await app.run(session, "/plan --single Investigate only");

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
      {
        name: "write",
        arguments: { path: "unplanned.txt", content: "unexpected" },
      },
      {
        name: "radian-subagent",
        arguments: { action: "spawn", agent: "probe", task: "Execute" },
      },
      {
        name: "radian-subagent",
        arguments: { action: "list", agent: "probe", task: "List" },
      },
      {
        name: "radian-plan",
        arguments: {
          action: "submit",
          plan: proposal("Submitted after investigation"),
          review: { summary: "Checked coverage", warnings: [] },
        },
      },
    );

    await app.run(session, "/plan --single Investigate only");

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
      retry: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 1,
        maxAgentDelayMs: 1,
      },
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
      {
        name: "write",
        arguments: { path: "retry-write.txt", content: "unexpected" },
      },
      {
        name: "radian-plan",
        arguments: {
          action: "submit",
          plan: proposal("Recovered plan"),
          review: { summary: "Checked recovery", warnings: [] },
        },
      },
    );
    await app.run(session, "/plan --single Recover from provider error");

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
      request?.signal?.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });
      stream.push({ type: "start", partial: message });
      started.resolve();
      void release.promise.then(() => {
        message.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end();
      });
      return stream;
    };
    await session.prompt("/plan --single Hold until cancelled");
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
    await app.run(session, "/plan --single Fail the provider");
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
    await app.run(session, "/plan --single Initial plan");
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
      await session.prompt("/plan --single Revised requirements");
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
    await app.run(session, "/plan --single Initial plan");
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
  "Legacy --single arguments are planning requirements, not management operations: %s",
  async (requirements) => {
    // An existing plan is replaced only by a valid submission, never by an argument keyword.
    const app = await fixture();
    try {
      const session = await app.open();
      await app.run(session, "/plan --single Initial requirements");
      const file = planFilePath(session.sessionManager.getSessionFile()!);
      const before = await Bun.file(file).text();
      const count = app.requests.length;
      app.withoutSubmission();

      // Former management words now enter the same planning workflow as any other requirement.
      await app.run(session, `/plan --single ${requirements}`);

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

test("Scheduler opt-in changes hierarchical planning to declare-and-observe without model spawning", async () => {
  const controls: unknown[] = [];
  const app = await fixture({
    resolveAgent: async () => ok(null),
    schedulerEnabled: () => ok(true),
    controlScheduler: async (command) => {
      controls.push(command);
      return ok(undefined);
    },
    coordinate: async () => ok([]),
  });
  try {
    app.withoutSubmission();
    const session = await app.open();
    app.setTool({
      name: "radian-subagent",
      arguments: { action: "spawn", agent: "lead", task: "Not model-owned" },
    });
    await app.run(session, "/plan Investigate scheduler mode");
    expect(app.requests[0]).toContain("Read-only planning scheduler mode");
    expect(app.requests[0]).toContain("do not spawn leads");
    expect(app.delegations).toBe(0);
    expect(controls).toEqual([expect.objectContaining({ kind: "started", baselineRevision: 0 })]);
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("A new plan snapshots the scheduler setting after command settings reload", async () => {
  let schedulerEnabled = false;
  const controls: PlanningSchedulerControl[] = [];
  const app = await fixture({
    resolveAgent: async () => ok(null),
    configuredAgent: async () => {
      schedulerEnabled = true;
      return ok(null);
    },
    schedulerEnabled: () => ok(schedulerEnabled),
    controlScheduler: async (command) => {
      controls.push(command);
      return ok(undefined);
    },
    coordinate: async () => ok([]),
  });
  try {
    app.withoutSubmission();
    const session = await app.open();

    // Command configuration reload can change the setting before this invocation starts.
    await app.run(session, "/plan Use the freshly loaded scheduler setting");
    expect(controls).toEqual([expect.objectContaining({ kind: "started" })]);
    expect(app.requests[0]).toContain("Read-only planning scheduler mode is enabled");
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([false, true])(
  "Older invocation metadata restores scheduler ownership %s from durable facts rather than the current setting",
  async (schedulerOwned) => {
    const controls: PlanningSchedulerControl[] = [];
    const app = await fixture({
      resolveAgent: async () => ok(null),
      schedulerEnabled: () => ok(!schedulerOwned),
      controlScheduler: async (command) => {
        controls.push(command);
        return ok(undefined);
      },
      coordinate: async () => ok([]),
    });
    try {
      app.withoutSubmission();
      const session = await app.open();
      await app.run(session, "Initialize the durable session");
      const doc = createWorkflowDocument(
        { ...owner(session), sessionFile: session.sessionManager.getSessionFile()! },
        crypto.randomUUID(),
        0,
      );
      const restored = schedulerOwned ? migrateWorkflowToV2(doc) : doc;
      if (restored.version === 2)
        restored.scheduler = {
          invocations: [{ id: "older-request", kind: "plan", state: "active", createdAt: 0 }],
          admissions: {},
          consents: {},
        };
      expectOk(
        await mutateWorkflow(
          { originSessionFile: session.sessionManager.getSessionFile()! },
          owner(session),
          () => ok({ doc: restored, effects: [], outcome: { kind: "applied" } }),
          schedulerOwned ? { requireVersion: 2 } : undefined,
        ),
      );
      // Entries written before ownership persistence must remain readable without migration.
      session.sessionManager.appendCustomEntry("radian.task-plan-invocation", {
        requestId: "older-request",
        baselineRevision: 0,
        state: "active",
      });
      const reopened = await app.open(session.sessionManager.getSessionFile()!);
      await app.run(reopened, "Observe the restored invocation");
      expect(app.requests.at(-1)!.includes("Read-only planning scheduler mode is enabled")).toBe(
        schedulerOwned,
      );

      // Only the next request picks the opposite setting; the previous owner handles cleanup.
      await app.run(reopened, "/plan Pick the current setting for a new request");
      expect(controls).toEqual([
        schedulerOwned
          ? { kind: "cancelled", invocationId: "older-request" }
          : expect.objectContaining({ kind: "started" }),
      ]);
      expect(app.errors).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Flag-off hierarchical planning keeps the complete deterministic request prompt unchanged", async () => {
  const app = await fixture({
    resolveAgent: async () => ok(null),
    schedulerEnabled: () => ok(false),
    coordinate: async () => ok([]),
  });
  try {
    app.withoutSubmission();
    const session = await app.open();
    await app.run(session, "/plan Preserve legacy behavior");
    const request = session.sessionManager
      .getBranch()
      .find(
        (entry) =>
          entry.type === "custom_message" && entry.customType === "radian.task-plan-request",
      );
    expect(request?.type === "custom_message" ? request.content : undefined).toBe(
      `${legacyPlanningInstructions}\n\nHierarchical planning mode. Declare relevant branches with radian-task declare, spawn each assigned lead with binding {id: branchId, role: "lead"}, and ask leads to publish-plan. Never accept/save/rewrite their bodies. Use radian-plan report.\n\n\nUser requirements:\nPreserve legacy behavior`,
    );
    expect(app.errors).toEqual([]);
  } finally {
    await app.close();
  }
});
