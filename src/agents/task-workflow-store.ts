import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  capture,
  parseJson,
  StorageError,
  systemCode,
  WorkflowError,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import {
  validateWorkflowDocument,
  workflowOwnerSchema,
  type WorkflowDocument,
  type WorkflowDocumentV2,
  type WorkflowMutation,
  type WorkflowOwner,
  type WorkflowPolicyResult,
} from "./task-workflow.ts";

export type WorkflowLocation = { originSessionFile: string };
export type OpenedWorkflow = { doc: WorkflowDocument; location: WorkflowLocation };
export const workflowFilePath = (sessionFile: string) => sessionFile + ".workflow.json";
export const workflowLinkFilePath = (sessionFile: string) => sessionFile + ".workflow-link.json";
export const workflowBackupFilePath = (sessionFile: string) =>
  sessionFile + ".workflow-v1-backup.json";
const linkSchema = Type.Object(
  {
    workflowId: Type.String(),
    originSessionFile: Type.String(),
    originOwner: workflowOwnerSchema,
    owner: workflowOwnerSchema,
  },
  { additionalProperties: false },
);
export type WorkflowLink = Static<typeof linkSchema>;
export type WorkflowFingerprint = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};
export const inspectedWorkflowSchema = Type.Union([
  Type.Object({ kind: Type.Literal("absent") }),
  Type.Object({
    kind: Type.Literal("ready"),
    sidecar: Type.Union([Type.Literal("origin"), Type.Literal("link"), Type.Literal("backup")]),
    backupFingerprint: Type.Optional(
      Type.Object({
        dev: Type.Number(),
        ino: Type.Number(),
        size: Type.Number(),
        mtimeMs: Type.Number(),
        ctimeMs: Type.Number(),
      }),
    ),
    fingerprint: Type.Object({
      dev: Type.Number(),
      ino: Type.Number(),
      size: Type.Number(),
      mtimeMs: Type.Number(),
      ctimeMs: Type.Number(),
    }),
    updatedAt: Type.Number(),
    retained: Type.Boolean(),
  }),
]);
export type InspectedWorkflow = Static<typeof inspectedWorkflowSchema>;
const maxBytes = 32 * 1024 * 1024;
const fingerprint = (stat: Stats): WorkflowFingerprint => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});
const sameFile = (a: WorkflowFingerprint, b: WorkflowFingerprint) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const absent = (error: ExpectedError) =>
  error instanceof StorageError && error.systemCode === "ENOENT";
const validOwner = (owner: WorkflowOwner) =>
  Value.Check(workflowOwnerSchema, { conversationId: owner.conversationId, cwd: owner.cwd }) &&
  isAbsolute(owner.cwd) &&
  !owner.cwd.includes("\0");
const sameOwner = (a: WorkflowOwner, b: WorkflowOwner) =>
  a.conversationId === b.conversationId && a.cwd === b.cwd;
const storageFailure = (message: string) => err(new StorageError(message));
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
async function verifyParent(sessionFile: string): Promise<Result<void, ExpectedError>> {
  if (!isAbsolute(sessionFile) || sessionFile.includes("\0"))
    return storageFailure("Workflow requires an absolute SDK session path.");
  const directory = dirname(sessionFile);
  const found = await capture(() => lstat(directory));
  if (!found.ok) return found;
  if (
    !found.value.isDirectory() ||
    found.value.isSymbolicLink() ||
    (process.getuid && found.value.uid !== process.getuid())
  )
    return storageFailure("Workflow session directory is not owned by this user.");
  const canonical = await capture(() => realpath(directory));
  if (!canonical.ok) return canonical;
  return canonical.value === resolve(directory)
    ? ok(undefined)
    : storageFailure("Workflow session directory has a symbolic location.");
}
async function readPrivate(
  path: string,
): Promise<
  Result<{ value: unknown; fingerprint: WorkflowFingerprint; text: string } | null, ExpectedError>
