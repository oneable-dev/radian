import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { Workbench } from "./workbench.ts";
import { ok } from "../../result.ts";

test("Workspace와 History는 j/k로 선택하며 입력창에서는 같은 문자를 그대로 입력한다", async () => {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace()); const opened: string[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {},
    onListHistory: async () => ok(["first", "second"].map((id) => ({ id, title: `Saved ${id}`, worktreeId: "demo:main", modified: "2026-10-15T00:00:00Z", messageCount: 1, openSessionId: null, unavailableReason: null }))),
    onResumeSession: async (_tree, id) => { opened.push(id); return ok("a1"); },
  });
  try {
    await app.renderOnce(); app.mockInput.pressKey("HOME"); app.mockInput.pressKey("j"); app.mockInput.pressKey("j"); await app.renderOnce();
    expect(selection.sessionId).toBe("a2"); app.mockInput.pressKey("k"); await app.renderOnce(); expect(selection.sessionId).toBe("a1");
    app.mockInput.pressKey("f", { ctrl: true }); await app.mockInput.typeText("hjkl"); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search"); expect(app.captureCharFrame()).toContain("hjkl");
    app.mockInput.pressEscape(); await app.renderOnce();

    const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes("History"));
    await app.mockMouse.click(lines[y]!.indexOf("History") + 1, y);
    await app.waitForFrame((frame) => frame.includes("Saved second"));
    app.renderer.root.findDescendantById("history-list")!.focus(); app.mockInput.pressKey("j"); app.mockInput.pressEnter();
    await app.waitFor(() => opened.length > 0);
    expect(opened).toEqual(["second"]);
  } finally { view.dispose(); await app.dispose(); }
});

test("사용자 키맵은 트리 명령·비활성화·푸터와 leader 뷰 전환에 함께 적용된다", async () => {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, exitOnCtrlC: false });
  const calls: string[] = [];
  const keymap = expectOk(parseKeymap({ leader: "ctrl+b", bindings: {
    "session.new": [{ keys: "s", scope: "workspace" }], "session.close": [], "view.git": ["<leader> g"],
  } }));
  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), {
    keymap, onNewSession: () => calls.push("new"), onCloseSession: () => calls.push("close"), onDetach: () => calls.push("detach"),
  });
  try {
    await app.renderOnce(); const footer = () => app.captureCharFrame().split("\n")[23]!;
    expect(footer()).toContain("s New session"); expect(footer()).not.toContain("x Close session");
    app.mockInput.pressKey("n"); app.mockInput.pressKey("x"); app.mockInput.pressKey("s");
    expect(calls).toEqual(["new"]);

    app.mockInput.pressKey("b", { ctrl: true }); app.mockInput.pressKey("g"); await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Git preview");
    app.mockInput.pressCtrlC(); expect(calls).toEqual(["new"]);
    app.mockInput.pressKey("b", { ctrl: true }); app.mockInput.pressKey("c");
    expect(calls).toEqual(["new", "detach"]);
  } finally { view.dispose(); await app.dispose(); }
});
