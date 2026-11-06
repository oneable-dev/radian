import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { WorkflowError } from "../errors.ts";
import { err, ok } from "../result.ts";
import oldWorkflowSchema from "../testing/fixtures/workflow-v1.schema.json";
import { expectWorkflowMigrationRoundTrip } from "../testing/workflow-migration.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { userCommandProvenance } from "./repair-command.ts";
import { discoverAgentProfiles } from "./agent-profiles.ts";
import { readTaskPlan } from "./task-plan-store.ts";
import { resolveEffectiveProfile } from "./effective-profile.ts";
import {
  createWorkflowDocument,
  validateWorkflowDocument,
  workflowDocumentV1Schema,
  type WorkflowBinding,
  type WorkflowDocument,
  type WorkflowPolicyResult,
} from "./task-workflow.ts";
import {
  deleteWorkflowForPurge,
  deleteWorkflowForRetention,
  inspectWorkflowForRetention,
  migrateWorkflowToV2,
  mutateWorkflow,
  openWorkflow,
  recheckWorkflowForRetention,
  workflowFilePath,
  workflowBackupFilePath,
  workflowLinkFilePath,
  writeWorkflowLink,
  type WorkflowWriteIO,
} from "./task-workflow-store.ts";
import {
  addContinuationMember,
  admitRepair,
  continueTask,
  humanCancel,
  humanRecheck,
  reassign,
  recoverWorkflow,
  splitTask,
  recordFinding,
  recordVerdict,
  submitFix,
  type WorkflowEvent,
} from "./verification-policy.ts";