> {
  const parent = await verifyParent(path);
  if (!parent.ok && !absent(parent.error)) return parent;
  const found = await capture(() => lstat(path));
  if (!found.ok) return absent(found.error) ? ok(null) : found;
  const stat = found.value;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    stat.size > maxBytes
  )
    return storageFailure(
      "Workflow sidecar is not a private regular file or exceeds its size limit.",
    );
  const read = await capture(async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return withCleanup(
      async () => {
        const before = await file.stat();
        if (!sameFile(fingerprint(stat), fingerprint(before)))
          return storageFailure("Workflow sidecar changed while opening.");
        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (
          length !== before.size ||
          !sameFile(fingerprint(before), fingerprint(await file.stat()))
        )
          return storageFailure("Workflow sidecar changed while reading.");
        const text = buffer.subarray(0, length).toString("utf8");
        const parsed = parseJson(text, "workflow sidecar");
        return parsed.ok
          ? ok({ value: parsed.value, fingerprint: fingerprint(before), text })
          : storageFailure("Corrupt workflow sidecar.");
      },
      () => file.close(),
    );
  });
  return read.ok ? read.value : read;
}
async function verifySdkOwner(
  sessionFile: string,
  owner: WorkflowOwner,
): Promise<Result<void, ExpectedError>> {
  if (!validOwner(owner)) return storageFailure("Invalid workflow owner.");
  const parent = await verifyParent(sessionFile);
  if (!parent.ok) return parent;
  const found = await capture(() => lstat(sessionFile));
  if (!found.ok) return found;
  if (
    !found.value.isFile() ||
    found.value.isSymbolicLink() ||
    (process.getuid && found.value.uid !== process.getuid())
  )
    return storageFailure("Workflow requires an owned regular SDK session file.");
  const read = await capture(async () => {
    const file = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    return withCleanup(
      async () => {
        const stat = await file.stat();
        if (!sameFile(fingerprint(found.value), fingerprint(stat)))
          return storageFailure("SDK session changed during ownership check.");
        const buffer = Buffer.alloc(65536);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const parsed = parseJson(
          buffer
            .subarray(0, bytesRead)
            .toString("utf8")
            .split(/\r?\n/u)
            .find((line) => line.trim()) ?? "",
          "SDK session header",
        );
        if (!sameFile(fingerprint(stat), fingerprint(await file.stat())))
          return storageFailure("SDK session changed during ownership check.");
        const header = parsed.ok ? parsed.value : null;
        return header !== null &&
          typeof header === "object" &&
          "type" in header &&
          header.type === "session" &&
          "id" in header &&
          header.id === owner.conversationId &&
          "cwd" in header &&
          header.cwd === owner.cwd
          ? ok(undefined)
          : storageFailure("SDK session does not match workflow owner.");
      },
      () => file.close(),
    );
  });
  return read.ok ? read.value : read;
}
async function readOrigin(
  sessionFile: string,
  owner: WorkflowOwner,
  path = workflowFilePath(sessionFile),
): Promise<
  Result<
    { doc: WorkflowDocument; fingerprint: WorkflowFingerprint; text: string } | null,
    ExpectedError
  >
> {
  if (!validOwner(owner)) return storageFailure("Invalid workflow owner.");
  const read = await readPrivate(path);
  if (!read.ok) return read;
  if (!read.value) return ok(null);
  const parsed = validateWorkflowDocument(read.value.value);
  if (!parsed.ok) return storageFailure("Invalid or unsupported workflow document.");
  if (!sameOwner(parsed.value.origin, owner) || parsed.value.origin.sessionFile !== sessionFile)
    return storageFailure("Workflow owner or origin path mismatch.");
  return ok({ doc: parsed.value, fingerprint: read.value.fingerprint, text: read.value.text });
}
async function readMigrationBackup(sessionFile: string, owner: WorkflowOwner, workflowId?: string) {
  const read = await readOrigin(sessionFile, owner, workflowBackupFilePath(sessionFile));
  if (!read.ok) return read;
  if (
    read.value &&
    (read.value.doc.version !== 1 ||
      (workflowId !== undefined && read.value.doc.workflowId !== workflowId))
  )
    return storageFailure("Migration backup does not match the origin workflow.");
  return read;
}
async function readLink(
  sessionFile: string,
  owner: WorkflowOwner,
): Promise<Result<{ link: WorkflowLink; fingerprint: WorkflowFingerprint } | null, ExpectedError>> {
  if (!validOwner(owner)) return storageFailure("Invalid workflow link owner.");
  const read = await readPrivate(workflowLinkFilePath(sessionFile));
  if (!read.ok) return read;
  if (!read.value) return ok(null);
  if (
    !Value.Check(linkSchema, read.value.value) ||
    !sameOwner(read.value.value.owner, owner) ||
    read.value.value.originSessionFile === sessionFile
  )
    return storageFailure("Invalid workflow continuation link.");
  return ok({ link: read.value.value, fingerprint: read.value.fingerprint });
}
async function liveContinuation(doc: WorkflowDocument): Promise<Result<boolean, ExpectedError>> {
  for (const member of doc.members) {
    if (member.via !== "user-continuation") continue;
    const sdk = await verifySdkOwner(member.sessionFile, member);
    if (!sdk.ok) {
      if (absent(sdk.error)) continue;
      return sdk;
    }
    const link = await readLink(member.sessionFile, member);
    if (!link.ok) return link;
    if (
      link.value &&
      link.value.link.workflowId === doc.workflowId &&
      link.value.link.originSessionFile === doc.origin.sessionFile &&
      sameOwner(link.value.link.originOwner, doc.origin)
    )
      return ok(true);
  }
  return ok(false);
}
async function verifyOriginAvailable(doc: WorkflowDocument): Promise<Result<void, ExpectedError>> {
  const sdk = await verifySdkOwner(doc.origin.sessionFile, doc.origin);
  if (sdk.ok || !absent(sdk.error)) return sdk;
  const live = await liveContinuation(doc);
  return live.ok ? (live.value ? ok(undefined) : sdk) : live;
}

