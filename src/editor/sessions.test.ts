import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EditorSessions } from "./sessions.ts";
import { pidAlive } from "../runtime/storage.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Editor resource transition was not observed.");
    await Bun.sleep(10);
  }
}

test("A rejected editor opening releases pending retention and notifies reconciliation", async () => {
  // Pending launches are resources too, even when validation rejects them before allocating a PTY.
  let changes = 0;
  const editors = new EditorSessions([], () => changes++);
  const opening = editors.open("missing-worktree");
  expect(editors.retainedWorktreeIds.has("missing-worktree")).toBe(true);

  // Settling the rejected launch must publish its transition out of the retained set.
  expect(expectError(await opening).code).toBe("INVALID_INPUT");

  expect(editors.retainedWorktreeIds.size).toBe(0);
  expect(changes).toBeGreaterThan(0);
  expectOk(await editors.stop());
});

test("An exited editor retains its worktree only until its final stream lease is released", async () => {
  // A real isolated shell exercises PTY exit and stream cleanup without user editor configuration.
  const fixture = await createWorktreeFixture();
  let changes = 0;
  const editors = new EditorSessions([fixture.repository], () => changes++, { executable: "sh" });
  let response: Response | undefined;
  try {
    const id = expectOk(await editors.open(fixture.main));
    response = expectOk(editors.attach(id, "stream-owner"));
    expect(editors.retainedWorktreeIds.has(fixture.main)).toBe(true);

    // Exit must preserve the final frame while its attached view still owns the lease.
    expectOk(editors.input(id, "stream-owner", Buffer.from("exit 0\n")));
    await until(() => editors.infos[0]?.exited === true);
    expect(editors.retainedWorktreeIds.has(fixture.main)).toBe(true);
    const before = changes;
    await response.body!.cancel();
    response = undefined;

    // Stream cancellation alone releases catalog retention and notifies the runtime to reconcile it.
    expect(editors.retainedWorktreeIds.has(fixture.main)).toBe(false);
    expect(changes).toBeGreaterThan(before);
    expect(editors.infos[0]?.exited).toBe(true);
  } finally {
    await response?.body?.cancel();
    expectOk(await editors.stop());
    await fixture.cleanup();
  }
});

test("Explicitly detaching an exited editor notifies cleanup without retaining its vanished worktree", async () => {
  // Explicit detach and stream cancellation are separate ownership-release paths.
  const fixture = await createWorktreeFixture();
  let changes = 0;
  const editors = new EditorSessions([fixture.repository], () => changes++, { executable: "sh" });
  let response: Response | undefined;
  try {
    const id = expectOk(await editors.open(fixture.main));
    response = expectOk(editors.attach(id, "explicit-owner"));
    expectOk(editors.input(id, "explicit-owner", Buffer.from("exit 0\n")));
    await until(() => editors.infos[0]?.exited === true);
    const before = changes;

    // Releasing the exited process must trigger the same last-resource transition.
    editors.detach(id, "explicit-owner");

    expect(editors.retainedWorktreeIds.has(fixture.main)).toBe(false);
    expect(changes).toBeGreaterThan(before);
  } finally {
    await response?.body?.cancel();
    expectOk(await editors.stop());
    await fixture.cleanup();
  }
});

test("Destroying a worktree kills its editor without confirmation and preserves siblings", async () => {
  // The fixture editor ignores SIGTERM, standing in for an editor holding unsaved buffers.
  const fixture = await createWorktreeFixture();
  const script = join(fixture.directory, "stubborn-editor");
  const ready = join(fixture.directory, "stubborn-ready");
  await writeFile(
    script,
    `#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' "$PWD" >> '${ready}'\nexec sleep 300\n`,
  );
  await chmod(script, 0o755);
  const editors = new EditorSessions([fixture.repository], () => {}, { executable: script });
  const feature = fixture.repository.worktrees.find((tree) => tree.path === fixture.feature)!.id;
  try {
    const removed = expectOk(await editors.open(fixture.main));
    const sibling = expectOk(await editors.open(feature));
    const removedPid = editors.infos.find((info) => info.id === removed)!.pid;
    const siblingPid = editors.infos.find((info) => info.id === sibling)!.pid;
    await until(() => {
      const lines = readFileSync(ready, { encoding: "utf8", flag: "a+" }).trim().split("\n");
      return lines.filter(Boolean).length === 2;
    });

    // SIGTERM is ignored, so termination must escalate instead of waiting indefinitely.
    const started = performance.now();
    expectOk(await editors.destroyWorktrees(new Set([fixture.main])));
    expect(performance.now() - started).toBeGreaterThan(1500);

    expect(pidAlive(removedPid)).toBe(false);
    expect(pidAlive(siblingPid)).toBe(true);
    expect(editors.infos.map((info) => info.id)).toEqual([sibling]);
    expect(editors.retainedWorktreeIds).toEqual(new Set([feature]));
    expect(expectError(editors.attach(removed, "late")).code).toBe("EDITOR_NOT_OPEN");
    expect(expectError(await editors.open(fixture.main)).code).toBe("EDITOR_NOT_OPEN");
    expectOk(await editors.destroyWorktrees(new Set([fixture.main])));

    // Only an explicit release opens a fresh generation for a recreated directory.
    expectOk(editors.releaseWorktrees(new Set([fixture.main])));
    expect(expectOk(await editors.open(fixture.main))).not.toBe(removed);
  } finally {
    expectOk(await editors.destroyWorktrees(new Set([fixture.main, feature])));
    expectOk(await editors.stop());
    await fixture.cleanup();
  }
}, 15000);