let sequence = 0;
const event = (): WorkflowEvent => ({ eventKey: `store-event-${++sequence}`, at: 1000 + sequence });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "radian-workflow-")));
  const cwd = join(root, "work");
  await mkdir(cwd);
  const sessionFile = join(root, "origin.jsonl");
  const owner = { conversationId: "origin", cwd };
  await writeFile(
    sessionFile,
    JSON.stringify({ type: "session", id: owner.conversationId, cwd }) + "\n",
  );
  const location = { originSessionFile: sessionFile };
  const doc = createWorkflowDocument({ ...owner, sessionFile }, crypto.randomUUID(), 0);
  doc.tasks["task-primary"] = {
    id: "task-primary",
    title: "Safe mutation",
    kind: "implement",
    scope: "Owned",
    lead: { profile: "lead" },
    implementer: { profile: "engineer" },
    verifier: { profile: "qa" },
    dependsOn: [],
    assignmentVersion: 0,
    artifactRevision: 0,
    verification: { state: "unverified" },
    status: "open",
  };
  const saved = expectOk(
    await mutateWorkflow(
      location,
      owner,
      () => ok({ doc, effects: [], outcome: { kind: "applied" } }),
      { expectedRevision: null },
    ),
  );
  expectWorkflowMigrationRoundTrip(saved.doc);
  const binding = (role: WorkflowBinding["role"]): WorkflowBinding => ({
    workflowId: doc.workflowId,
    taskId: "task-primary",
    role,
    assignmentVersion: 0,
  });
  async function continuation() {
    const nextFile = join(root, "next.jsonl");
    const nextOwner = { conversationId: "next", cwd };
    await writeFile(nextFile, JSON.stringify({ type: "session", id: "next", cwd }) + "\n");
    expectOk(
      await mutateWorkflow(location, owner, (current) =>
        addContinuationMember(current!, {
          ...event(),
          provenance: userCommandProvenance(nextOwner.conversationId, 100),
          member: { ...nextOwner, sessionFile: nextFile },
        }),
      ),
    );
    expectOk(await writeWorkflowLink(nextFile, nextOwner, location, owner));
    expectWorkflowMigrationRoundTrip(expectOk(await openWorkflow(nextFile, nextOwner))!.doc);
    return { sessionFile: nextFile, owner: nextOwner };
  }
  return {
    root,
    cwd,
    sessionFile,
    owner,
    location,
    doc: saved.doc,
    binding,
    continuation,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

const unchangedMutation = (doc: WorkflowDocument | null) =>
  ok({ doc: doc!, effects: [], outcome: { kind: "applied" as const } });

const migrationBackups = async (root: string) =>
  (await readdir(root)).filter((name) => name.endsWith(".workflow-v1-backup.json"));

test("Execution approval facts are immutable and cannot be reactivated after revocation", async () => {
  const app = await fixture();
  try {
    expectOk(
      await mutateWorkflow(
        app.location,
        app.owner,
        (doc) => {
          if (!doc || doc.version !== 2) throw new Error("Expected migrated fixture.");
          doc.scheduler = {
            invocations: [],
            admissions: {},
            consents: {
              approval: {
                id: "approval",
                conversationId: "origin",
                workflowId: doc.workflowId,
                worktree: app.cwd,
                taskIds: ["task-primary"],
                artifactRefs: [],
                fingerprint: "a".repeat(64),
                autoRepair: false,
                state: "confirmed",
                createdAt: 1,
                confirmedAt: 2,
              },
            },
          };
          doc.revision++;
          return ok({ doc, effects: [], outcome: { kind: "applied" } });
        },
        { requireVersion: 2 },
      ),
    );
    for (const change of ["scope", "erase", "reset"] as const) {
      const result = await mutateWorkflow(app.location, app.owner, (doc) => {
        if (!doc || doc.version !== 2) throw new Error("Expected fixture.");
        if (change === "scope") doc.scheduler!.consents.approval!.autoRepair = true;
        else if (change === "erase") delete doc.scheduler!.consents.approval;
        else doc.scheduler!.consents.approval!.state = "preview";
        doc.revision++;
        return ok({ doc, effects: [], outcome: { kind: "applied" } });
      });
      expect(expectError(result).code).toBe("WORKFLOW_CONFLICT");
    }
    expectOk(
      await mutateWorkflow(app.location, app.owner, (doc) => {
        if (!doc || doc.version !== 2) throw new Error("Expected fixture.");
        doc.scheduler!.consents.approval!.state = "revoked";
        doc.revision++;
        return ok({ doc, effects: [], outcome: { kind: "applied" } });
      }),
    );
    const restored = await mutateWorkflow(app.location, app.owner, (doc) => {
      if (!doc || doc.version !== 2) throw new Error("Expected fixture.");
      doc.scheduler!.consents.approval!.state = "confirmed";
      doc.revision++;
      return ok({ doc, effects: [], outcome: { kind: "applied" } });
    });
    expect(expectError(restored).code).toBe("WORKFLOW_CONFLICT");
  } finally {
    await app.close();
  }
});

test("Scheduler opt-in alone migrates v1 with one revision and a private byte-exact durable backup", async () => {
  // Even non-canonical JSON formatting must survive in the recovery backup.
  const app = await fixture();
  try {
    const path = workflowFilePath(app.sessionFile);
    const original = JSON.stringify(app.doc, null, 2) + "\n";
    await writeFile(path, original);
    const stages: string[] = [];
    const io: Partial<WorkflowWriteIO> = {
      write: async (file, text) => {
        stages.push("write");
        await file.writeFile(text);
      },
      sync: async (file) => {
        stages.push("sync");
        await file.sync();
      },
      syncDirectory: async (directory) => {
        stages.push("directory");
        const file = await fs.open(directory, "r");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
      },
      rename: async (from, to) => {
        stages.push("rename");
        await fs.rename(from, to);
      },
    };

    const migrated = expectOk(
      await mutateWorkflow(app.location, app.owner, unchangedMutation, {
        requireVersion: 2,
        expectedRevision: 0,
        io,
      }),
    ).doc;

    // The durable backup (including directory sync) precedes atomic replacement.
    expect(migrated).toEqual({ ...app.doc, version: 2, revision: 1 });
    expect(stages).toEqual([
      "write",
      "sync",
      "rename",
      "directory",
      "write",
      "sync",
      "rename",
      "directory",
    ]);
    const backups = await migrationBackups(app.root);
    expect(backups).toHaveLength(1);
    const backup = join(app.root, backups[0]!);
    expect(await readFile(backup, "utf8")).toBe(original);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect(backups[0]!.endsWith(".workflow.json")).toBe(false);
    expect(expectOk(await openWorkflow(app.sessionFile, app.owner))!.doc).toEqual(migrated);

    const fingerprint = await stat(path);
    const again = expectOk(
      await mutateWorkflow(app.location, app.owner, unchangedMutation, { requireVersion: 2 }),
    );
    expect(again.doc).toEqual(migrated);
    expect((await stat(path)).ino).toBe(fingerprint.ino);
    expect(await migrationBackups(app.root)).toEqual(backups);
  } finally {
    await app.close();
  }
});

test("Crash retry atomically replaces one valid backup without exposing partial contents", async () => {
  // Simulate a crash after backup publication but before the origin's migration rename.
  const app = await fixture();
  try {
    const path = workflowFilePath(app.sessionFile);
    const backup = workflowBackupFilePath(app.sessionFile);
    const before = await readFile(path, "utf8");
    const failed = await mutateWorkflow(app.location, app.owner, unchangedMutation, {
      requireVersion: 2,
      io: {
        write: async (file, text) => {
          if (text === before) expect(await Bun.file(backup).exists()).toBe(false);
          await file.writeFile(text);
        },
        rename: async (from, to) => {
          if (to === path)
            throw Object.assign(new Error("Crash before migration"), { code: "EIO" });
          await fs.rename(from, to);
        },
      },
    });
    expect(expectError(failed).code).toBe("STORAGE_FAILED");
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readFile(backup, "utf8")).toBe(before);
    const previous = await stat(backup);

    // Retry must preserve the old complete backup until its replacement is synced and renamed.
    const retried = expectOk(
      await mutateWorkflow(app.location, app.owner, unchangedMutation, {
        requireVersion: 2,
        io: {
          write: async (file, text) => {
            await file.writeFile(text.slice(0, 10));
            expect(await readFile(backup, "utf8")).toBe(before);
            await file.truncate(0);
            await file.write(text, 0, "utf8");
          },
        },
      }),
    );

    // Only the owned, deterministic backup remains, with the exact v1 bytes and private mode.
    expect(retried.doc.version).toBe(2);
    expect(await migrationBackups(app.root)).toEqual(["origin.jsonl.workflow-v1-backup.json"]);
    expect(await readFile(backup, "utf8")).toBe(before);
    expect((await stat(backup)).ino).not.toBe(previous.ino);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect((await readdir(app.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["corrupt", "foreign", "symlink", "public", "hardlink"] as const)(
  "Unsafe %s backup blocks migration and cleanup without deleting the origin",
  async (kind) => {
    // Backup bytes and filesystem ownership must both be verified before replacement or deletion.
    const app = await fixture();
    try {
      const backup = workflowBackupFilePath(app.sessionFile);
      const before = await readFile(workflowFilePath(app.sessionFile), "utf8");
      const target = join(app.root, "target.json");
      await writeFile(target, before, { mode: 0o600 });
      if (kind === "symlink") await symlink(target, backup);
      else if (kind === "hardlink") await fs.link(target, backup);
      else
        await writeFile(
          backup,
          kind === "corrupt"
            ? "{broken"
            : kind === "foreign"
              ? JSON.stringify({
                  ...app.doc,
                  origin: { ...app.doc.origin, conversationId: "other" },
                })
              : before,
          { mode: kind === "public" ? 0o644 : 0o600 },
        );

      const migration = await mutateWorkflow(app.location, app.owner, unchangedMutation, {
        requireVersion: 2,
      });
      const inspection = await inspectWorkflowForRetention(app.sessionFile, app.owner);
      const purge = await deleteWorkflowForPurge(app.sessionFile, app.owner);

      expect(expectError(migration).code).toBe("STORAGE_FAILED");
      expect(expectError(inspection).code).toBe("STORAGE_FAILED");
      expect(expectError(purge).code).toBe("STORAGE_FAILED");
      expect(await readFile(workflowFilePath(app.sessionFile), "utf8")).toBe(before);
      expect(await Bun.file(backup).exists()).toBe(true);
      expect(await readFile(target, "utf8")).toBe(before);
    } finally {
      await app.close();
    }
  },
);

test("Missing backup after partial cleanup remains retryable with the original inspection", async () => {
  // Backup unlink can succeed before origin unlink fails; its absence must not strand the origin.
  const app = await fixture();
  try {
    expectOk(
      await mutateWorkflow(app.location, app.owner, unchangedMutation, { requireVersion: 2 }),
    );
    const inspected = expectOk(await inspectWorkflowForRetention(app.sessionFile, app.owner));
    const nativeUnlink = fs.unlink;
    const failure = spyOn(fs, "unlink").mockImplementation((path) =>
      path === workflowFilePath(app.sessionFile)
        ? Promise.reject(Object.assign(new Error("Origin unlink failed"), { code: "EACCES" }))
        : nativeUnlink(path),
    );
    try {
      expect(
        expectError(await deleteWorkflowForRetention(app.sessionFile, app.owner, inspected)).code,
      ).toBe("STORAGE_FAILED");
    } finally {
      failure.mockRestore();
    }
    expect(await Bun.file(workflowBackupFilePath(app.sessionFile)).exists()).toBe(false);

    const rechecked = await recheckWorkflowForRetention(app.sessionFile, app.owner, inspected);
    const retried = await deleteWorkflowForRetention(app.sessionFile, app.owner, inspected);

    expectOk(rechecked);
    expect(expectOk(retried)).toBe("removed");
    expect(await Bun.file(workflowFilePath(app.sessionFile)).exists()).toBe(false);
  } finally {
    await app.close();
  }
});

test.each(["replacement", "creation"] as const)(
  "Backup %s after retention inspection blocks recheck and deletion",
  async (change) => {
    // An origin-only fingerprint must not authorize removal of a new or replaced backup.
    const app = await fixture();
    try {
      if (change === "replacement")
        expectOk(
          await mutateWorkflow(app.location, app.owner, unchangedMutation, { requireVersion: 2 }),
        );
      const inspected = expectOk(await inspectWorkflowForRetention(app.sessionFile, app.owner));
      if (change === "replacement")
        await fs.appendFile(workflowBackupFilePath(app.sessionFile), "\n");
      else
        await writeFile(workflowBackupFilePath(app.sessionFile), JSON.stringify(app.doc), {
          mode: 0o600,
        });

      const rechecked = await recheckWorkflowForRetention(app.sessionFile, app.owner, inspected);
      const deleted = await deleteWorkflowForRetention(app.sessionFile, app.owner, inspected);

      expect(expectError(rechecked).code).toBe("STORAGE_FAILED");
      expect(expectError(deleted).code).toBe("STORAGE_FAILED");
      expect(await Bun.file(workflowFilePath(app.sessionFile)).exists()).toBe(true);
      expect(await Bun.file(workflowBackupFilePath(app.sessionFile)).exists()).toBe(true);
    } finally {
      await app.close();
    }
  },
);

test("Migration backups are not discovered as agent profiles or conversation plans", async () => {
  // A backup contains private workflow state, not executable role instructions or a plan submission.
  const app = await fixture();
  try {
    expectOk(
      await mutateWorkflow(app.location, app.owner, unchangedMutation, { requireVersion: 2 }),
    );
    const agentDir = join(app.root, "agent");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    const copied = join(agentDir, "agents", "origin.jsonl.workflow-v1-backup.json");
    await fs.copyFile(workflowBackupFilePath(app.sessionFile), copied);

    const profiles = expectOk(discoverAgentProfiles(agentDir, app.cwd, false));
    const plan = expectOk(await readTaskPlan(app.sessionFile, app.owner));

    expect(profiles.some((profile) => profile.path === copied)).toBe(false);
    expect(plan).toBe(null);
  } finally {
    await app.close();
  }
});

test("Ordinary workflow mutations remain v1 and cannot implicitly upgrade or downgrade", async () => {
  const app = await fixture();
  try {
    const result = expectOk(
      await mutateWorkflow(app.location, app.owner, (doc) =>
        recordFinding(doc!, {
          ...event(),
          binding: app.binding("verifier"),
          defectId: "legacy",
          revision: 0,
          summary: "Legacy",
          evidence: "QA",
        }),
      ),
    );
    expect(result.doc.version).toBe(1);
    expect(await readFile(workflowFilePath(app.sessionFile), "utf8")).toBe(
      JSON.stringify(result.doc),
    );
    expect(await migrationBackups(app.root)).toEqual([]);
    expect(
      expectError(
        await mutateWorkflow(app.location, app.owner, (doc) =>
          ok({
            doc: { ...migrateWorkflowToV2(doc!), revision: doc!.revision + 1 },
            effects: [],
            outcome: { kind: "applied" },
          }),
        ),
      ).code,
    ).toBe("WORKFLOW_CONFLICT");

    const migrated = expectOk(
      await mutateWorkflow(app.location, app.owner, unchangedMutation, { requireVersion: 2 }),
    );
    const before = await readFile(workflowFilePath(app.sessionFile), "utf8");
    expect(
      expectError(
        await mutateWorkflow(app.location, app.owner, (doc) =>
          ok({
            doc: { ...doc!, version: 1, revision: doc!.revision + 1 },
            effects: [],
            outcome: { kind: "applied" },
          }),
        ),
      ).code,
    ).toBe("WORKFLOW_CONFLICT");
    expect(await readFile(workflowFilePath(app.sessionFile), "utf8")).toBe(before);
    expect(migrated.doc.version).toBe(2);
  } finally {
    await app.close();
  }
});

test.each(["write", "sync", "rename", "syncDirectory"] as const)(
  "Migration backup %s failure aborts without replacing v1",
  async (stage) => {
    const app = await fixture();
    try {
      const before = await readFile(workflowFilePath(app.sessionFile), "utf8");
      const result = await mutateWorkflow(app.location, app.owner, unchangedMutation, {
        requireVersion: 2,
        io: {
          [stage]: async () => {
            throw Object.assign(new Error("Backup failed"), { code: "ENOSPC" });
          },
        },
      });

      expect(expectError(result).code).toBe("STORAGE_FAILED");
      expect(await readFile(workflowFilePath(app.sessionFile), "utf8")).toBe(before);
      // Directory fsync may fail after atomic publication, but no partial backup is visible.
      expect(await migrationBackups(app.root)).toHaveLength(stage === "syncDirectory" ? 1 : 0);
      if (stage === "syncDirectory")
        expect(await readFile(workflowBackupFilePath(app.sessionFile), "utf8")).toBe(before);
      expect((await readdir(app.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Old HEAD Literal(1) reader rejects migrated v2 without a write", async () => {
  // Frozen from task-workflow.ts at 5bffe795332c7976ba4c5e476909e5302f65b66f, not the new union.
  const app = await fixture();
  try {
    expectOk(
      await mutateWorkflow(app.location, app.owner, unchangedMutation, { requireVersion: 2 }),
    );
    const path = workflowFilePath(app.sessionFile);
    const before = await readFile(path, "utf8");
    const fingerprint = await stat(path);
    let writes = 0;
    const oldReader = (value: unknown) =>
      Value.Check(Type.Unsafe(oldWorkflowSchema), value)
        ? unchangedMutation(value as WorkflowDocument)
        : err(new WorkflowError("WORKFLOW_CONFLICT", "Invalid or unsupported workflow document."));
    expect(oldReader(app.doc).ok).toBe(true);
    expect(JSON.parse(JSON.stringify(workflowDocumentV1Schema))).toEqual(oldWorkflowSchema);

    const rejected = await mutateWorkflow(app.location, app.owner, oldReader, {
      io: {
        write: async () => {
          writes++;
        },
      },
    });

    expect(expectError(rejected).code).toBe("WORKFLOW_CONFLICT");
    expect(writes).toBe(0);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await stat(path)).ino).toBe(fingerprint.ino);
  } finally {
    await app.close();
  }
});

test("Migration preserves the permanent three-failure lock, attempts and receipts on disk", async () => {
  const app = await fixture();
  try {
    expectOk(
      await mutateWorkflow(app.location, app.owner, (doc) =>
        recordFinding(doc!, {
          ...event(),
          binding: app.binding("verifier"),
          defectId: "locked",
          revision: 0,
          summary: "Failed",
          evidence: "QA",
        }),
      ),
    );
    for (let index = 1; index <= 3; index++) {
      const attemptId = `attempt-${index}`;
      expectOk(
        await mutateWorkflow(app.location, app.owner, (doc) =>
          admitRepair(doc!, {
            ...event(),
            binding: app.binding("lead"),
            defectId: "locked",
            attemptId,
          }),
        ),
      );
      const submitted = expectOk(
        await mutateWorkflow(app.location, app.owner, (doc) =>
          submitFix(doc!, {
            ...event(),
            binding: app.binding("implementer"),
            defectId: "locked",
            attemptId,
          }),
        ),
      );
      expectOk(
        await mutateWorkflow(app.location, app.owner, (doc) =>
          recordVerdict(doc!, {
            ...event(),
            binding: app.binding("verifier"),
            defectId: "locked",
            attemptId,
            revision: submitted.doc.tasks["task-primary"]!.artifactRevision,
            verdict: "fail",
            evidence: "QA failed",
          }),
        ),
      );
    }
    const before = expectOk(await openWorkflow(app.sessionFile, app.owner))!.doc;
    const tamperings: [string, (doc: WorkflowDocument) => void][] = [
      [
        "defect deletion",
        (doc) => {
          delete doc.defects.locked;
        },
      ],
      [
        "counter decrease",
        (doc) => {
          doc.defects.locked!.automatedFailures = 2;
        },
      ],
      [
        "lock reset",
        (doc) => {
          doc.defects.locked!.locked = false;
        },
      ],
      [
        "attempt deletion",
        (doc) => {
          doc.defects.locked!.attempts.pop();
        },
      ],
      [
        "receipt deletion",
        (doc) => {
          delete doc.processed[Object.keys(doc.processed)[0]!];
        },
      ],
    ];
    async function rejectsErasure(requireVersion?: 2) {
      const contents = await readFile(workflowFilePath(app.sessionFile), "utf8");
      const backups = await migrationBackups(app.root);
      for (const [name, tamper] of tamperings) {
        const rejected = await mutateWorkflow(
          app.location,
          app.owner,
          (doc) => {
            tamper(doc!);
            doc!.revision++;
            return unchangedMutation(doc);
          },
          requireVersion ? { requireVersion } : undefined,
        );
        expect(expectError(rejected).code, name).toBe("WORKFLOW_CONFLICT");
        expect(await readFile(workflowFilePath(app.sessionFile), "utf8"), name).toBe(contents);
        expect(await migrationBackups(app.root)).toEqual(backups);
      }
    }
    await rejectsErasure(2);
    const migrated = expectOk(
      await mutateWorkflow(app.location, app.owner, unchangedMutation, { requireVersion: 2 }),
    ).doc;

    expect(migrated).toEqual({ ...before, version: 2, revision: before.revision + 1 });
    expect(migrated.defects.locked!.locked).toBe(true);
    expect(migrated.defects.locked!.automatedFailures).toBe(3);
    await rejectsErasure();
    expect(
      expectError(
        await mutateWorkflow(app.location, app.owner, (doc) =>
          admitRepair(doc!, {
            ...event(),
            binding: app.binding("lead"),
            defectId: "locked",
            attemptId: "fourth",
          }),
        ),
      ).code,
    ).toBe("WORKFLOW_REPAIR_LOCKED");
  } finally {
    await app.close();
  }
});

test("Concurrent scheduler migration is serialized and only writes one backup and revision", async () => {
  const app = await fixture();
  try {
    const results = await Promise.all(
      [0, 1].map(() =>
        mutateWorkflow(app.location, app.owner, unchangedMutation, { requireVersion: 2 }),
      ),
    );

    expect(results.map((result) => expectOk(result).doc.revision)).toEqual([1, 1]);
    expect(await migrationBackups(app.root)).toHaveLength(1);
    expect(
      expectError(
        await mutateWorkflow(app.location, app.owner, unchangedMutation, {
          requireVersion: 2,
          expectedRevision: 0,
        }),
      ).code,
    ).toBe("WORKFLOW_CONFLICT");
  } finally {
    await app.close();
  }
});

test.each(["scheduler", "schedule"] as const)(
  "Corrupt v2 %s fails closed without invoking policy or writing",
  async (kind) => {
    const app = await fixture();
    try {
      const doc = migrateWorkflowToV2(app.doc);
      const corrupt =
        kind === "scheduler"
          ? { ...doc, scheduler: { invocations: [], admissions: [], consents: {} } }
          : {
              ...doc,
              tasks: {
                ...doc.tasks,
                "task-primary": {
                  ...doc.tasks["task-primary"],
                  schedule: { state: "unknown", since: 0 },
                },
              },
            };
      const before = JSON.stringify(corrupt);
      await writeFile(workflowFilePath(app.sessionFile), before);
      let calls = 0;

      expect(expectError(validateWorkflowDocument(corrupt)).code).toBe("WORKFLOW_CONFLICT");
      expect(expectError(await openWorkflow(app.sessionFile, app.owner)).code).toBe(
        "STORAGE_FAILED",
      );
      expect(
        expectError(
          await mutateWorkflow(
            app.location,
            app.owner,
            (current) => {
              calls++;
              return unchangedMutation(current);
            },
            { requireVersion: 2 },
          ),
        ).code,
      ).toBe("STORAGE_FAILED");
      expect(calls).toBe(0);
      expect(await readFile(workflowFilePath(app.sessionFile), "utf8")).toBe(before);
      expect(await migrationBackups(app.root)).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Migration and the first scheduler reservation share exactly one commit", async () => {
  const app = await fixture();
  try {
    const snapshot = expectOk(
      resolveEffectiveProfile("engineer", {
        overlays: [],
        projectTrusted: false,
      }),
    ).effectiveProfile;
    const migrated = expectOk(
      await mutateWorkflow(
        app.location,
        app.owner,
        (doc) => {
          if (doc?.version !== 2) throw new Error("Scheduler must receive v2 before mutation");
          doc.revision++;
          doc.scheduler = {
            invocations: [{ id: "first", kind: "plan", state: "active", createdAt: 1 }],
            admissions: {
              operation: {
                taskId: "task-primary",
                role: "implementer",
                assignmentVersion: 0,
                frozenInputs: [],
                effectiveProfile: snapshot,
                state: "running",
                runId: "one-run",
              },
            },
            consents: {},
          };
          doc.processed.reservation = { docRevision: doc.revision, outcome: { kind: "applied" } };
          return ok({ doc, effects: [], outcome: { kind: "applied" } });
        },
        { requireVersion: 2 },
      ),
    ).doc;

    expect(migrated.revision).toBe(1);
    expect(migrated.processed.reservation!.docRevision).toBe(1);
    expect(expectOk(await openWorkflow(app.sessionFile, app.owner))!.doc).toEqual(migrated);

    // An operation cannot acquire another run or lose its original durable identity.
    const before = await readFile(workflowFilePath(app.sessionFile), "utf8");
    for (const replacement of ["second-run", undefined]) {
      const rejected = await mutateWorkflow(app.location, app.owner, (doc) => {
        if (doc?.version !== 2) throw new Error("Expected v2");
        doc.revision++;
        if (replacement === undefined) delete doc.scheduler!.admissions.operation!.runId;
        else doc.scheduler!.admissions.operation!.runId = replacement;
        return ok({ doc, effects: [], outcome: { kind: "applied" } });
      });
      expect(expectError(rejected).code).toBe("WORKFLOW_CONFLICT");
      expect(await readFile(workflowFilePath(app.sessionFile), "utf8")).toBe(before);
    }
  } finally {
    await app.close();
  }
});

test("Migration fingerprint checks refuse replacement that races with backup creation", async () => {
  const app = await fixture();
  try {
    const path = workflowFilePath(app.sessionFile);
    const external = JSON.stringify({ ...app.doc, revision: 42 });
    let wroteBackup = false;
    const result = await mutateWorkflow(app.location, app.owner, unchangedMutation, {
      requireVersion: 2,
      io: {
        write: async (file, text) => {
          await file.writeFile(text);
          if (!wroteBackup) {
            wroteBackup = true;
            await writeFile(path, external);
          }
        },
      },
    });

    expect(expectError(result).code).toBe("WORKFLOW_CONFLICT");
    expect(await readFile(path, "utf8")).toBe(external);
    const backups = await migrationBackups(app.root);
    expect(backups).toHaveLength(1);
    expect(JSON.parse(await readFile(join(app.root, backups[0]!), "utf8"))).toEqual(app.doc);
    expect((await readdir(app.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  } finally {
    await app.close();
  }
});

test("v2 history guards preserve v1 repair, human, linked-task and recovery policy behavior", async () => {
  const app = await fixture();
  try {
    let baseline = structuredClone(app.doc);
    // Align document revision accounting with the one migration-only commit.
    baseline.revision++;
    expectOk(
      await mutateWorkflow(app.location, app.owner, unchangedMutation, { requireVersion: 2 }),
    );
    async function apply(policy: (doc: WorkflowDocument) => WorkflowPolicyResult) {
      baseline = expectOk(policy(baseline)).doc;
      const actual = expectOk(
        await mutateWorkflow(app.location, app.owner, (doc) => policy(doc!)),
      ).doc;
      expect(actual).toEqual({ ...baseline, version: 2 });
      return actual;
    }
    const bind = (
      doc: WorkflowDocument,
      role: WorkflowBinding["role"],
      taskId = "task-primary",
    ): WorkflowBinding => ({
      workflowId: doc.workflowId,
      taskId,
      role,
      assignmentVersion: doc.tasks[taskId]!.assignmentVersion,
    });
    const discovery = {
      ...event(),
      defectId: "parity",
      revision: 0,
      summary: "Issue",
      evidence: "QA",
    };
    await apply((doc) => recordFinding(doc, { ...discovery, binding: bind(doc, "verifier") }));

    // Recovery interrupts authorization without spending a failure or deleting the attempt.
    const interrupted = { ...event(), defectId: "parity", attemptId: "restart" };
    await apply((doc) => admitRepair(doc, { ...interrupted, binding: bind(doc, "lead") }));
    const recovery = event();
    const recovered = await apply((doc) => recoverWorkflow(doc, recovery));
    expect(recovered.defects.parity!.automatedFailures).toBe(0);
    expect(recovered.defects.parity!.attempts[0]!.status).toBe("interrupted");

    for (let index = 1; index <= 3; index++) {
      const admission = { ...event(), defectId: "parity", attemptId: `parity-${index}` };
      await apply((doc) => admitRepair(doc, { ...admission, binding: bind(doc, "lead") }));
      const submission = { ...event(), defectId: "parity", attemptId: admission.attemptId };
      await apply((doc) => submitFix(doc, { ...submission, binding: bind(doc, "implementer") }));
      const verdict = {
        ...event(),
        defectId: "parity",
        attemptId: admission.attemptId,
        verdict: "fail" as const,
        evidence: "Failed QA",
      };
      const failed = await apply((doc) =>
        recordVerdict(doc, {
          ...verdict,
          binding: bind(doc, "verifier"),
          revision: doc.tasks["task-primary"]!.artifactRevision,
        }),
      );
      expect(failed.defects.parity!.automatedFailures).toBe(index);
      expect(failed.defects.parity!.locked).toBe(index === 3);
    }
    const assignment = {
      ...event(),
      taskId: "task-primary",
      role: "verifier" as const,
      profile: "new-qa",
    };
    await apply((doc) => reassign(doc, assignment));
    const task = { ...structuredClone(baseline.tasks["task-primary"]!), id: "split" };
    const split = { ...event(), taskId: "task-primary", task };
    await apply((doc) => splitTask(doc, split));
    const continuation = { ...event(), taskId: "split", task: { ...task, id: "continued" } };
    await apply((doc) => continueTask(doc, continuation));

    const provenance = userCommandProvenance(app.owner.conversationId, 2000);
    const recheck = { ...event(), provenance, id: "task-primary", attemptId: "manual" };
    await apply((doc) => humanRecheck(doc, recheck));
    const pass = {
      ...event(),
      defectId: "parity",
      attemptId: "manual",
      verdict: "pass" as const,
      evidence: "Manual QA passed",
    };
    await apply((doc) =>
      recordVerdict(doc, {
        ...pass,
        binding: bind(doc, "verifier"),
        revision: doc.tasks["task-primary"]!.artifactRevision,
      }),
    );
    const cancelSplit = { ...event(), provenance, id: "split" };
    await apply((doc) => humanCancel(doc, cancelSplit));
    const cancelContinued = { ...event(), provenance, id: "continued" };
    const resolved = await apply((doc) => humanCancel(doc, cancelContinued));
    expect(resolved.defects.parity!.state).toBe("resolved");
    expect(resolved.defects.parity!.locked).toBe(true);
    expect(resolved.defects.parity!.automatedFailures).toBe(3);
  } finally {
    await app.close();
  }
});

test("Q06 queued concurrent admissions re-read the canonical document and admit only once", async () => {
  // Both callers race against one failed revision; neither may launch before a committed admission.
  const app = await fixture();
  try {
    expectOk(
      await mutateWorkflow(app.location, app.owner, (doc) =>
        recordFinding(doc!, {
          ...event(),
          binding: app.binding("verifier"),
          defectId: "defect-primary",
          revision: 0,
          summary: "Failed",
          evidence: "qa",
        }),
      ),
    );

    const results = await Promise.all(
      ["attempt-a", "attempt-b"].map((attemptId) =>
        mutateWorkflow(app.location, app.owner, (doc) =>
          admitRepair(doc!, {
            ...event(),
            binding: app.binding("lead"),
            defectId: "defect-primary",
            attemptId,
          }),
        ),
      ),
    );
    const reopened = expectOk(await openWorkflow(app.sessionFile, app.owner))!;

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map((result) => result.error.code)).toEqual([
      "WORKFLOW_CONFLICT",
    ]);
    expect(reopened.doc.defects["defect-primary"]!.attempts).toHaveLength(1);
    expect((await stat(workflowFilePath(app.sessionFile))).mode & 0o777).toBe(0o600);
  } finally {
    await app.close();
  }
});

test.each(["write", "sync", "rename"] as const)(
  "Q08 %s failure releases no effects and preserves the prior document",
  async (stage) => {
    // Fail before replacement, after a previously durable document already exists.
    const app = await fixture();
    try {
      const before = await readFile(workflowFilePath(app.sessionFile), "utf8");
      const failure = async () => {
        throw Object.assign(new Error("Injected storage failure"), { code: "ENOSPC" });
      };
      const io: Partial<WorkflowWriteIO> = { [stage]: failure };

      const result = await mutateWorkflow(
        app.location,
        app.owner,
        (doc) =>
          recordFinding(doc!, {
            ...event(),
            binding: app.binding("verifier"),
            defectId: "defect-primary",
            revision: 0,
            summary: "Failed",
            evidence: "qa",
          }),
        { io },
      );

      expect(expectError(result).code).toBe("STORAGE_FAILED");
      expect("value" in result).toBe(false);
      expect(await readFile(workflowFilePath(app.sessionFile), "utf8")).toBe(before);
      expect(expectOk(await openWorkflow(app.sessionFile, app.owner))!.doc.revision).toBe(0);
    } finally {
      await app.close();
    }
  },
);

test("Q08 post-rename directory fsync failure is uncertain but deduplicated on retry", async () => {
  // A directory-sync failure cannot promise rollback after rename already succeeded.
  const app = await fixture();
  try {
    const command = {
      ...event(),
      binding: app.binding("verifier"),
      defectId: "defect-primary",
      revision: 0,
      summary: "Failed",
      evidence: "qa",
    };
    const mutate = (doc: WorkflowDocument | null) => recordFinding(doc!, command);

    const failed = await mutateWorkflow(app.location, app.owner, mutate, {
      io: {
        syncDirectory: async () => {
          throw Object.assign(new Error("Injected fsync failure"), { code: "EIO" });
        },
      },
    });
    const retry = expectOk(await mutateWorkflow(app.location, app.owner, mutate));

    expect(expectError(failed).code).toBe("STORAGE_FAILED");
    expect(retry.doc.revision).toBe(1);
    expect(Object.keys(retry.doc.defects)).toEqual(["defect-primary"]);
    expect(retry.effects).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["corrupt", "unknown-version", "foreign-owner", "symlink"])(
  "Q08 %s sidecar is an error, never an empty workflow",
  async (kind) => {
    // A readable-looking but untrusted sidecar must not reset retry counters.
    const app = await fixture();
    try {
      const path = workflowFilePath(app.sessionFile);
      if (kind === "corrupt") await writeFile(path, "{broken");
      if (kind === "unknown-version")
        await writeFile(path, JSON.stringify({ ...app.doc, version: 3 }));
      if (kind === "foreign-owner")
        await writeFile(
          path,
          JSON.stringify({ ...app.doc, origin: { ...app.doc.origin, conversationId: "stranger" } }),
        );
      if (kind === "symlink") {
        const target = join(app.root, "target");
        await writeFile(target, JSON.stringify(app.doc), { mode: 0o600 });
        await rm(path);
        await symlink(target, path);
      }
      let invoked = false;

      const opened = await openWorkflow(app.sessionFile, app.owner);
      const mutation = await mutateWorkflow(app.location, app.owner, () => {
        invoked = true;
        return ok({ doc: app.doc, effects: [], outcome: { kind: "applied" } });
      });

      expect(expectError(opened).code).toBe("STORAGE_FAILED");
      expect(expectError(mutation).code).toBe("STORAGE_FAILED");
      expect(invoked).toBe(false);
    } finally {
      await app.close();
    }
  },
);

test("Q09 opening a member link returns canonical state and survives origin SDK retention", async () => {
  // Continuations keep a link, not a second independently mutable workflow document.
  const app = await fixture();
  try {
    const next = await app.continuation();

    const direct = expectOk(await openWorkflow(app.sessionFile, app.owner))!;
    const linked = expectOk(await openWorkflow(next.sessionFile, next.owner))!;
    await rm(app.sessionFile);
    const afterRetention = expectOk(await openWorkflow(next.sessionFile, next.owner))!;
    const mutation = expectOk(
      await mutateWorkflow(linked.location, direct.doc.origin, (doc) =>
        recordFinding(doc!, {
          ...event(),
          binding: app.binding("verifier"),
          defectId: "defect-primary",
          revision: 0,
          summary: "Failed",
          evidence: "qa",
        }),
      ),
    );

    expect(linked).toEqual(direct);
    expect(afterRetention.doc.workflowId).toBe(app.doc.workflowId);
    expect(mutation.doc.defects["defect-primary"]!.automatedFailures).toBe(0);
    expect(await Bun.file(workflowFilePath(next.sessionFile)).exists()).toBe(false);
  } finally {
    await app.close();
  }
});

test("Q09 forged links cannot grant membership even with a real SDK session", async () => {
  // Copying a valid-looking link is not equivalent to a host-authorized continuation.
  const app = await fixture();
  try {
    const sessionFile = join(app.root, "forged.jsonl");
    const owner = { conversationId: "forged", cwd: app.cwd };
    await writeFile(
      sessionFile,
      JSON.stringify({ type: "session", id: owner.conversationId, cwd: owner.cwd }) + "\n",
    );
    await writeFile(
      workflowLinkFilePath(sessionFile),
      JSON.stringify({
        workflowId: app.doc.workflowId,
        originSessionFile: app.sessionFile,
        originOwner: app.owner,
        owner,
      }),
      { mode: 0o600 },
    );

    const opened = await openWorkflow(sessionFile, owner);
    const linked = await writeWorkflowLink(sessionFile, owner, app.location, app.owner);

    expect(expectError(opened).code).toBe("STORAGE_FAILED");
    expect(expectError(linked).code).toBe("WORKFLOW_NOT_AUTHORIZED");
  } finally {
    await app.close();
  }
});

test("Q17 live continuation retains the origin; purging a continuation removes only its link", async () => {
  // The origin's safety ledger remains authoritative while any live continuation refers back.
  const app = await fixture();
  try {
    const next = await app.continuation();

    const retained = expectOk(await deleteWorkflowForPurge(app.sessionFile, app.owner));
    const removedLink = expectOk(await deleteWorkflowForPurge(next.sessionFile, next.owner));
    const removedOrigin = expectOk(await deleteWorkflowForPurge(app.sessionFile, app.owner));

    expect(retained).toBe("retained");
    expect(removedLink).toBe("removed");
    expect(removedOrigin).toBe("removed");
    expect(await Bun.file(workflowLinkFilePath(next.sessionFile)).exists()).toBe(false);
    expect(await Bun.file(next.sessionFile).exists()).toBe(true);
  } finally {
    await app.close();
  }
});

test("Q17 fingerprint race refuses removal of a replaced workflow", async () => {
  // A retention reservation authorizes only the inspected file, not later bytes at its path.
  const app = await fixture();
  try {
    const inspected = expectOk(await inspectWorkflowForRetention(app.sessionFile, app.owner));
    await writeFile(
      workflowFilePath(app.sessionFile),
      JSON.stringify({ ...app.doc, log: [{ at: 100, eventKey: "race", message: "Replaced" }] }),
    );

    const checked = await recheckWorkflowForRetention(app.sessionFile, app.owner, inspected);
    const deleted = await deleteWorkflowForRetention(app.sessionFile, app.owner, inspected);

    expect(expectError(checked).code).toBe("STORAGE_FAILED");
    expect(expectError(deleted).code).toBe("STORAGE_FAILED");
    expect(await Bun.file(workflowFilePath(app.sessionFile)).exists()).toBe(true);
  } finally {
    await app.close();
  }
});

test("Q08 optimistic revision conflicts do not invoke the mutation callback", async () => {
  // A stale host operation cannot overwrite a later committed state.
  const app = await fixture();
  try {
    let invoked = false;

    const result = await mutateWorkflow(
      app.location,
      app.owner,
      () => {
        invoked = true;
        return ok({ doc: app.doc, effects: [], outcome: { kind: "applied" } });
      },
      { expectedRevision: 9 },
    );

    expect(expectError(result).code).toBe("WORKFLOW_CONFLICT");
    expect(invoked).toBe(false);
  } finally {
    await app.close();
  }
});

test("Q09 linking a conversation already in another workflow returns a conflict", async () => {
  // Canonical self-join membership does not authorize replacing an existing workflow link.
  const app = await fixture();
  const other = await fixture();
  try {
    const next = await app.continuation();
    const before = await readFile(workflowLinkFilePath(next.sessionFile), "utf8");
    expectOk(
      await mutateWorkflow(other.location, other.owner, (doc) =>
        addContinuationMember(doc!, {
          ...event(),
          provenance: userCommandProvenance(next.owner.conversationId, 100),
          member: { ...next.owner, sessionFile: next.sessionFile },
        }),
      ),
    );

    const result = await writeWorkflowLink(
      next.sessionFile,
      next.owner,
      other.location,
      other.owner,
    );

    expect(expectError(result).code).toBe("WORKFLOW_CONFLICT");
    expect(await readFile(workflowLinkFilePath(next.sessionFile), "utf8")).toBe(before);
    expect(expectOk(await openWorkflow(next.sessionFile, next.owner))!.location).toEqual(
      app.location,
    );
  } finally {
    await app.close();
    await other.close();
  }
});

test("Q17 unlink failures preserve the workflow and remain retryable", async () => {
  // Permission failure is not proof of removal and must never be reported as successful cleanup.
  const app = await fixture();
  try {
    const inspected = expectOk(await inspectWorkflowForRetention(app.sessionFile, app.owner));
    const unlink = spyOn(fs, "unlink").mockRejectedValueOnce(
      Object.assign(new Error("Injected permission failure"), { code: "EACCES" }),
    );
    let result;
    try {
      result = await deleteWorkflowForRetention(app.sessionFile, app.owner, inspected);
    } finally {
      unlink.mockRestore();
    }

    expect(expectError(result).code).toBe("STORAGE_FAILED");
    expect(await Bun.file(workflowFilePath(app.sessionFile)).exists()).toBe(true);
    expect(expectOk(await deleteWorkflowForRetention(app.sessionFile, app.owner, inspected))).toBe(
      "removed",
    );
  } finally {
    await app.close();
  }
});