/** Only ENOENT means absent. Corrupt, mismatched and forged records fail closed. */
export function openWorkflow(
  sessionFile: string,
  owner: WorkflowOwner,
): Promise<Result<OpenedWorkflow | null, ExpectedError>> {
  return serialized(workflowFilePath(sessionFile), async () => {
    const origin = await readOrigin(sessionFile, owner);
    if (!origin.ok) return origin;
    const link = await readLink(sessionFile, owner);
    if (!link.ok) return link;
    if (origin.value && link.value)
      return storageFailure("Conversation has both an origin and a continuation workflow.");
    if (origin.value) {
      const sdk = await verifyOriginAvailable(origin.value.doc);
      return sdk.ok
        ? ok({ doc: origin.value.doc, location: { originSessionFile: sessionFile } })
        : sdk;
    }
    if (!link.value) return ok(null);
    const sdk = await verifySdkOwner(sessionFile, owner);
    if (!sdk.ok) return sdk;
    const target = await readOrigin(link.value.link.originSessionFile, link.value.link.originOwner);
    if (!target.ok) return target;
    const doc = target.value?.doc;
    if (
      !doc ||
      doc.workflowId !== link.value.link.workflowId ||
      !doc.members.some(
        (member) =>
          member.via === "user-continuation" &&
          sameOwner(member, owner) &&
          member.sessionFile === sessionFile,
      )
    )
      return storageFailure(
        "Continuation link is not authorized by canonical workflow membership.",
      );
    return ok({ doc, location: { originSessionFile: doc.origin.sessionFile } });
  });
}

export type WorkflowWriteIO = {
  write: (file: FileHandle, text: string) => Promise<void>;
  sync: (file: FileHandle) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  syncDirectory: (directory: string) => Promise<void>;
};
const defaultIO: WorkflowWriteIO = {
  write: (file, text) => file.writeFile(text),
  sync: (file) => file.sync(),
  rename,
  syncDirectory: async (directory) => {
    const file = await open(directory, constants.O_RDONLY);
    await withCleanup(
      async () => {
        try {
          await file.sync();
        } catch (error) {
          // Some platforms do not implement directory fsync; real I/O failures still reject.
          if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(systemCode(error) ?? "")) throw error;
        }
      },
      () => file.close(),
    );
  },
};
async function atomicWrite(
  path: string,
  value: unknown,
  expected: WorkflowFingerprint | null,
  overrides?: Partial<WorkflowWriteIO>,
): Promise<Result<void, ExpectedError>> {
  return atomicWriteText(path, JSON.stringify(value), expected, overrides);
}
async function atomicWriteText(
  path: string,
  text: string,
  expected: WorkflowFingerprint | null,
  overrides?: Partial<WorkflowWriteIO>,
): Promise<Result<void, ExpectedError>> {
  if (Buffer.byteLength(text) > maxBytes)
    return storageFailure(
      "Workflow sidecar exceeds its storage size limit; safety facts were not evicted.",
    );
  const io = { ...defaultIO, ...overrides };
  const temporary = `${path}.${randomUUID()}.tmp`;
  return capture(() =>
    withCleanup(
      async () => {
        const file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await withCleanup(
          async () => {
            await io.write(file, text);
            await io.sync(file);
          },
          () => file.close(),
        );
        const current = await readPrivate(path);
        if (!current.ok) throw current.error;
        if (
          expected
            ? !current.value || !sameFile(expected, current.value.fingerprint)
            : current.value !== null
        )
          throw new WorkflowError(
            "WORKFLOW_CONFLICT",
            "Workflow changed before durable replacement.",
          );
        await io.rename(temporary, path);
        await io.syncDirectory(dirname(path));
      },
      async () => {
        const removed = await capture(() => unlink(temporary));
        if (!removed.ok && !absent(removed.error)) throw removed.error;
      },
    ),
  );
}
/** Pure, lossless conversion. Revision advancement belongs to the scheduler commit. */
export function migrateWorkflowToV2(doc: WorkflowDocument): WorkflowDocumentV2 {
  return { ...structuredClone(doc), version: 2 };
}

