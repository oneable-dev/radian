import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "../result.ts";
import { StorageError, type ExpectedError } from "../errors.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { PlanningSchedulerDriver, type SchedulerHost } from "./workflow-scheduler-driver.ts";
import {
  schedule,
  type SchedulerEvent,
  type SchedulerIntent,
  type SchedulerRun,
} from "./workflow-scheduler.ts";
import { createWorkflowDocument, type WorkflowDocumentV2 } from "./task-workflow.ts";
import { mutateWorkflow, openWorkflow } from "./task-workflow-store.ts";
import { declareScope } from "./verification-policy.ts";
import type { AgentProfile } from "./agent-profiles.ts";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "radian-scheduler-driver-")));
  const file = join(directory, "origin.jsonl");
  const owner = { conversationId: crypto.randomUUID(), cwd: directory };
  await writeFile(
    file,
    JSON.stringify({ type: "session", id: owner.conversationId, cwd: directory }) + "\n",
  );
  expectOk(
    await mutateWorkflow({ originSessionFile: file }, owner, () =>
      declareScope(
        createWorkflowDocument({ ...owner, sessionFile: file }, crypto.randomUUID(), 0),
        {
          eventKey: "declare",
          at: 1,
          goal: "Plan",
          knownProfiles: ["lead"],
          branches: [
            { id: "A", title: "A", scope: "Read-only", dependsOn: [], lead: { profile: "lead" } },
          ],
        },
      ),
    ),
  );
  const profile: AgentProfile = {
    name: "lead",
    description: "Plan",
    prompt: "Read only",
    path: "/fixture/lead.md",
    skills: [],
  };
  const runs: SchedulerRun[] = [];
  const errors: ExpectedError[] = [];
  const unexpected: unknown[] = [];
  const launched: string[] = [];
  let uncertain: SchedulerEvent["kind"] | undefined;
  let launchUncertain = false;
  const initialized = Promise.withResolvers<void>();
  const host: SchedulerHost = {
    profiles: () => ok([profile]),
    runs: () => runs,
    commit: async (event, snapshot) => {
      let intents: SchedulerIntent[] = [];
      const committed = await mutateWorkflow(
        { originSessionFile: file },
        owner,
        (doc) => {
          const reduced = schedule(doc!, snapshot, event);
          if (!reduced.ok) return reduced;
          intents = reduced.value.intents;
          return ok({ doc: reduced.value.doc, effects: [], outcome: { kind: "applied" } });
        },
        { requireVersion: 2 },
      );
      if (!committed.ok) return committed;
      if (uncertain === event.kind) {
        uncertain = undefined;
        return err(new StorageError("Simulated uncertain post-commit response."));
      }
      return ok({ doc: committed.value.doc, intents });
    },
    launch: async (operationId) => {
      launched.push(operationId);
      runs.push({ id: "run-A", operationId, active: true });
      await initialized.promise;
      return launchUncertain
        ? err(new StorageError("Simulated uncertain launch response."))
        : ok("run-A");
    },
    stop: async (operationId) => {
      const run = runs.find((item) => item.operationId === operationId);
      if (run) run.active = false;
      return ok(undefined);
    },
    report: (error) => {
      errors.push(error);
    },
    unexpected: (error) => {
      unexpected.push(error);
    },
  };
  const driver = new PlanningSchedulerDriver(host);
  const read = async () => expectOk(await openWorkflow(file, owner))!.doc as WorkflowDocumentV2;
  const until = async (condition: () => boolean | Promise<boolean>) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await condition()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("Driver did not settle.");
  };
  return {
    driver,
    host,
    read,
    initialized,
    launched,
    errors,
    unexpected,
    until,
    uncertain(kind: SchedulerEvent["kind"]) {
      uncertain = kind;
    },
    uncertainLaunch() {
      launchUncertain = true;
    },
    async close() {
      initialized.resolve();
      await driver.control({ kind: "cancelled", invocationId: "invocation" });
      await driver.shutdown();
      expect(unexpected).toEqual([]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("An uncertain reservation commit reconciles the same operation before one launch", async () => {
  const app = await fixture();
  try {
    app.uncertain("started");
    expect(
      expectError(
        await app.driver.control({
          kind: "started",
          invocationId: "invocation",
          baselineRevision: 0,
        }),
      ).code,
    ).toBe("STORAGE_FAILED");
    expect(Object.keys((await app.read()).scheduler!.admissions)).toEqual(["invocation:A:0"]);
    expect(app.launched).toEqual([]);
    expectOk(await app.driver.send({ kind: "capacity-freed", invocationId: "invocation" }));
    await app.until(() => app.launched.length === 1);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        app.driver.send({ kind: "capacity-freed", invocationId: "invocation" }),
      ),
    );
    app.initialized.resolve();
    await app.until(
      async () => (await app.read()).scheduler!.admissions["invocation:A:0"]!.state === "running",
    );
    expect(app.launched).toEqual(["invocation:A:0"]);
  } finally {
    await app.close();
  }
});

test("An uncertain launching commit retries by operationId and never creates two runs", async () => {
  const app = await fixture();
  try {
    app.uncertain("launching");
    expectOk(
      await app.driver.control({
        kind: "started",
        invocationId: "invocation",
        baselineRevision: 0,
      }),
    );
    await app.until(() => app.errors.length === 1);
    expect(app.launched).toEqual([]);
    expectOk(await app.driver.send({ kind: "capacity-freed", invocationId: "invocation" }));
    await app.until(() => app.launched.length === 1);
    app.uncertainLaunch();
    app.initialized.resolve();
    await app.until(
      async () => (await app.read()).tasks.A!.schedule!.reason === "cleanup-uncertain",
    );
    expectOk(await app.driver.send({ kind: "capacity-freed", invocationId: "invocation" }));
    expect(app.launched).toEqual(["invocation:A:0"]);
    expect((await app.read()).scheduler!.admissions["invocation:A:0"]).toMatchObject({
      state: "running",
      runId: "run-A",
    });
  } finally {
    await app.close();
  }
});

test("A process restart interrupts committed pre-launch admission without replay", async () => {
  const app = await fixture();
  try {
    app.uncertain("started");
    expectError(
      await app.driver.control({
        kind: "started",
        invocationId: "invocation",
        baselineRevision: 0,
      }),
    );
    const restarted = new PlanningSchedulerDriver(app.host);
    expectOk(await restarted.control({ kind: "restarted", invocationId: "invocation" }));
    expectOk(await restarted.send({ kind: "capacity-freed", invocationId: "invocation" }));
    const doc = await app.read();
    expect(doc.scheduler!.admissions["invocation:A:0"]!.state).toBe("interrupted");
    expect(doc.tasks.A!.schedule!.state).toBe("interrupted");
    expect(app.launched).toEqual([]);
  } finally {
    await app.close();
  }
});
