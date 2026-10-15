import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { parseKeymap } from "../keybindings/config.ts";
import { expectOk } from "../testing/results.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { WorkspaceView } from "./workspace.ts";

test("사용자 키맵은 트리 명령·비활성화·푸터와 leader 뷰 전환에 함께 적용된다", async () => {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const calls: string[] = [];
  const keymap = expectOk(parseKeymap({ leader: "ctrl+b", bindings: {
    "session.new": [{ keys: "s", scope: "workspace" }], "session.close": [], "view.git": ["<leader> g"],
  } }));
  const view = new WorkspaceView(app.renderer, new WorkspaceSelection(demoWorkspace()), {
    keymap, onNewSession: () => calls.push("new"), onCloseSession: () => calls.push("close"), onDetach: () => calls.push("detach"),
  });
  try {
    await app.renderOnce(); const footer = () => app.captureCharFrame().split("\n")[23]!;
    expect(footer()).toContain("s New session"); expect(footer()).not.toContain("x Close session");
    app.mockInput.pressKey("n"); app.mockInput.pressKey("x"); app.mockInput.pressKey("s");
    expect(calls).toEqual(["new"]);

    app.mockInput.pressKey("b", { ctrl: true }); app.mockInput.pressKey("g"); await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Native Git UI is planned");
    app.mockInput.pressCtrlC(); expect(calls).toEqual(["new"]);
    app.mockInput.pressKey("b", { ctrl: true }); app.mockInput.pressKey("c");
    expect(calls).toEqual(["new", "detach"]);
  } finally { view.dispose(); await app.dispose(); }
});