/** One private, atomic backup follows the origin sidecar's retention lifecycle. */
async function writeMigrationBackup(
  sessionFile: string,
  doc: WorkflowDocument,
  text: string,
  overrides?: Partial<WorkflowWriteIO>,
): Promise<Result<void, ExpectedError>> {
  const existing = await readMigrationBackup(sessionFile, doc.origin, doc.workflowId);
  if (!existing.ok) return existing;
  return atomicWriteText(
    workflowBackupFilePath(sessionFile),
    text,
    existing.value?.fingerprint ?? null,
    overrides,
  );
}

/** Scheduler storage may extend safety history, never erase repair ownership or receipts. */
function preservesWorkflowHistory(before: WorkflowDocument, after: WorkflowDocument): boolean {
  return (
    Object.keys(before.processed).every((key) => Object.hasOwn(after.processed, key)) &&
    Object.entries(before.defects).every(([id, defect]) => {
      const next = after.defects[id];
      return (
        next !== undefined &&
        next.automatedFailures >= defect.automatedFailures &&
        (!defect.locked || next.locked) &&
        defect.attempts.every((attempt) => next.attempts.some((item) => item.id === attempt.id))
      );
    })
  );
}

export function mutateWorkflow(
  location: WorkflowLocation,
  owner: WorkflowOwner,
  mutate: (doc: WorkflowDocument | null) => WorkflowPolicyResult,
  options?: {
    expectedRevision?: number | null;
    io?: Partial<WorkflowWriteIO>;
    /** Scheduler writes only. Ordinary host operations MUST leave v1 documents at v1. */
    requireVersion?: 2;
  },
): Promise<Result<WorkflowMutation, ExpectedError>> {
  const sessionFile = location.originSessionFile;
  return serialized(workflowFilePath(sessionFile), async () => {
    const read = await readOrigin(sessionFile, owner);
    if (!read.ok) return read;
    const current = read.value?.doc ?? null;
    if (
      options?.expectedRevision !== undefined &&
      options.expectedRevision !== (current?.revision ?? null)
    )
      return err(new WorkflowError("WORKFLOW_CONFLICT", "Workflow revision changed."));
    const sdk = current
      ? await verifyOriginAvailable(current)
      : await verifySdkOwner(sessionFile, owner);
    if (!sdk.ok) return sdk;
    const migrating = current?.version === 1 && options?.requireVersion === 2;
    const input = current
      ? options?.requireVersion === 2
        ? migrateWorkflowToV2(current)
        : structuredClone(current)
      : null;
    const result = mutate(input);
    if (!result.ok) return result;
    const candidate =
      options?.requireVersion === 2 ? migrateWorkflowToV2(result.value.doc) : result.value.doc;
    // A migration-only scheduler write still commits exactly one document revision.
    if (migrating && candidate.revision === current.revision) candidate.revision += 1;
    const validated = validateWorkflowDocument(candidate);
    if (!validated.ok) return validated;
    const next = validated.value;
    const serialized = parseJson(JSON.stringify(next), "workflow mutation");
    if (!serialized.ok || !validateWorkflowDocument(serialized.value).ok)
      return storageFailure("Workflow mutation is not a complete JSON document.");
    if (
      !sameOwner(next.origin, owner) ||
      next.origin.sessionFile !== sessionFile ||
      (!current && next.version === 2 && options?.requireVersion !== 2) ||
      (current &&
        ((next.version !== current.version && !migrating) ||
          next.workflowId !== current.workflowId ||
          (next.revision !== current.revision + 1 &&
            JSON.stringify(current) !== JSON.stringify(next))))
    )
      return err(
        new WorkflowError(
          "WORKFLOW_CONFLICT",
          "Mutation changed identity or did not advance exactly one revision.",
        ),
      );
    if (current && (migrating || current.version === 2) && !preservesWorkflowHistory(current, next))
      return err(
        new WorkflowError("WORKFLOW_CONFLICT", "Mutation erased workflow safety history."),
      );
    if (
      current?.version === 2 &&
      Object.entries(current.scheduler?.admissions ?? {}).some(
        ([operationId, admission]) =>
          admission.runId !== undefined &&
          (next.version !== 2 ||
            next.scheduler?.admissions[operationId]?.runId !== admission.runId),
      )
    )
      return err(
        new WorkflowError("WORKFLOW_CONFLICT", "An admission runId cannot change or disappear."),
      );
    if (
      current?.version === 2 &&
      Object.entries(current.scheduler?.consents ?? {}).some(([id, receipt]) => {
        const updated = next.version === 2 ? next.scheduler?.consents[id] : undefined;
        if (!updated) return true;
        const {
          state: previousState,
          confirmedAt: previousConfirmation,
          ...previousFacts
        } = receipt;
        const { state: nextState, confirmedAt: nextConfirmation, ...nextFacts } = updated;
        return (
          JSON.stringify(previousFacts) !== JSON.stringify(nextFacts) ||
          (previousState === "revoked" && nextState !== "revoked") ||
          (previousState === "confirmed" && nextState === "preview") ||
          (previousConfirmation !== undefined && previousConfirmation !== nextConfirmation)
        );
      })
    )
      return err(
        new WorkflowError(
          "WORKFLOW_CONFLICT",
          "Execution consent facts cannot change or disappear.",
        ),
      );
    if (current && JSON.stringify(current) === JSON.stringify(next))
      return ok({ ...result.value, effects: [] });
    if (migrating && read.value) {
      const backup = await writeMigrationBackup(sessionFile, current, read.value.text, options?.io);
      if (!backup.ok) return backup;
    }
    const saved = await atomicWrite(
      workflowFilePath(sessionFile),
      next,
      read.value?.fingerprint ?? null,
      options?.io,
    );
    return saved.ok ? ok({ ...result.value, doc: next }) : saved;
  });
}

