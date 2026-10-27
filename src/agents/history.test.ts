import { expect, spyOn, test } from "bun:test";
import { appendFile, chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { offlineRuntime } from "../testing/offline-runtime.ts";
import { piSessionFactory } from "./pi-session-adapter.ts";
import { SessionRegistry } from "./session-registry.ts";
import { SessionHistory } from "./history.ts";
import { expectOk, expectError } from "../testing/results.ts";
import { ok } from "../result.ts";
import type { SessionSnapshotSource } from "./session-snapshot.ts";

async function setup(blockCleanup = false) {
  const fixture = await createWorktreeFixture();
  const options = await offlineRuntime(join(fixture.directory, "agent"));
  const factory = piSessionFactory(options);
  const gate = Promise.withResolvers<void>();
  if (!blockCleanup) gate.resolve();
  const registry = new SessionRegistry([fixture.repository], async (context) => {
    const executor = await factory(context);
    return { savedSessionId: executor.savedSessionId, sessionFile: executor.sessionFile,
      get state() { return executor.state; }, subscribe: (listener: () => void) => executor.subscribe(listener),
      prompt: (text: string) => executor.prompt(text), close: async () => { await gate.promise; return executor.close(); } };
  });
  const history = new SessionHistory([fixture.repository], registry, options.sessionDir);
  const main = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
  const feature = fixture.repository.worktrees.find((tree) => tree.path === fixture.feature)!;
  return { ...fixture, main, feature, registry, history, gate, sessionDir: options.sessionDir,
    async cleanup() { gate.resolve(); await registry.shutdown(); await fixture.cleanup(); } };
}

test("History lists only closed SDK conversations in the selected worktree", async () => {
  // The shared SDK directory contains two different worktree conversations.
  const app = await setup();
  try {
    const main = expectOk(await app.registry.create(app.main.id)); const feature = expectOk(await app.registry.create(app.feature.id));
    await Promise.all([app.registry.prompt(main, "read"), app.registry.prompt(feature, "write")]);

    // Neither running nor idle open conversations belong in saved History.
    expect(expectOk(await app.history.list(app.main.id))).toEqual([]);
    expectOk(await app.registry.close(main));
    const list = expectOk(await app.history.list(app.main.id));

    // Metadata from another cwd cannot appear under the selected worktree.
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("read");
    expect(list[0]?.worktreeId).toBe(app.main.id);
    expect(list[0]?.openSessionId).toBeNull();
    expect(list[0]?.unavailableReason).toBeNull();
    expect(Number.isNaN(Date.parse(list[0]!.modified))).toBe(false);
    expect(list[0]!.messageCount).toBeGreaterThan(0);
  } finally { await app.cleanup(); }
});

test("Snapshots without SDK conversations never create History rows, even for open recovery", async () => {
  // Recovery metadata is not an independently resumable saved conversation.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)), live = app.registry.records.find(record => record.id === id)!;
    const snapshots: SessionSnapshotSource = {
      listSessions: () => (["open", "closed"] as const).map(lifecycle => ({ id: lifecycle === "open" ? live.id : "orphan", name: "Snapshot", title: "Snapshot",
        worktreeId: app.main.id, conversationId: lifecycle === "open" ? live.state.conversationId! : "orphan", lifecycle, updatedAt: Date.now(), messageCount: 0 })),
      readSession: async () => ok(live),
    };
    const history = new SessionHistory([app.repository], app.registry, app.sessionDir, snapshots);

    // Both open and closed snapshot-only entries stay out of SDK-backed History.
    const items = expectOk(await history.list(app.main.id));

    // The open tab remains available for recovery without appearing in the saved list.
    expect(items).toEqual([]); expect(app.registry.records.map(record => record.id)).toEqual([id]);
    expect(expectError(await history.preview(app.main.id, "orphan")).code).toBe("HISTORY_UNAVAILABLE");
  } finally { await app.cleanup(); }
});

