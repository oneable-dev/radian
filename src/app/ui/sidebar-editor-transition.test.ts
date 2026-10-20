import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import type { EditorFrame } from "../../runtime/protocol.ts";
import { ConnectionError, type ExpectedError } from "../../errors.ts";

async function fixture() {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const sizes: { cols: number; rows: number }[] = [], input: string[] = [];
  let receive: (frame: EditorFrame) => void = () => {}, failure: (error: ExpectedError) => void = () => {}, attaches = 0, revision = 0;
  const frame = (cols: number, rows: number): EditorFrame => ({ id: "editor", worktreeId: "demo:main", pid: 123, exited: false, exitCode: null, cols, rows, revision: revision++, ansi: "\x1bc\x1b[1;1HNATIVE_BUFFER" });
  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), { onNewSession() {}, onCloseSession() {}, editor: {
    info: id => id === "demo:main" ? { id: "editor", worktreeId: id, pid: 123, exited: false, exitCode: null } : undefined,
    open: async () => ok("editor"), attach: async (_id, onFrame, failed) => {
      attaches++; receive = onFrame; failure = failed; receive(frame(116, 23));
      return ok({ input: bytes => input.push(new TextDecoder().decode(bytes)), resize: (cols, rows) => { sizes.push({ cols, rows }); receive(frame(cols, rows)); }, disconnect: async () => {} });
    },
  } });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const leader = (key: string) => { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); };
  leader("e"); await render();
  const get = (id: string) => app.renderer.root.findDescendantById(id)!;
  return { ...app, view, sizes, input, render, leader, get, attaches: () => attaches,
    receive: () => receive(frame(sizes.at(-1)?.cols ?? 116, sizes.at(-1)?.rows ?? 23)), fail: () => failure(new ConnectionError("CONNECTION_FAILED", "Connection lost")),
    async close() { view.dispose(); await app.dispose(); } };
}

test("Editor 위의 워크스페이스 팝업은 PTY 크기·인스턴스·연결을 바꾸지 않는다", async () => {
  // overlay는 과거 sidebar resize 준비·확정 프로토콜을 사용할 필요가 없다.
  const app = await fixture();
  try {
    const surface = app.renderer.currentFocusedRenderable!, geometry = [surface.x, surface.y, surface.width, surface.height], sizes = app.sizes.length;

    app.leader("b"); await app.render(); expect(app.get("workspace-picker").visible).toBe(true);
    expect([surface.x, surface.y, surface.width, surface.height]).toEqual(geometry); expect(app.sizes).toHaveLength(sizes);
    app.mockInput.pressEscape(); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(surface); expect(app.attaches()).toBe(1); expect(app.input).toEqual([]);
    expect(app.captureCharFrame()).toContain("NATIVE_BUFFER");
  } finally { await app.close(); }
});

test("팝업 검색과 늦은 Editor 화면은 서로 포커스·입력 소유권을 빼앗지 않는다", async () => {
  // native 출력은 popup 뒤의 동일 surface에만 반영되어야 한다.
  const app = await fixture();
  try {
    app.leader("b"); await app.render(); await app.mockInput.typeText("feature");
    app.receive(); await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search"); expect(app.captureCharFrame()).toContain("feature"); expect(app.input).toEqual([]);
    app.mockInput.pressEscape(); await app.render(); expect(app.renderer.currentFocusedRenderable?.id).toStartWith("editor-terminal:");
  } finally { await app.close(); }
});

test("팝업 중 Editor 연결 실패는 검색 포커스를 유지하고 닫은 뒤 복구 안내를 제공한다", async () => {
  // 실패가 발생해도 popup 취소가 존재하지 않는 PTY를 다시 포커스하면 안 된다.
  const app = await fixture();
  try {
    app.leader("b"); await app.render(); app.fail(); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");

    app.mockInput.pressEscape(); await app.render();

    expect(app.get("workspace-picker").visible).toBe(false); expect(app.captureCharFrame()).toContain("Open / reconnect editor"); expect(app.input).toEqual([]);
  } finally { await app.close(); }
});