/** Membership must be committed before this link; a link alone never grants authority. */
export function writeWorkflowLink(
  sessionFile: string,
  owner: WorkflowOwner,
  location: WorkflowLocation,
  originOwner: WorkflowOwner,
): Promise<Result<void, ExpectedError>> {
  return serialized(workflowFilePath(location.originSessionFile), async () => {
    const sdk = await verifySdkOwner(sessionFile, owner);
    if (!sdk.ok) return sdk;
    const origin = await readOrigin(location.originSessionFile, originOwner);
    if (!origin.ok) return origin;
    if (
      !origin.value ||
      !origin.value.doc.members.some(
        (member) =>
          member.via === "user-continuation" &&
          sameOwner(member, owner) &&
          member.sessionFile === sessionFile,
      )
    )
      return err(
        new WorkflowError(
          "WORKFLOW_NOT_AUTHORIZED",
          "Continuation membership must be committed before linking.",
        ),
      );
    const local = await readOrigin(sessionFile, owner);
    if (!local.ok) return local;
    if (local.value)
      return err(new WorkflowError("WORKFLOW_CONFLICT", "Continuation already owns a workflow."));
    const existing = await readLink(sessionFile, owner);
    if (!existing.ok) return existing;
    const link: WorkflowLink = {
      workflowId: origin.value.doc.workflowId,
      originSessionFile: location.originSessionFile,
      originOwner: { conversationId: originOwner.conversationId, cwd: originOwner.cwd },
      owner: { conversationId: owner.conversationId, cwd: owner.cwd },
    };
    if (existing.value && JSON.stringify(existing.value.link) !== JSON.stringify(link))
      return err(
        new WorkflowError("WORKFLOW_CONFLICT", "Continuation already links another workflow."),
      );
    return existing.value
      ? ok(undefined)
      : atomicWrite(workflowLinkFilePath(sessionFile), link, null);
  });
}

