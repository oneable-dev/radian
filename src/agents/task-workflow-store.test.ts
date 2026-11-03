import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../result.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { userCommandProvenance } from "./repair-command.ts";
import {
  createWorkflowDocument,
  type WorkflowBinding,
  type WorkflowDocument,
} from "./task-workflow.ts";
import {
  deleteWorkflowForPurge,
  deleteWorkflowForRetention,
  inspectWorkflowForRetention,
  mutateWorkflow,
  openWorkflow,
  recheckWorkflowForRetention,
  workflowFilePath,
  workflowLinkFilePath,
  writeWorkflowLink,
  type WorkflowWriteIO,
} from "./task-workflow-store.ts";
import {
  addContinuationMember,
  admitRepair,
  recordFinding,
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
        await writeFile(path, JSON.stringify({ ...app.doc, version: 2 }));
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
