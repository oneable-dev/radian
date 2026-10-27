import { expect, test } from "bun:test";
import { join } from "node:path";
import { emptyPreferences, parseCommand, type RuntimePreferences } from "./protocol.ts";
import { expandPromptDraft, type PromptDraft } from "../agents/prompt-input.ts";
import { mergeWorkspacePreferences, repositoryPreferences } from "./workspace-preferences.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { connectRuntime, fetchSnapshot } from "./client.ts";
import { runtimePaths } from "./storage.ts";
import { expectError, expectOk } from "../testing/results.ts";

const imageDraft = (path: string): PromptDraft => ({
  value: "Inspect [Image #1]",
  cursor: 18,
  tokens: [{ start: 8, end: 18, part: { kind: "image", index: 1, path } }],
  next: { image: 2, file: 1, paste: 1 },
});
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Input draft runtime observation timed out");
    await Bun.sleep(15);
  }
}

test("Invalid attachment ranges fail at preference boundaries without arbitrary source expansion", () => {
  const preferences: RuntimePreferences = {
    ...structuredClone(emptyPreferences),
    drafts: { session: '@"/tmp/image.png"' },
    inputDrafts: { session: imageDraft("/tmp/image.png") },
  };
  expect(parseCommand(JSON.stringify({ type: "preferences", preferences })).ok).toBe(true);
  preferences.inputDrafts!.session!.tokens[0]!.end = 17;

  expect(expectError(parseCommand(JSON.stringify({ type: "preferences", preferences }))).code).toBe(
    "INVALID_INPUT",
  );
});

test("Merged root drafts display together while each repository saves only owned source/metadata", () => {
  const repository = demoWorkspace()[0]!;
  const a: RuntimePreferences = {
    ...structuredClone(emptyPreferences),
    drafts: { a1: '@"/tmp/a.png"' },
    inputDrafts: { a1: imageDraft("/tmp/a.png") },
  };
  const b: RuntimePreferences = {
    ...structuredClone(emptyPreferences),
    drafts: { foreign: '@"/tmp/b.png"' },
    inputDrafts: { foreign: imageDraft("/tmp/b.png") },
  };
  const merged = mergeWorkspacePreferences([a, b], repository.worktrees[0]!.id);
  const scoped = repositoryPreferences(merged, repository, a);

  expect(Object.keys(merged.inputDrafts!)).toEqual(["a1", "foreign"]);
  expect(Object.keys(scoped.inputDrafts!)).toEqual(["a1"]);
  expect(scoped.drafts).toEqual(a.drafts);
  expect(scoped.inputDrafts!.a1).toEqual(a.inputDrafts!.a1);
  merged.inputDrafts!.a1!.value = "changed";
  expect(a.inputDrafts!.a1!.value).toBe("Inspect [Image #1]");
});

test("Real IPC attachment drafts restore after reconnect and legacy input replacement never revives stale attachments", async () => {
  const fixture = await createWorktreeFixture();
  const options = {
    offline: true,
    stateRoot: join(fixture.directory, "state"),
    entry: join(import.meta.dir, "..", "index.ts"),
  };
  const paths = runtimePaths(fixture.repository.id, true, options.stateRoot);
  let client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
  if (!client) throw new Error("Missing runtime");
  try {
    const main = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
    const id = expectOk(await client.create(main.id)),
      draft = imageDraft(join(fixture.main, "image.png"));
    const preferences = structuredClone(client.snapshot.preferences);
    preferences.drafts[id] = expandPromptDraft(draft, false).text;
    preferences.inputDrafts = { [id]: draft };
    expectOk(await client.savePreferences(preferences));
    await until(() => Boolean(client!.snapshot.preferences.inputDrafts?.[id]));
    const pid = client.snapshot.pid;
    await client.disconnect();
    client = expectOk(
      await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }),
    );
    if (!client) throw new Error("Runtime was lost");

    expect(client.snapshot.pid).toBe(pid);
    expect(client.snapshot.preferences.inputDrafts?.[id]).toEqual(draft);
    expect(client.snapshot.details[id]?.output).toBe("");
    const legacy = structuredClone(client.snapshot.preferences);
    delete legacy.inputDrafts;
    legacy.drafts[id] = "new input from old client";
    expectOk(await client.savePreferences(legacy));
    await until(() => client!.snapshot.preferences.inputDrafts?.[id] === undefined);
    expect(client.snapshot.preferences.drafts[id]).toBe("new input from old client");
    // Accepted model failures stay in sessions without duplicate global notifications.
    expectOk(await client.prompt(id, "fail"));
    await until(() => client!.snapshot.details[id]?.status === "failure");
    expect(
      client.snapshot.details[id]?.sections?.some((section) =>
        section.error?.includes("Offline model failure"),
      ),
    ).toBe(true);
    expect(client.snapshot.notice).not.toContain("Offline model failure");
  } finally {
    if (client) {
      expectOk(await client.stopRuntime());
      await client.disconnect();
      await until(async () => !expectOk(await fetchSnapshot(paths)));
    }
    await fixture.cleanup();
  }
}, 20000);
