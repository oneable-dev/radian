import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  capture,
  InputError,
  parseJson,
  StorageError,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { validateTaskPlan, type TaskPlan } from "./task-plan.ts";

export type PlanOwner = { conversationId: string; cwd: string };
export type PlanReview = { summary: string; warnings: string[] };
export type StoredTaskPlan = {
  version: 1;
  owner: PlanOwner;
  updatedAt: number;
  hash: string;
  plan: TaskPlan;
  review: PlanReview;
};

export const planReviewSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" }),
    warnings: Type.Array(Type.String({ minLength: 1, maxLength: 2048, pattern: "\\S" }), {
      maxItems: 128,
    }),
  },
  { additionalProperties: false },
);

const maxSidecarBytes = 2 * 1024 * 1024;
const hashPlan = (plan: TaskPlan) =>
  createHash("sha256").update(JSON.stringify(plan)).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function validOwner(owner: PlanOwner): boolean {
  return (
    typeof owner.conversationId === "string" &&
    owner.conversationId.length > 0 &&
    typeof owner.cwd === "string" &&
    owner.cwd.length > 0 &&
    isAbsolute(owner.cwd) &&
    !owner.cwd.includes("\0")
  );
}

export function parseStoredTaskPlan(
  value: unknown,
  owner: PlanOwner,
): Result<StoredTaskPlan, ExpectedError> {
  if (!validOwner(owner)) {
    return err(new InputError("Invalid task plan owner."));
  }
  if (
    !isObject(value) ||
    !hasKeys(value, ["version", "owner", "updatedAt", "hash", "plan", "review"]) ||
    value.version !== 1 ||
    !isObject(value.owner) ||
    !hasKeys(value.owner, ["conversationId", "cwd"]) ||
    value.owner.conversationId !== owner.conversationId ||
    value.owner.cwd !== owner.cwd ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.updatedAt as number) < 0 ||
    typeof value.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.hash)
  ) {
    return err(new StorageError("Invalid or mismatched task plan sidecar."));
  }

  const plan = validateTaskPlan(value.plan);
  if (!plan.ok) {
    return err(new StorageError("Invalid task plan in sidecar.", undefined, { cause: plan.error }));
  }
  if (!Value.Check(planReviewSchema, value.review) || hashPlan(plan.value) !== value.hash) {
    return err(new StorageError("Invalid or tampered task plan review or hash."));
  }

  return ok({
    version: 1,
    owner: { conversationId: owner.conversationId, cwd: owner.cwd },
    updatedAt: value.updatedAt as number,
    hash: value.hash,
    plan: plan.value,
    review: value.review,
  });
}

export function planFilePath(sessionFile: string): string {
  return sessionFile + ".plan.json";
}

type FileFingerprint = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
export type InspectedTaskPlan =
  | { kind: "absent" }
  | { kind: "ready"; fingerprint: FileFingerprint; updatedAt: number };

function fingerprint(stat: import("node:fs").Stats): FileFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFile(a: FileFingerprint, b: FileFingerprint): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

async function verifyParent(sessionFile: string): Promise<Result<void, ExpectedError>> {
  if (!isAbsolute(sessionFile) || sessionFile.includes("\0")) {
    return err(new InputError("Task plan requires an absolute SDK session file path."));
  }
  const directory = dirname(sessionFile);
  const found = await capture(() => lstat(directory));
  if (!found.ok) {
    return found;
  }
  if (
    !found.value.isDirectory() ||
    found.value.isSymbolicLink() ||
    (process.getuid && found.value.uid !== process.getuid())
  ) {
    return err(new StorageError("Task plan session directory is not owned by this user."));
  }
  const canonical = await capture(() => realpath(directory));
  if (!canonical.ok) {
    return canonical;
  }
  if (canonical.value !== resolve(directory)) {
    return err(new StorageError("Task plan session directory has a symbolic location."));
  }

  return ok(undefined);
}

