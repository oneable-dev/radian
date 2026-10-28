import { openWorkspaceSearch } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { icons } from "../../icons.ts";
import { ok } from "../../result.ts";
import type { Repository } from "../../workspace/model.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

test("Delayed connections preserve other-repository drafts and restore saved sessions/input", async () => {
  const setup = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const repositories: Repository[] = ["A", "B"].map((name) => ({
    id: name,
    name: `${name}-repo`,
    worktrees: [
      {
        id: `tree-${name}`,
        path: `/${name}`,
        name: `${name}-folder`,
        branch: "main",
        sessions:
          name === "A" ? [{ id: "a1", name: "A session", status: null, subagents: [] }] : [],
      },
    ],
  }));
  const selection = new WorkspaceSelection(repositories);
  let cold = true;
  // B is disconnected but has a session draft saved by a previous TUI.
  const view = new Workbench(setup.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    onPrompt: async () => ok(undefined),
    initialDrafts: { a1: "draft A", b2: "retained draft B" },
    getRetainedSessionIds: () => new Set(cold ? ["b2"] : []),
  });
  try {
    await setup.renderOnce();
    expect(view.promptDrafts.b2).toBe("retained draft B");

    // Open B when its actual session snapshot arrives late.
    cold = false;
    selection.replaceSnapshot(
      repositories.map((repo) =>
        repo.id !== "B"
          ? repo
          : {
              ...repo,
              worktrees: repo.worktrees.map((tree) => ({
                ...tree,
                sessions: ["b1", "b2"].map((id) => ({ id, name: id, status: null, subagents: [] })),
              })),
            },
      ),
      { "tree-B": "b2" },
    );
    await setup.renderOnce();
    openWorkspaceSearch(setup);
    await setup.renderOnce();

    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(`${icons.folder} B-folder`));

    await setup.mockMouse.click(lines[y]!.indexOf("B-folder"), y);
    await setup.renderOnce();

    // Show saved b2 and its input, not first session b1, while retaining A's draft.
    const prompt = setup.renderer.root.findDescendantById("session-prompt");
    if (!(prompt instanceof PromptInput)) {
      throw new Error("Missing session prompt.");
    }

    expect(selection.sessionId).toBe("b2");
    expect(prompt.value).toBe("retained draft B");
    expect(view.promptDrafts.a1).toBe("draft A");
    expect(setup.renderer.root.findDescendantById("workspace-picker")!.visible).toBe(false);
    expect(selection.snapshot.map((repo) => repo.name)).toEqual(["A-repo", "B-repo"]);
  } finally {
    view.dispose();
    await setup.dispose();
  }
});