test("Open recovery intent excludes SDK conversations even without a live writer", async () => {
  // Failed recovery can leave an open tab without a registry-owned executor.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const conversationId = app.registry.records.find(record => record.id === id)!.state.conversationId!;
    expectOk(await app.registry.close(id)); app.registry.acknowledgeCheckpoint(app.registry.checkpointRecords);
    const snapshot = { id, conversationId, name: "Recovery", title: "Recovery", worktreeId: app.main.id,
      lifecycle: "open" as "open" | "closed", updatedAt: Date.now(), messageCount: 1 };
    const history = new SessionHistory([app.repository], app.registry, app.sessionDir, {
      listSessions: () => [snapshot], readSession: async () => ok(null),
    });

    // Stored open intent must stay out of History until that tab is explicitly closed.
    const open = expectOk(await history.list(app.main.id)); snapshot.lifecycle = "closed";
    const closed = expectOk(await history.list(app.main.id));

    // A saved original becomes a candidate only once both runtime and recovery intent are closed.
    expect(open).toEqual([]); expect(closed.map(item => item.id)).toEqual([conversationId]);
  } finally { await app.cleanup(); }
});

test.each(["opening", "closing", "replacing", "cleanup", "subagent"])("History hides SDK conversations reserved for %s", async state => {
  // A valid original is not a saved candidate while its writer reservation is active.
  const app = await setup(); let restore: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    expectOk(await app.registry.close(id));
    const ownership = spyOn(app.registry, "historyOwnership").mockReturnValue({ openSessionId: null, unavailableReason: state });
    restore = () => ownership.mockRestore();

    // Discover saved candidates while the writer reservation remains active.
    const items = expectOk(await app.history.list(app.main.id));

    // Reserved conversations never reach the popup as unavailable rows.
    expect(items).toEqual([]);
  } finally { restore?.(); await app.cleanup(); }
});