async function inspectSidecar(
  sessionFile: string,
  owner: PlanOwner,
): Promise<Result<{ plan: StoredTaskPlan; fingerprint: FileFingerprint } | null, ExpectedError>> {
  const parent = await verifyParent(sessionFile);
  if (!parent.ok) {
    // A removed SDK directory proves absence, not ambiguous ownership of an existing plan.
    if (parent.error instanceof StorageError && parent.error.systemCode === "ENOENT") {
      const found = await capture(() => lstat(planFilePath(sessionFile)));
      if (!found.ok && found.error instanceof StorageError && found.error.systemCode === "ENOENT")
        return ok(null);
      if (!found.ok) return found;
    }
    return parent;
  }
  const path = planFilePath(sessionFile);
  const found = await capture(() => lstat(path));
  if (!found.ok) {
    return found.error instanceof StorageError && found.error.systemCode === "ENOENT"
      ? ok(null)
      : found;
  }
  if (
    !found.value.isFile() ||
    found.value.isSymbolicLink() ||
    found.value.nlink !== 1 ||
    (found.value.mode & 0o077) !== 0 ||
    (process.getuid && found.value.uid !== process.getuid())
  ) {
    return err(new StorageError("Task plan sidecar is not a private regular file."));
  }
  if (found.value.size > maxSidecarBytes) {
    return err(new StorageError("Task plan sidecar is too large."));
  }

  const read = await capture(async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return withCleanup(
      async () => {
        const stat = await file.stat();
        if (!sameFile(fingerprint(found.value), fingerprint(stat))) {
          return err(new StorageError("Task plan sidecar changed while reading."));
        }
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const afterRead = await file.stat();
        if (length !== stat.size || !sameFile(fingerprint(stat), fingerprint(afterRead))) {
          return err(new StorageError("Task plan sidecar changed or grew while reading."));
        }
        const parsed = parseJson(buffer.subarray(0, length).toString("utf8"), "task plan sidecar");
        if (!parsed.ok) {
          return err(
            new StorageError("Corrupt task plan sidecar.", undefined, { cause: parsed.error }),
          );
        }
        const validated = parseStoredTaskPlan(parsed.value, owner);
        return validated.ok
          ? ok({ plan: validated.value, fingerprint: fingerprint(stat) })
          : validated;
      },
      () => file.close(),
    );
  });

  return read.ok ? read.value : read;
}

async function inspectSdkOwner(
  sessionFile: string,
  owner: PlanOwner,
): Promise<Result<void, ExpectedError>> {
  const found = await capture(() => lstat(sessionFile));
  if (!found.ok) {
    return found;
  }
  if (!found.value.isFile() || found.value.isSymbolicLink()) {
    return err(new StorageError("Task plan requires a regular SDK session file."));
  }
  const read = await capture(async () => {
    const file = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    return withCleanup(
      async () => {
        const stat = await file.stat();
        if (!sameFile(fingerprint(found.value), fingerprint(stat))) {
          return err(new StorageError("SDK session changed while checking task plan ownership."));
        }
        const buffer = Buffer.alloc(65536);
        const bytes = await file.read(buffer, 0, buffer.length, 0);
        const afterRead = await file.stat();
        if (!sameFile(fingerprint(stat), fingerprint(afterRead))) {
          return err(new StorageError("SDK session changed while checking task plan ownership."));
        }
        const header = parseJson(
          buffer
            .subarray(0, bytes.bytesRead)
            .toString("utf8")
            .split(/\r?\n/)
            .find((line) => line.trim()) ?? "",
          "SDK session header",
        );
        if (
          !header.ok ||
          !isObject(header.value) ||
          header.value.type !== "session" ||
          header.value.id !== owner.conversationId ||
          header.value.cwd !== owner.cwd
        ) {
          return err(new StorageError("SDK session does not match task plan owner."));
        }
        return ok(undefined);
      },
      () => file.close(),
    );
  });
  return read.ok ? read.value : read;
}

const queues = new Map<string, Promise<unknown>>();
function serialized<T>(
  path: string,
  operation: () => Promise<Result<T, ExpectedError>>,
): Promise<Result<T, ExpectedError>> {
  const previous = queues.get(path) ?? Promise.resolve();
  const task = previous.then(operation, operation);
  queues.set(path, task);
  void task
    .finally(() => {
      if (queues.get(path) === task) queues.delete(path);
    })
    .catch(() => {});
  return task;
}

export function readTaskPlan(
  sessionFile: string,
  owner: PlanOwner,
): Promise<Result<StoredTaskPlan | null, ExpectedError>> {
  return serialized(planFilePath(sessionFile), async () => {
    const inspected = await inspectSidecar(sessionFile, owner);
    if (!inspected.ok) return inspected;
    if (!inspected.value) return ok(null);
    const sdk = await inspectSdkOwner(sessionFile, owner);
    return sdk.ok ? ok(inspected.value.plan) : sdk;
  });
}