async function inspectRetention(
  sessionFile: string,
  owner: WorkflowOwner,
): Promise<Result<InspectedWorkflow, ExpectedError>> {
  const origin = await readOrigin(sessionFile, owner);
  if (!origin.ok) return origin;
  const link = await readLink(sessionFile, owner);
  if (!link.ok) return link;
  const backup = await readMigrationBackup(sessionFile, owner, origin.value?.doc.workflowId);
  if (!backup.ok) return backup;
  if ((origin.value || backup.value) && link.value)
    return storageFailure("Ambiguous workflow sidecars.");
  if (origin.value) {
    const live = await liveContinuation(origin.value.doc);
    if (!live.ok) return live;
    return ok({
      kind: "ready",
      sidecar: "origin",
      fingerprint: origin.value.fingerprint,
      ...(backup.value ? { backupFingerprint: backup.value.fingerprint } : {}),
      updatedAt: origin.value.doc.log.at(-1)?.at ?? 0,
      retained: live.value,
    });
  }
  if (backup.value)
    return ok({
      kind: "ready",
      sidecar: "backup",
      fingerprint: backup.value.fingerprint,
      updatedAt: backup.value.doc.log.at(-1)?.at ?? 0,
      retained: false,
    });
  if (link.value)
    return ok({
      kind: "ready",
      sidecar: "link",
      fingerprint: link.value.fingerprint,
      updatedAt: 0,
      retained: false,
    });
  return ok({ kind: "absent" });
}
export function inspectWorkflowForRetention(
  sessionFile: string,
  owner: WorkflowOwner,
): Promise<Result<InspectedWorkflow, ExpectedError>> {
  return serialized(workflowFilePath(sessionFile), () => inspectRetention(sessionFile, owner));
}
/** A missing backup is safe cleanup progress; a new or replaced file never inherits authority. */
export function workflowRetentionMatches(a: InspectedWorkflow, b: InspectedWorkflow): boolean {
  return a.kind === "absent"
    ? b.kind === "absent"
    : b.kind === "ready" &&
        a.sidecar === b.sidecar &&
        a.retained === b.retained &&
        sameFile(a.fingerprint, b.fingerprint) &&
        (b.backupFingerprint === undefined ||
          (a.backupFingerprint !== undefined &&
            sameFile(a.backupFingerprint, b.backupFingerprint)));
}
export function recheckWorkflowForRetention(
  sessionFile: string,
  owner: WorkflowOwner,
  expected: InspectedWorkflow,
): Promise<Result<void, ExpectedError>> {
  return serialized(workflowFilePath(sessionFile), async () => {
    const current = await inspectRetention(sessionFile, owner);
    return current.ok
      ? workflowRetentionMatches(expected, current.value)
        ? ok(undefined)
        : storageFailure("Workflow changed during retention cleanup.")
      : current;
  });
}
export function deleteWorkflowForRetention(
  sessionFile: string,
  owner: WorkflowOwner,
  expected: InspectedWorkflow,
): Promise<Result<"removed" | "absent" | "retained", ExpectedError>> {
  return serialized(workflowFilePath(sessionFile), async () => {
    const current = await inspectRetention(sessionFile, owner);
    if (!current.ok) return current;
    if (!workflowRetentionMatches(expected, current.value))
      return storageFailure("Workflow changed before retention removal.");
    if (current.value.kind === "absent") return ok("absent");
    if (current.value.retained) return ok("retained");
    // Remove the backup first so an interrupted origin unlink cannot strand private history.
    if (current.value.sidecar === "origin" && current.value.backupFingerprint) {
      const removedBackup = await capture(() => unlink(workflowBackupFilePath(sessionFile)));
      if (!removedBackup.ok && !absent(removedBackup.error)) return removedBackup;
    }
    const path =
      current.value.sidecar === "origin"
        ? workflowFilePath(sessionFile)
        : current.value.sidecar === "backup"
          ? workflowBackupFilePath(sessionFile)
          : workflowLinkFilePath(sessionFile);
    const removed = await capture(() => unlink(path));
    return removed.ok ? ok("removed") : removed;
  });
}
export async function deleteWorkflowForPurge(
  sessionFile: string,
  owner: WorkflowOwner,
): Promise<Result<"removed" | "absent" | "retained", ExpectedError>> {
  const sdk = await verifySdkOwner(sessionFile, owner);
  if (!sdk.ok && !absent(sdk.error)) return sdk;
  const inspected = await inspectWorkflowForRetention(sessionFile, owner);
  return inspected.ok ? deleteWorkflowForRetention(sessionFile, owner, inspected.value) : inspected;
}
