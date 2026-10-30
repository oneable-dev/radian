import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectError, expectOk } from "../testing/results.ts";
import {
  clearTaskPlan,
  parseStoredTaskPlan,
  planFilePath,
  readTaskPlan,
  saveTaskPlan,
  type PlanOwner,
} from "./task-plan-store.ts";

const plan = {
  schemaVersion: 1,
  goal: "Ship one task",
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  tasks: [
    {
      id: "first",
      title: "Implement",
      agent: "implementer",
      dependsOn: [],
      inputs: [],
      outputs: ["Working sidecar"],
      acceptanceCriteria: ["Pass the tests"],
      files: ["src/agents/task-plan-store.ts"],
    },
  ],
};
const review = { summary: "Reviewed the task graph", warnings: [] };

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "radian-plan-")));
  const sessionFile = join(root, "conversation.jsonl");
  const owner: PlanOwner = { conversationId: "conversation", cwd: root };
  await writeFile(
    sessionFile,
    JSON.stringify({ type: "session", id: owner.conversationId, cwd: root }) + "\n",
  );
  return { root, sessionFile, owner, close: () => rm(root, { recursive: true, force: true }) };
}

test("A validated plan saves privately, replaces its predecessor, and clears idempotently", async () => {
  // A verified SDK session owns one adjacent plan, never a revision directory.
  const app = await fixture();
  try {
    // Successive writes retain only the latest review and hash.
    const first = expectOk(await saveTaskPlan(app.sessionFile, app.owner, plan, review));
    const latest = expectOk(
      await saveTaskPlan(app.sessionFile, app.owner, plan, { ...review, summary: "Updated" }),
    );

    // The sidecar is private and remains a single complete record.
    expect(planFilePath(app.sessionFile)).toBe(app.sessionFile + ".plan.json");
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(expectOk(await readTaskPlan(app.sessionFile, app.owner))).toEqual(latest);
    expect((await stat(planFilePath(app.sessionFile))).mode & 0o777).toBe(0o600);
    expectOk(await clearTaskPlan(app.sessionFile, app.owner));
    expectOk(await clearTaskPlan(app.sessionFile, app.owner));
    expect(expectOk(await readTaskPlan(app.sessionFile, app.owner))).toBeNull();
  } finally {
    await app.close();
  }
});

test("Concurrent saves serialize and return the final review without partial JSON", async () => {
  // Multiple commands may arrive before the first write completes.
  const app = await fixture();
  try {
    // Queue two replacements at the same sidecar path.
    const results = await Promise.all([
      saveTaskPlan(app.sessionFile, app.owner, plan, review),
      saveTaskPlan(app.sessionFile, app.owner, plan, { ...review, summary: "Last request" }),
    ]);

    // The last invocation wins and the on-disk record parses successfully.
    results.forEach(expectOk);
    expect(JSON.parse(await readFile(planFilePath(app.sessionFile), "utf8")).review.summary).toBe(
      "Last request",
    );
  } finally {
    await app.close();
  }
});

test("Invalid review or dependency graph cannot replace an existing plan", async () => {
  // An existing valid report must survive rejected inputs.
  const app = await fixture();
  try {
    const original = expectOk(await saveTaskPlan(app.sessionFile, app.owner, plan, review));

    // Reject an incomplete review and a cyclic task before any write.
    expect(
      expectError(
        await saveTaskPlan(app.sessionFile, app.owner, plan, { summary: "  ", warnings: [] }),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(
      expectError(
        await saveTaskPlan(
          app.sessionFile,
          app.owner,
          { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["first"] }] },
          review,
        ),
      ).code,
    ).toBe("INVALID_INPUT");

    // Failed validation does not modify previously saved data.
    expect(expectOk(await readTaskPlan(app.sessionFile, app.owner))).toEqual(original);
  } finally {
    await app.close();
  }
});

test("An oversized but valid plan is rejected before replacing the previous sidecar", async () => {
  // Bounded fields can still form a serialized graph larger than the sidecar read limit.
  const app = await fixture();
  try {
    expectOk(await saveTaskPlan(app.sessionFile, app.owner, plan, review));
    const before = await readFile(planFilePath(app.sessionFile), "utf8");
    const text = "x".repeat(2048);
    const oversized = {
      ...plan,
      tasks: Array.from({ length: 128 }, (_, index) => ({
        ...plan.tasks[0]!,
        id: `task-${index}`,
        outputs: Array(9).fill(text),
      })),
    };

    // A graph that passes structural validation but exceeds 2 MiB cannot be saved.
    const rejected = await saveTaskPlan(app.sessionFile, app.owner, oversized, review);

    // Keep the old bytes readable and unchanged; do not write an unreadable valid record.
    expect(expectError(rejected).code).toBe("INVALID_INPUT");
    expect(await readFile(planFilePath(app.sessionFile), "utf8")).toBe(before);
    expect(expectOk(await readTaskPlan(app.sessionFile, app.owner))?.review.summary).toBe(
      review.summary,
    );
  } finally {
    await app.close();
  }
});

