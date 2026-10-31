import { openWorkspaceSearch, submitPromptCommand } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { Workbench } from "./workbench.ts";
import { ok } from "../../result.ts";

test("Workspace j/k browses and Enter switches while identical input characters stay literal", async () => {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const opened: string[] = [];
  const sent: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    onPrompt: (_id, text) => {
      sent.push(text);

      return ok(undefined);
    },
    onListHistory: async (worktreeId) =>
      ok(
        ["first", "second"].map((id) => ({
          id,
          title: `Saved ${id}`,
          worktreeId,
          modified: "2026-10-15T00:00:00Z",
          messageCount: 1,
          openSessionId: null,
          unavailableReason: null,
        })),
      ),
    onResumeSession: async (tree, id) => {
      opened.push(id);

      return ok(tree === "demo:main" ? "a1" : "b1");
    },
  });
  try {
    await app.renderOnce();
    openWorkspaceSearch(app);
    app.mockInput.pressTab();
    app.mockInput.pressKey("HOME");
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");
    await app.renderOnce();
    expect(selection.worktree?.id).toBe("demo:main");
    expect(selection.sessionId).toBe("a1");
    app.mockInput.pressKey("k");
    app.mockInput.pressEnter();
    await app.renderOnce();
    expect(selection.worktree?.id).toBe("demo:feature");
    expect(selection.sessionId).toBe("b1");
    openWorkspaceSearch(app);
    await app.mockInput.typeText("hjkl");
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
    expect(app.captureCharFrame()).toContain("hjkl");
    app.mockInput.pressEscape();
    await app.renderOnce();

    submitPromptCommand(app, "/history");
    await app.waitForFrame((frame) => frame.includes("Saved second"));
    app.renderer.root.findDescendantById("history-list")!.focus();
    app.mockInput.pressKey("j");
    app.mockInput.pressEnter();
    await app.waitFor(() => opened.length > 0);
    expect(opened).toEqual(["second"]);
    expect(sent).toEqual([]);
  } finally {
    view.dispose();
    await app.dispose();
  }
});

test("User keymaps control tree commands, disabling, and view switching without footer hints", async () => {
  const app = await createTestRenderer({
    width: 120,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const calls: string[] = [];
  const keymap = expectOk(
    parseKeymap({
      leader: "ctrl+b",
      bindings: {
        "tab.new": [{ keys: "ctrl+s", scope: "prompt" }],
        "tab.close": [],
        "view.git": ["<leader> g"],
      },
    }),
  );
  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), {
    keymap,
    onNewSession: () => calls.push("new"),
    onCloseSession: () => calls.push("close"),
    onDetach: () => calls.push("detach"),
    onPrompt: () => ok(undefined),
  });
  try {
    await app.renderOnce();

    const footer = () => app.captureCharFrame().split("\n")[23]!;
    app.mockInput.pressKey("b", { ctrl: true });
    app.mockInput.pressKey("b");
    app.mockInput.pressTab();
    await app.renderOnce();
    expect(footer()).not.toContain("<CR> Open worktree");
    expect(footer()).not.toContain("New session");
    app.mockInput.pressEscape();
    await app.renderOnce();
    expect(footer()).not.toContain("<C-s> New session");
    expect(footer()).not.toContain("Close tab");
    app.mockInput.pressKey("b", { ctrl: true });
    app.mockInput.pressKey("x");
    app.mockInput.pressKey("n");
    app.mockInput.pressKey("x");
    app.mockInput.pressKey("s", { ctrl: true });
    expect(calls).toEqual(["new"]);

    app.mockInput.pressKey("b", { ctrl: true });
    app.mockInput.pressKey("g");
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Git preview");
    app.mockInput.pressCtrlC();
    expect(calls).toEqual(["new"]);
    app.mockInput.pressKey("b", { ctrl: true });
    app.mockInput.pressKey("d");
    expect(calls).toEqual(["new", "detach"]);
  } finally {
    view.dispose();
    await app.dispose();
  }
});