test("Previews read open and closed histories without writes and reject other worktrees", async () => {
  // The offline SDK fixture owns all files; no preview may initialize an executor.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!, saved = { id: SessionManager.open(file).getSessionId() };
    const before = await readFile(file, "utf8"), records = app.registry.records;
    const preview = expectOk(await app.history.preview(app.main.id, saved.id));
    expect(preview.text).toContain("read"); expect(preview.telemetry).toEqual(app.registry.details(id)?.telemetry);
    expect(app.registry.records).toEqual(records); expect(await readFile(file, "utf8")).toBe(before);
    expect(expectError(await app.history.preview(app.feature.id, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
    expect(expectError(await app.history.preview(app.main.id, "unknown")).code).toBe("HISTORY_UNAVAILABLE");
    expectOk(await app.registry.close(id));
    expect(expectOk(await app.history.preview(app.main.id, saved.id)).text).toContain("read");
    expect(app.registry.records).toEqual([]); expect(await readFile(file, "utf8")).toBe(before);
  } finally { await app.cleanup(); }
});

test("Closed-session previews remain read-only for real SDK histories exceeding 4 MiB", async () => {
  // Close the fixture-owned writer before extending its JSONL, then use real SDK discovery.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!, saved = { id: SessionManager.open(file).getSessionId() };
    expectOk(await app.registry.close(id));
    const entries = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    const parent = entries.at(-1)!.id;
    const timestamp = new Date().toISOString();
    await appendFile(file, [
      { type: "custom", id: "large-old", parentId: parent, timestamp, customType: "old-fixture-data", data: "x".repeat(5 * 1024 * 1024) },
      { type: "message", id: "recent-q", parentId: "large-old", timestamp, message: { role: "user", content: "LATEST QUESTION", timestamp: Date.now() } },
      { type: "message", id: "recent-a", parentId: "recent-q", timestamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "LATEST PLAN" }, { type: "text", text: "LATEST ANSWER" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const before = await readFile(file, "utf8");
    const preview = expectOk(await app.history.preview(app.main.id, saved.id));
    expect(preview.sections?.slice(-3).map((section) => section.text)).toEqual(["LATEST QUESTION", "LATEST PLAN", "LATEST ANSWER"]);
    expect(preview.sections?.[0]?.text).toBe("read"); expect(preview.sections!.length).toBeLessThanOrEqual(15);
    expect(app.registry.records).toEqual([]); expect(await readFile(file, "utf8")).toBe(before);
  } finally { await app.cleanup(); }
});

test("List both Radian SDK storage and legacy Pi histories without modifying legacy records", async () => {
  // Moving new records to dedicated storage must not hide legacy Pi conversations.
  const app = await setup(), timestamp = new Date();
  const ownedPath = join(app.directory, "owned.jsonl"), legacyPath = join(app.directory, "legacy.jsonl");
  await writeFile(ownedPath, [
    { type: "session", version: 3, id: "owned", cwd: app.main.path, timestamp: timestamp.toISOString() },
    { type: "message", id: "q", parentId: null, timestamp: timestamp.toISOString(), message: { role: "user", content: "Owned question" } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const legacy = [{ type: "session", version: 1, id: "legacy", timestamp: timestamp.toISOString() },
    { type: "message", message: { role: "user", content: "Legacy question" } }].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(legacyPath, legacy);
  const info = (id: string, path: string, cwd: string) => ({ id, path, cwd, created: timestamp, modified: timestamp, messageCount: 1, firstMessage: id, allMessagesText: id });
  const listing = spyOn(SessionManager, "list").mockImplementation(async (_cwd, directory) => directory
    ? [info("owned", ownedPath, app.main.path), info("unscoped-private", ownedPath, "")] : [info("legacy", legacyPath, "")]);
  try {
    const history = new SessionHistory([app.repository], app.registry, join(app.directory, "private-sessions"), undefined, true);

    // Validate cwd in dedicated storage; the SDK scopes default directories by project.
    const items = expectOk(await history.list(app.main.id));
    const preview = expectOk(await history.preview(app.main.id, "legacy"));

    expect(items.map(item => item.id).sort()).toEqual(["legacy", "owned"]); expect(listing).toHaveBeenCalledTimes(2);
    expect(preview.text).toContain("Legacy question"); expect(await readFile(legacyPath, "utf8")).toBe(legacy);
    expect(app.registry.records).toEqual([]);
  } finally { listing.mockRestore(); await app.cleanup(); }
});

test("Resuming closed history reuses its SDK ID, file, and conversation with a separate open UI entry", async () => {
  // The existing finalized JSONL is authoritative, not copied to a new conversation.
  const app = await setup();
  try {
    const original = expectOk(await app.registry.create(app.main.id));
    await app.registry.prompt(original, "read");
    const file = app.registry.sessionFile(original)!;
    const sdkId = SessionManager.open(file).getSessionId();
    const before = await readFile(file, "utf8");
    await app.registry.close(original);

    // Resume uses the SDK saved ID selected from the worktree's history, not an arbitrary path.
    const reopened = expectOk(await app.history.resume(app.main.id, sdkId));

    // Open identity changes, but persisted identity and the conversation do not fork or restart.
    expect(reopened).not.toBe(original);
    expect(app.registry.sessionFile(reopened)).toBe(file);
    expect(SessionManager.open(file).getSessionId()).toBe(sdkId);
    expect(app.registry.details(reopened)?.output).toContain("main-worktree-marker");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(expectOk(await app.history.resume(app.main.id, sdkId))).toBe(reopened);
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test("Resuming rejects unknown IDs and IDs belonging to other worktrees", async () => {
  // A valid main conversation must not be assigned to the feature worktree by an untyped request.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const saved = { id: SessionManager.open(app.registry.sessionFile(id)!).getSessionId() };

    // Cross-worktree or arbitrary IDs cannot bypass discovery membership.
    expect(expectError(await app.history.resume(app.feature.id, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
    expect(expectError(await app.history.resume(app.main.id, "unknown")).code).toBe("HISTORY_UNAVAILABLE");

    // The valid existing execution and its worktree remain unchanged.
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions[0]?.id).toBe(id);
    expect(app.registry.snapshot[0]!.worktrees[1]!.sessions).toEqual([]);
  } finally { await app.cleanup(); }
});

test("Closing sessions stay out of History until their writer releases ownership", async () => {
  // Cleanup acknowledgement is held so the hidden closing writer can be observed.
  const app = await setup(true);
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const savedId = SessionManager.open(app.registry.sessionFile(id)!).getSessionId();

    // Closing removes display ownership but keeps the canonical-file reservation.
    const closing = app.registry.close(id);
    const list = expectOk(await app.history.list(app.main.id));
    expect(expectError(await app.history.resume(app.main.id, savedId)).code).toBe("SESSION_CONFLICT");

    // Read-only history does not mistake an in-progress close for a reusable saved context.
    expect(list).toEqual([]);
    app.gate.resolve(); await closing;
    expect(expectOk(await app.history.list(app.main.id)).map(item => item.id)).toEqual([savedId]);
  } finally { await app.cleanup(); }
});

test("Resume never overwrites original history when SDK listing skips corrupt lines", async () => {
  // The SDK can list a session with a valid header and malformed trailing JSON.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!; const sdkId = SessionManager.open(file).getSessionId();
    await app.registry.close(id);
    const corrupt = (await readFile(file, "utf8")) + "invalid trailing JSON\n";
    await writeFile(file, corrupt);

    // Strict validation happens before the SDK opens a writable session handle.
    expect(expectError(await app.history.resume(app.main.id, sdkId)).code).toBe("HISTORY_CORRUPT");

    // No replacement or repair is silently committed to the saved history.
    expect(await readFile(file, "utf8")).toBe(corrupt);
    expect(app.registry.snapshot[0]!.worktrees[0]!.sessions).toEqual([]);
  } finally { await app.cleanup(); }
});

test("History permission failures return StorageError Results rather than empty lists", async () => {
  // A saved cwd under a denied directory is different from a deleted historical worktree.
  const app = await setup();
  const blocked = join(app.directory, "blocked");
  let restoreListing: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!; expectOk(await app.registry.close(id));
    await mkdir(join(blocked, "child"), { recursive: true });
    const records = await SessionManager.list(app.main.path, dirname(file));
    const listing = spyOn(SessionManager, "list").mockResolvedValue(records.map((record) => ({ ...record, cwd: join(blocked, "child") })));
    restoreListing = () => listing.mockRestore();
    await chmod(blocked, 0);

    // Discovery can read the JSONL but cannot resolve its cwd.
    const result = await app.history.list(app.main.id);

    // The UI receives a typed failure instead of an apparently empty success.
    expect(expectError(result).code).toBe("STORAGE_FAILED");
  } finally { restoreListing?.(); await chmod(blocked, 0o700).catch(() => {}); await app.cleanup(); }
});

test("History excludes SDK originals deleted after metadata discovery", async () => {
  // A concurrent deletion must not turn an otherwise valid list into a phantom candidate.
  const app = await setup(); let restore: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!; expectOk(await app.registry.close(id));
    const records = await SessionManager.list(app.main.path, dirname(file)); await unlink(file);
    const listing = spyOn(SessionManager, "list").mockResolvedValue(records); restore = () => listing.mockRestore();

    // Revalidate the metadata's original path before exposing a saved candidate.
    const items = expectOk(await app.history.list(app.main.id));

    // Definite disappearance excludes the row instead of failing the entire lookup.
    expect(items).toEqual([]);
  } finally { restore?.(); await app.cleanup(); }
});

test("Previews reuse the listing file index and rescan only on explicit refresh", async () => {
  // Count real SDK discovery calls to detect repeated full-list I/O.
  const app = await setup(); let restore: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    expectOk(await app.registry.close(id));
    const listing = spyOn(SessionManager, "list"); restore = () => listing.mockRestore();
    const saved = expectOk(await app.history.list(app.main.id))[0]!;
    for (let i = 0; i < 3; i++) expect(expectOk(await app.history.preview(app.main.id, saved.id)).text).toContain("read");
    expect(expectError(await app.history.preview(app.main.id, "unknown")).code).toBe("HISTORY_UNAVAILABLE");
    expect(listing).toHaveBeenCalledTimes(1);

    // Ctrl+R and reopening request a fresh list and observe disk changes.
    expectOk(await app.history.list(app.main.id)); expect(listing).toHaveBeenCalledTimes(2);
    expectOk(await app.history.preview(app.main.id, saved.id)); expect(listing).toHaveBeenCalledTimes(2);
  } finally { restore?.(); await app.cleanup(); }
});

test("Direct previews initialize the index once without a preceding list request", async () => {
  // Direct callers of the read-only endpoint must not require prior listing.
  const app = await setup(); let restore: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const savedId = SessionManager.open(app.registry.sessionFile(id)!).getSessionId();
    const listing = spyOn(SessionManager, "list"); restore = () => listing.mockRestore();
    expect(expectOk(await app.history.preview(app.main.id, savedId)).text).toContain("read");
    expectOk(await app.history.preview(app.main.id, savedId)); expect(listing).toHaveBeenCalledTimes(1);
  } finally { restore?.(); await app.cleanup(); }
});

test("Cancelling completed list request signals does not rescan validated indexes", async () => {
  // HTTP request lifetimes differ from completed metadata index lifetimes.
  const app = await setup(); let restore: (() => void) | undefined;
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    expectOk(await app.registry.close(id));
    const listing = spyOn(SessionManager, "list"); restore = () => listing.mockRestore(); const abort = new AbortController();
    const saved = expectOk(await app.history.list(app.main.id, abort.signal))[0]!; abort.abort();
    expectOk(await app.history.preview(app.main.id, saved.id));
    expect(listing).toHaveBeenCalledTimes(1);
  } finally { restore?.(); await app.cleanup(); }
});

test("Preview rejects cached files replaced by another worktree's history", async () => {
  // Revalidate the selected file's current header and cwd despite a trusted index.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!; expectOk(await app.registry.close(id));
    const saved = expectOk(await app.history.list(app.main.id))[0]!;
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n"), header = JSON.parse(lines[0]!);
    lines[0] = JSON.stringify({ ...header, cwd: app.feature.path }); await writeFile(file, lines.join("\n") + "\n");

    expect(expectError(await app.history.preview(app.main.id, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
    expect(app.registry.records).toEqual([]);
  } finally { await app.cleanup(); }
});

test.each(["\0invalid", 42])("Invalid cached header cwd %j returns corruption errors instead of OS exceptions", async cwd => {
  // Validate externally changed JSON before filesystem calls.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!; expectOk(await app.registry.close(id));
    const saved = expectOk(await app.history.list(app.main.id))[0]!;
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n"), header = JSON.parse(lines[0]!);
    lines[0] = JSON.stringify({ ...header, cwd }); await writeFile(file, lines.join("\n") + "\n");

    expect(expectError(await app.history.preview(app.main.id, saved.id)).code).toBe("HISTORY_CORRUPT");
  } finally { await app.cleanup(); }
});

test("Preview rejects cached paths replaced by symbolic links", async () => {
  // Copying the same header ID must not bypass canonical-path validation.
  const app = await setup();
  try {
    const id = expectOk(await app.registry.create(app.main.id)); expectOk(await app.registry.prompt(id, "read"));
    const file = app.registry.sessionFile(id)!; expectOk(await app.registry.close(id));
    const saved = expectOk(await app.history.list(app.main.id))[0]!, other = join(app.directory, "replaced.jsonl");
    await writeFile(other, await readFile(file)); await unlink(file); await symlink(other, file);

    expect(expectError(await app.history.preview(app.main.id, saved.id)).code).toBe("HISTORY_UNAVAILABLE");
  } finally { await app.cleanup(); }
});

test("Listing forwards cancellation to SDK discovery instead of returning empty success", async () => {
  // Cancel inside the SDK call so checks only before and after discovery cannot pass.
  const app = await setup(); const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const abort = new AbortController(); let restore: (() => void) | undefined, received: AbortSignal | undefined;
  try {
    const listing = spyOn(SessionManager, "list").mockImplementation(async (_cwd, _dir, _progress, signal) => {
      received = signal; started.resolve(); await finish.promise; signal?.throwIfAborted(); return [];
    }); restore = () => listing.mockRestore();
    const result = app.history.list(app.main.id, abort.signal); await started.promise; abort.abort(); finish.resolve();

    expect(received === abort.signal).toBe(true); expect(expectError(await result).code).toBe("CANCELLED");
  } finally { finish.resolve(); restore?.(); await app.cleanup(); }
});
