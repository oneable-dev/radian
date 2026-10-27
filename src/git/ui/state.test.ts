import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { GitPanel } from "./panel.ts";
import { initialGitState, type GitSnapshot, type GitViewState } from "../model.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";

test("Hiding loading screens never overwrites saved scroll with empty placeholder heights", async () => {
  // Saved history positions belong to real content, not a one-row loading placeholder.
  const app = await createTestRenderer({ width: 120, height: 24 });
  const worktree = demoWorkspace()[0]!.worktrees[0]!;
  const pending = Promise.withResolvers<Result<GitSnapshot, ExpectedError>>();
  const state = { ...initialGitState(), historyScroll: 200, filesScroll: 12 };
  let retained: GitViewState | undefined;
  const panel = new GitPanel(
    app.renderer,
    {
      source: () => ({
        load: () => pending.promise,
        details: async () => err(new InputError("unused")),
        compare: async () => err(new InputError("unused")),
      }),
      createSession: async () => err(new InputError("unused")),
      prompt: () => ok(undefined),
    },
    () => {},
    () => {},
    (_id, value) => {
      retained = value;
    },
    { [worktree.id]: state },
    () => "",
  );
  app.renderer.root.add(panel.root);
  try {
    panel.show(worktree, null);
    await app.renderOnce();

    panel.hide();

    expect(retained?.historyScroll).toBe(200);
    expect(retained?.filesScroll).toBe(12);
  } finally {
    pending.resolve(
      ok({ commits: [], refs: [], files: [], reflog: [], head: "main", headOid: null }),
    );
    panel.dispose();
    await app.dispose();
  }
});