export function inspectTaskPlanForRetention(
  sessionFile: string,
  owner: PlanOwner,
): Promise<Result<InspectedTaskPlan, ExpectedError>> {
  return serialized(planFilePath(sessionFile), async () => {
    const inspected = await inspectSidecar(sessionFile, owner);
    if (!inspected.ok) return inspected;
    return ok(
      inspected.value
        ? {
            kind: "ready",
            fingerprint: inspected.value.fingerprint,
            updatedAt: inspected.value.plan.updatedAt,
          }
        : { kind: "absent" },
    );
  });
}

// A changed or newly created sidecar is not authority to remove the earlier plan.
export function recheckTaskPlanForRetention(
  sessionFile: string,
  owner: PlanOwner,
  expected: InspectedTaskPlan,
): Promise<Result<void, ExpectedError>> {
  return serialized(planFilePath(sessionFile), async () => {
    const inspected = await inspectSidecar(sessionFile, owner);
    if (!inspected.ok) return inspected;
    const unchanged =
      expected.kind === "absent"
        ? inspected.value === null
        : inspected.value !== null && sameFile(expected.fingerprint, inspected.value.fingerprint);
    return unchanged
      ? ok(undefined)
      : err(new StorageError("Task plan changed during retention cleanup."));
  });
}

async function removeIfUnchanged(
  sessionFile: string,
  owner: PlanOwner,
  expected: InspectedTaskPlan,
): Promise<Result<void, ExpectedError>> {
  const inspected = await inspectSidecar(sessionFile, owner);
  if (!inspected.ok) return inspected;
  if (expected.kind === "absent" && !inspected.value) return ok(undefined);
  if (
    expected.kind !== "ready" ||
    !inspected.value ||
    !sameFile(expected.fingerprint, inspected.value.fingerprint)
  ) {
    return err(new StorageError("Task plan changed before removal."));
  }
  const removed = await capture(() => unlink(planFilePath(sessionFile)));
  return removed;
}

export function deleteTaskPlanForRetention(
  sessionFile: string,
  owner: PlanOwner,
  expected: InspectedTaskPlan,
): Promise<Result<void, ExpectedError>> {
  return serialized(planFilePath(sessionFile), () =>
    removeIfUnchanged(sessionFile, owner, expected),
  );
}

export function saveTaskPlan(
  sessionFile: string,
  owner: PlanOwner,
  plan: unknown,
  review: unknown,
): Promise<Result<StoredTaskPlan, ExpectedError>> {
  return serialized(planFilePath(sessionFile), async () => {
    if (!validOwner(owner)) return err(new InputError("Invalid task plan owner."));
    const validated = validateTaskPlan(plan);
    if (!validated.ok) return validated;
    if (!Value.Check(planReviewSchema, review))
      return err(new InputError("Invalid task plan review."));
    const current = await inspectSidecar(sessionFile, owner);
    if (!current.ok) return current;
    const parent = await verifyParent(sessionFile);
    if (!parent.ok) return parent;
    const sdk = await inspectSdkOwner(sessionFile, owner);
    if (!sdk.ok) return sdk;

    // Only a validated session and an existing, verified parent can authorize a new sidecar.
    const stored: StoredTaskPlan = {
      version: 1,
      owner: { conversationId: owner.conversationId, cwd: owner.cwd },
      updatedAt: Date.now(),
      hash: hashPlan(validated.value),
      plan: validated.value,
      review,
    };
    const text = JSON.stringify(stored);
    if (Buffer.byteLength(text, "utf8") > maxSidecarBytes) {
      return err(new InputError("Task plan sidecar exceeds the storage size limit."));
    }
    const path = planFilePath(sessionFile);
    const temporary = path + "." + randomUUID() + ".tmp";
    const saved = await capture(() =>
      withCleanup(
        async () => {
          const file = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          await withCleanup(
            async () => {
              await file.writeFile(text);
              await file.sync();
            },
            () => file.close(),
          );
          // Do not replace a different sidecar that appeared while writing the temporary file.
          const latest = await inspectSidecar(sessionFile, owner);
          if (!latest.ok) throw latest.error;
          if (
            current.value === null
              ? latest.value !== null
              : latest.value === null ||
                !sameFile(current.value.fingerprint, latest.value.fingerprint)
          ) {
            throw new StorageError("Task plan changed before replacement.");
          }
          await rename(temporary, path);
        },
        async () => {
          const removed = await capture(() => unlink(temporary));
          if (
            !removed.ok &&
            !(removed.error instanceof StorageError && removed.error.systemCode === "ENOENT")
          ) {
            throw removed.error;
          }
        },
      ),
    );
    return saved.ok ? ok(stored) : saved;
  });
}
