import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "../app/ui/workbench.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import { pressLeader } from "../testing/keys.ts";
import { parseWorkflowCommand } from "./workflow-command.ts";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoWorkspace } from "../workspace/demo.ts";
import { ok } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";
import {
  SessionRegistry,
  type ExecutionState,
  type SessionContext,
  type SessionExecutor,
} from "./session-registry.ts";
import { userCommandProvenance } from "./repair-command.ts";
import { openWorkflow, mutateWorkflow } from "./task-workflow-store.ts";
import { publishPlanArtifact } from "./verification-policy.ts";
import type { WorkflowCommand } from "./workflow-command.ts";

const profiles = ["lead", "engineer", "qa"].map((name) => ({
  name,
  description: name,
  path: `/fixture/${name}.md`,
  prompt: `Role ${name}`,
  model: name === "qa" ? "openai-codex/fixture" : "claude-code/fixture",
  thinking: "high" as const,
  skills: [],
}));
class Executor implements SessionExecutor {
  state: ExecutionState = { status: null, output: "", error: null };
  readonly done = Promise.withResolvers<void>();
  private readonly listeners = new Set<() => void>();
  readonly workflowScheduler = { profiles: () => ok(profiles) };
  constructor(
    readonly context: SessionContext,
    readonly savedSessionId: string,
    readonly sessionFile: string | undefined,
  ) {}
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async prompt() {
    this.state = { status: "working", output: "", error: null };
    await this.done.promise;
    return ok(undefined);
  }
  finish() {
    this.state = { status: "complete", output: "Done", error: null };
    this.done.resolve();
  }
  close() {
    this.done.resolve();
    return Promise.resolve(ok(undefined));
  }
  appendNotice(text: string) {
    this.state = {
      ...this.state,
      output: text,
      sections: [
        { id: crypto.randomUUID(), kind: "notice", title: "Workflow", text, status: "complete" },
      ],
    };
    for (const listener of this.listeners) listener();
    return Promise.resolve(ok(undefined));
  }
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-execution-host-")));
  const sessionFile = join(directory, "origin.jsonl");
  const owner = { conversationId: crypto.randomUUID(), cwd: "/demo/radian" };
  await writeFile(
    sessionFile,
    JSON.stringify({ type: "session", id: owner.conversationId, cwd: owner.cwd }) + "\n",
  );
  const executors: Executor[] = [];
  const registry = new SessionRegistry(demoWorkspace(), async (context) => {
    const executor = new Executor(
      context,
      context.role === "main" ? owner.conversationId : crypto.randomUUID(),
      context.role === "main" ? sessionFile : undefined,
    );
    executors.push(executor);
    return executor;
  });
  const id = expectOk(await registry.create("demo:main", sessionFile));
  const root = executors[0]!;
  let sequence = 0;
  expectOk(
    await root.context.coordinateTask!(
      {
        action: "declare",
        goal: "Execution fixture",
        branches: [
          { id: "scope", title: "Scope", scope: "Work", dependsOn: [], lead: { profile: "lead" } },
        ],
      },
      `declare-${sequence++}`,
      undefined,
      profiles.map((p) => p.name),
    ),
  );
  expectOk(
    await mutateWorkflow({ originSessionFile: sessionFile }, owner, (doc) => {
      if (!doc) throw new Error("Fixture declaration missing.");
      return publishPlanArtifact(doc, {
        eventKey: "fixture-plan",
        at: 1,
        artifactId: "scope-plan",
        binding: {
          workflowId: doc.workflowId,
          taskId: "scope",
          role: "lead",
          assignmentVersion: 0,
          purpose: "planning",
        },
        author: { runId: "fixture-lead", profile: "lead", role: "lead" },
        plan: {
          schemaVersion: 1,
          goal: "Fixture plan",
          outOfScope: [],
          assumptions: [],
          openQuestions: [],
          tasks: [
            {
              id: "work",
              title: "Implement",
              agent: "engineer",
              dependsOn: [],
              inputs: [],
              outputs: ["Change"],
              acceptanceCriteria: ["Independent QA"],
              files: [],
            },
          ],
        },
        review: { summary: "Reviewed", warnings: [] },
      });
    }),
  );
  expectOk(
    await root.context.coordinateTask!(
      {
        action: "assign",
        parentTaskId: "scope",
        tasks: ["A", "B"].map((task) => ({
          id: task,
          title: task,
          kind: "implement",
          scope: `Change ${task}`,
          dependsOn: task === "B" ? ["A"] : [],
          lead: { profile: "lead" },
          implementer: { profile: "engineer" },
          verifier: { profile: "qa" },
        })),
      },
      `assign-${sequence++}`,
      undefined,
      profiles.map((p) => p.name),
    ),
  );
  const command = (value: WorkflowCommand) =>
    registry.workflow(
      id,
      owner.conversationId,
      value,
      userCommandProvenance(owner.conversationId, Date.now()),
    );
  const until = async (condition: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 500; i++) {
      if (await condition()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("Offline execution did not settle.");
  };
  return {
    registry,
    root,
    id,
    owner,
    executors,
    command,
    until,
    read: async () => expectOk(await openWorkflow(sessionFile, owner))!.doc,
    close: async () => {
      expectOk(await registry.shutdown());
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("keyboard workflow commands render approval details and control execution without template substitution", async () => {
  // Use the real workbench, keymap, registry and durable store; model executors remain offline fakes.
  const app = await fixture();
  const ui = await createTestRenderer({ width: 180, height: 58, kittyKeyboard: true });
  const selection = new WorkspaceSelection(app.registry.snapshot);
  selection.selectSession("demo:main", app.id);
  const submitted: string[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  const view = new Workbench(ui.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    getSessionDetails: (id) => app.registry.details(id),
    onComplete: async () =>
      ok({
        items: [
          {
            kind: "template" as const,
            value: "workflow",
            description: "Must not replace reserved host input",
          },
        ],
        truncated: false,
      }),
    onPrompt: (_id, text) => {
      submitted.push(text);
      const command = expectOk(parseWorkflowCommand(text));
      if (!command) throw new Error("Reserved input was replaced before reaching the host.");
      const action = app.command(command).then((result) => (result.ok ? ok(undefined) : result));
      pending = action;
      return action;
    },
  });
  const unsubscribe = app.registry.subscribe(() =>
    selection.replaceSnapshot(app.registry.snapshot),
  );
  const send = async (text: string) => {
    pressLeader(ui, "a");
    await ui.mockInput.typeText(text);
    ui.mockInput.pressEnter();
    await pending;
    await ui.renderOnce();
    return ui.captureCharFrame();
  };
  try {
    await ui.renderOnce();
    // Even an identically named template cannot rewrite a reserved status command.
    expect(await send("/workflow")).toContain("Workflow");
    const preview = await send("/workflow start A");
    expect(preview).toContain("NOT started");
    expect(preview).toContain("Model: openai-codex/fixture; effort: high");
    expect(preview).toContain("Tool ceiling:");
    expect(preview).toContain("Verification tools:");
    expect(app.executors).toHaveLength(1);
    const doc = await app.read();
    if (doc.version !== 2) throw new Error("Preview was not persisted.");
    const receipt = Object.values(doc.scheduler!.consents)[0]!;
    expect(receipt.approval!.profiles.qa!.model).toBe("openai-codex/fixture");

    // Only the next explicit Enter on confirm may create the implementer.
    await send(`/workflow confirm ${receipt.id}`);
    await app.until(() => app.executors.length === 2);
    expect(await send("/workflow pause")).toContain("paused");
    expect(app.executors).toHaveLength(2);
    expect(await send("/workflow resume")).toContain("resumed");
    expect(app.executors).toHaveLength(2);
    expect(await send("/workflow cancel")).toContain("Accepted changes were retained");
    const terminal = await app.read();
    expect(terminal.version === 2 && terminal.scheduler!.invocations[0]!.state).toBe("cancelled");
    expect(terminal.tasks.A!.status).toBe("open");
    expect(submitted).toEqual([
      "/workflow",
      "/workflow start A",
      `/workflow confirm ${receipt.id}`,
      "/workflow pause",
      "/workflow resume",
      "/workflow cancel",
    ]);
  } finally {
    unsubscribe();
    view.dispose();
    await ui.dispose();
    await app.close();
  }
});

test("stored approval details cannot be rewritten or removed after preview", async () => {
  // The displayed model/permission facts must survive storage exactly, not just their hash.
  const app = await fixture();
  try {
    const preview = expectOk(await app.command({ kind: "start", tasks: ["A"], autoRepair: false }));
    const id = /^Execution preview (\S+)/u.exec(preview)![1]!;
    const doc = await app.read();
    for (const change of ["rewrite", "erase"] as const) {
      const altered = await mutateWorkflow(
        { originSessionFile: app.root.sessionFile! },
        app.owner,
        (current) => {
          if (!current || current.version !== 2) throw new Error("Missing preview.");
          const receipt = current.scheduler!.consents[id]!;
          if (change === "erase") delete receipt.approval;
          else
            receipt.approval!.profiles.qa = {
              ...receipt.approval!.profiles.qa!,
              model: "other/unapproved",
            };
          current.revision++;
          return ok({ doc: current, effects: [], outcome: { kind: "applied" as const } });
        },
      );
      expect(expectError(altered).code).toBe("WORKFLOW_CONFLICT");
    }
    expect(await app.read()).toEqual(doc);
    expect(app.executors).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("real host requires preview and confirmation, then runs implementer and current-revision QA", async () => {
  const app = await fixture();
  try {
    const preview = expectOk(await app.command({ kind: "start", tasks: ["B"], autoRepair: false }));
    const receipt = /^Execution preview (\S+)/u.exec(preview)![1]!;
    expect(preview).toContain("NOT started");
    expect(app.executors).toHaveLength(1);
    expectOk(await app.command({ kind: "confirm", id: receipt }));
    await app.until(() => app.executors.length === 2);
    const engineer = app.executors[1]!;
    expect(engineer.context.binding).toMatchObject({ taskId: "A", role: "implementer" });
    expect(engineer.context.purpose).toBeUndefined();
    expectOk(await engineer.context.authorizeTool!("write"));
    expectOk(await engineer.context.coordinateTask!({ action: "submit" }, "submit-A"));
    expect(app.executors).toHaveLength(2);
    engineer.finish();
    await app.until(() => app.executors.length === 3);
    const qa = app.executors[2]!;
    expect(qa.context.binding).toMatchObject({ taskId: "A", role: "verifier" });
    expectError(
      await qa.context.coordinateTask!(
        { action: "verdict", revision: 0, verdict: "pass", evidence: "Wrong revision" },
        "stale",
      ),
    );
    expectOk(
      await qa.context.coordinateTask!(
        { action: "verdict", revision: 1, verdict: "pass", evidence: "Independent fixture checks" },
        "qa-A",
      ),
    );
    qa.finish();
    await app.until(() => app.executors.length === 4);
    expect(app.executors[3]!.context.binding).toMatchObject({ taskId: "B", role: "implementer" });
    expectOk(await app.command({ kind: "cancel" }));
    const doc = await app.read();
    expect(doc.tasks.A!.status).toBe("verified");
    expect(doc.tasks.B!.status).not.toBe("cancelled");
    expect(doc.version === 2 && doc.scheduler!.invocations[0]!.state).toBe("cancelled");
  } finally {
    await app.close();
  }
});

test("stale approvals and model-supplied workflow text cannot launch work", async () => {
  const app = await fixture();
  try {
    expectError(await app.registry.prompt(app.id, "/workflow start all"));
    const preview = expectOk(
      await app.command({ kind: "start", tasks: ["all"], autoRepair: false }),
    );
    const receipt = /^Execution preview (\S+)/u.exec(preview)![1]!;
    expectOk(
      await app.root.context.coordinateTask!(
        { action: "reassign", taskId: "A", role: "implementer", profile: "lead" },
        "changed",
        undefined,
        profiles.map((p) => p.name),
      ),
    );
    expect(expectError(await app.command({ kind: "confirm", id: receipt })).code).toBe(
      "WORKFLOW_CONFLICT",
    );
    expect(app.executors).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("repair opt-in uses exact attempts and the third recheck failure admits analysis but no fourth fix", async () => {
  const app = await fixture();
  try {
    const receipt = /^Execution preview (\S+)/u.exec(
      expectOk(await app.command({ kind: "start", tasks: ["A"], autoRepair: true })),
    )![1]!;
    expectOk(await app.command({ kind: "confirm", id: receipt }));
    let childIndex = 1;
    for (let round = 0; round <= 3; round++) {
      await app.until(() => app.executors.length > childIndex);
      const engineer = app.executors[childIndex++]!;
      expect(engineer.context.binding!.role).toBe("implementer");
      expectOk(await engineer.context.coordinateTask!({ action: "submit" }, `submit-${round}`));
      engineer.finish();
      await app.until(() => app.executors.length > childIndex);
      const qa = app.executors[childIndex++]!;
      expect(qa.context.binding!.role).toBe("verifier");
      expectOk(
        await qa.context.coordinateTask!(
          {
            action: "verdict",
            revision: round + 1,
            verdict: "fail",
            evidence: `Independent failed check ${round}`,
          },
          `qa-${round}`,
        ),
      );
      qa.finish();
      const current = await app.read();
      expect(current.defects["A-initial-1"]!.automatedFailures).toBe(round);
    }
    await app.until(() => app.executors.length > childIndex);
    const analyst = app.executors[childIndex]!;
    expect(analyst.context.binding!.role).toBe("lead");
    expect(analyst.context.purpose).toBe("analysis");
    expectError(await analyst.context.authorizeTool!("write"));
    const doc = await app.read();
    expect(doc.defects["A-initial-1"]!.locked).toBe(true);
    expect(
      app.executors.filter((item) => item.context.binding?.role === "implementer"),
    ).toHaveLength(4);
    expectOk(await app.command({ kind: "cancel" }));
  } finally {
    await app.close();
  }
});

test("completed execution can be reviewed and a fresh preview does not inherit old ownership", async () => {
  const app = await fixture();
  try {
    const receipt = /^Execution preview (\S+)/u.exec(
      expectOk(await app.command({ kind: "start", tasks: ["A"], autoRepair: false })),
    )![1]!;
    expectOk(await app.command({ kind: "confirm", id: receipt }));
    await app.until(() => app.executors.length === 2);
    expectOk(await app.executors[1]!.context.coordinateTask!({ action: "submit" }, "submit"));
    app.executors[1]!.finish();
    await app.until(() => app.executors.length === 3);
    expectOk(
      await app.executors[2]!.context.coordinateTask!(
        { action: "verdict", revision: 1, verdict: "pass", evidence: "Independent" },
        "verdict",
      ),
    );
    app.executors[2]!.finish();
    await app.until(async () => {
      const doc = await app.read();
      return doc.version === 2 && doc.scheduler!.invocations[0]!.state === "completed";
    });
    expectOk(await app.command({ kind: "status" }));
    const next = /^Execution preview (\S+)/u.exec(
      expectOk(await app.command({ kind: "start", tasks: ["B"], autoRepair: false })),
    )![1]!;
    expectOk(await app.command({ kind: "confirm", id: next }));
    await app.until(() => app.executors.length === 4);
    expect(app.executors[3]!.context.binding!.taskId).toBe("B");
    expectOk(await app.command({ kind: "cancel" }));
  } finally {
    await app.close();
  }
});

test("changing assignments revokes running write authority and cancels only scheduled work", async () => {
  const app = await fixture();
  try {
    const receipt = /^Execution preview (\S+)/u.exec(
      expectOk(await app.command({ kind: "start", tasks: ["A"], autoRepair: false })),
    )![1]!;
    expectOk(await app.command({ kind: "confirm", id: receipt }));
    await app.until(() => app.executors.length === 2);
    const engineer = app.executors[1]!;
    expectOk(
      await app.root.context.coordinateTask!(
        { action: "reassign", taskId: "A", role: "lead", profile: "engineer" },
        "changed",
        undefined,
        profiles.map((p) => p.name),
      ),
    );
    expectError(await engineer.context.authorizeTool!("write"));
    expectOk(await app.command({ kind: "cancel" }));
    expect((await app.read()).tasks.A!.artifactRevision).toBe(0);
  } finally {
    await app.close();
  }
});