test("Corrupt, tampered, and mismatched records cannot be read, overwritten, or removed", async () => {
  // Sidecar contents are an untrusted filesystem input even under a private directory.
  const app = await fixture();
  try {
    const saved = expectOk(await saveTaskPlan(app.sessionFile, app.owner, plan, review));
    const mismatched = { ...app.owner, conversationId: "someone-else" };
    expect(expectError(await readTaskPlan(app.sessionFile, mismatched)).code).toBe(
      "STORAGE_FAILED",
    );
    expect(expectError(await clearTaskPlan(app.sessionFile, mismatched)).code).toBe(
      "STORAGE_FAILED",
    );

    // Alter the plan without updating its hash, then try every destructive API.
    const tampered = { ...saved, plan: { ...saved.plan, goal: "Altered" } };
    await writeFile(planFilePath(app.sessionFile), JSON.stringify(tampered));
    expect(expectError(parseStoredTaskPlan(tampered, app.owner)).code).toBe("STORAGE_FAILED");
    expect(expectError(await readTaskPlan(app.sessionFile, app.owner)).code).toBe("STORAGE_FAILED");
    expect(expectError(await saveTaskPlan(app.sessionFile, app.owner, plan, review)).code).toBe(
      "STORAGE_FAILED",
    );
    expect(expectError(await clearTaskPlan(app.sessionFile, app.owner)).code).toBe(
      "STORAGE_FAILED",
    );
    expect(await readFile(planFilePath(app.sessionFile), "utf8")).toBe(JSON.stringify(tampered));
  } finally {
    await app.close();
  }
});

test("A replaced SDK owner or public sidecar cannot authorize reading or removal", async () => {
  // A valid saved envelope may become stale if the SDK original is replaced externally.
  const app = await fixture();
  try {
    expectOk(await saveTaskPlan(app.sessionFile, app.owner, plan, review));
    const sidecar = planFilePath(app.sessionFile);

    // Reject a sidecar whose permissions changed rather than exposing private plan data.
    await chmod(sidecar, 0o644);
    expect(expectError(await readTaskPlan(app.sessionFile, app.owner)).code).toBe("STORAGE_FAILED");
    expect(expectError(await clearTaskPlan(app.sessionFile, app.owner)).code).toBe(
      "STORAGE_FAILED",
    );
    await chmod(sidecar, 0o600);

    // Valid sidecar metadata does not override a changed SDK session identity.
    await writeFile(
      app.sessionFile,
      JSON.stringify({ type: "session", id: "other", cwd: app.root }) + "\n",
    );
    expect(expectError(await readTaskPlan(app.sessionFile, app.owner)).code).toBe("STORAGE_FAILED");
    expect(expectError(await clearTaskPlan(app.sessionFile, app.owner)).code).toBe(
      "STORAGE_FAILED",
    );
    expect(await Bun.file(sidecar).exists()).toBe(true);
  } finally {
    await app.close();
  }
});

test("Symlinks, mismatched SDK headers, and nonexistent parent paths do not create sidecars", async () => {
  // A caller-supplied path must not become an arbitrary write target.
  const app = await fixture();
  try {
    const target = join(app.root, "target");
    await writeFile(target, "private target");
    await symlink(target, planFilePath(app.sessionFile));

    // A sidecar symlink is never followed or overwritten.
    expect(expectError(await saveTaskPlan(app.sessionFile, app.owner, plan, review)).code).toBe(
      "STORAGE_FAILED",
    );
    expect(await readFile(target, "utf8")).toBe("private target");
    await rm(planFilePath(app.sessionFile));
    await writeFile(
      app.sessionFile,
      JSON.stringify({ type: "session", id: "other", cwd: app.root }) + "\n",
    );
    expect(expectError(await saveTaskPlan(app.sessionFile, app.owner, plan, review)).code).toBe(
      "STORAGE_FAILED",
    );
    expect(
      expectError(await saveTaskPlan(join(app.root, "missing", "x.jsonl"), app.owner, plan, review))
        .code,
    ).toBe("STORAGE_FAILED");
  } finally {
    await app.close();
  }
});
