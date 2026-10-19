import { expect, test } from "bun:test";
import { type EmbeddedTerminalRenderable, type InputRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { EditorError } from "../../errors.ts";
import { ok } from "../../result.ts";
import type { EditorFrame } from "../../runtime/protocol.ts";

type Size = { cols: number; rows: number };
async function mount() {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const requests: Size[] = [], inputs: string[] = [];
  let held = false, revision = 0, attaches = 0;
  let receive: (frame: EditorFrame) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const publish = (size: Size, exited = false) => receive({ id: "editor", worktreeId: "demo:main", pid: 123,
    ...size, revision: revision++, exited, exitCode: exited ? 0 : null,
    ansi: `\x1bc\x1b[1;1HUNSAVED-BUFFER\x1b[${size.rows};${size.cols - 4}HRIGHT\x1b[2;4H` });
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {}, onPrompt: () => ok(undefined),
    initialDrafts: { a1: "keep draft" }, editor: {
      info: () => ({ id: "editor", worktreeId: "demo:main", pid: 123, exited: false, exitCode: null }),
      open: async () => { throw new Error("A resize must not restart Neovim."); },
      attach: async (_id, frame, failed) => {
        attaches++; receive = frame; fail = failed; publish({ cols: 76, rows: 21 });
        return ok({ input: (bytes) => inputs.push(new TextDecoder().decode(bytes)),
          resize: (cols, rows) => { requests.push({ cols, rows }); if (!held) publish({ cols, rows }); }, disconnect: async () => {} });
      },
    } });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const leader = (key: string) => { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); };
  leader("2"); await render(); await app.waitFor(() => app.renderer.currentFocusedRenderable?.id.startsWith("editor-terminal:") === true);
  await render(); held = true; requests.length = 0;
  const surface = app.renderer.currentFocusedRenderable as EmbeddedTerminalRenderable;
  const sidebar = app.renderer.root.findDescendantById("workspace-sidebar")!;
  return { ...app, view, selection, render, leader, surface, sidebar, requests, inputs, publish,
    fail: () => fail(new EditorError("EDITOR_UNAVAILABLE", "Attachment lost during resize.")), get attaches() { return attaches; },
    async close() { view.dispose(); await app.dispose(); } };
}

function record(app: Awaited<ReturnType<typeof mount>>) {
  const frames: { sidebar: boolean; text: string; right: number }[] = [];
  const capture = () => {
    const text = app.captureCharFrame();
    frames.push({ sidebar: app.sidebar.visible, text, right: text.split("\n")[app.surface.y + app.surface.height - 1]!.indexOf("RIGHT") });
  };
  app.renderer.on("frame", capture);
  return { frames, stop: () => app.renderer.off("frame", capture) };
}

test("Editor는 새 너비 화면을 받기 전 레이아웃을 유지하고 첫 전환 프레임부터 오른쪽 끝을 맞춘다", async () => {
  // 실제 native VT를 사용하고 별도 프로세스의 리사이즈 응답만 지연한다.
  const app = await mount(), captured = record(app);
  try {
    app.leader("b"); await app.render();

    // 새 화면을 기다리는 동안 기존 사이드바와 미저장 화면을 그대로 표시한다.
    expect(app.requests.at(-1)).toEqual({ cols: 116, rows: 21 });
    expect(app.sidebar.visible).toBe(true); expect(app.surface.width).toBe(76);
    expect(app.captureCharFrame()).toContain("UNSAVED-BUFFER");
    app.publish(app.requests.at(-1)!); await app.renderOnce();

    // 레이아웃이 바뀐 첫 표시 프레임에 이미 새 VT가 반영되어야 한다.
    expect(app.sidebar.visible).toBe(false); expect(app.surface.width).toBe(116);
    expect(captured.frames.length).toBeGreaterThan(0);
    expect(captured.frames.every((frame) => frame.right === 113 && frame.text.includes("UNSAVED-BUFFER"))).toBe(true);
    expect(app.renderer.currentFocusedRenderable).toBe(app.surface); expect(app.inputs).toEqual([]);
    expect(app.attaches).toBe(1); expect(app.view.promptDrafts.a1).toBe("keep draft");

    // 반대 방향도 새 화면이 도착하기 전에 넓은 기존 화면을 잘라내지 않는다.
    app.leader("b"); await app.render(); expect(app.sidebar.visible).toBe(false);
    app.publish(app.requests.at(-1)!); await app.renderOnce(); expect(app.sidebar.visible).toBe(true);
    expect(captured.frames.every((frame) => frame.right === 113)).toBe(true);
  } finally { captured.stop(); await app.close(); }
});

test("화면 준비 중에도 같은 Editor 입력과 포커스를 유지하고 토글 키는 PTY로 보내지 않는다", async () => {
  const app = await mount();
  try {
    app.leader("b"); await app.render();
    await app.mockInput.typeText("EDIT");
    expect(app.inputs.join("")).toBe("EDIT"); expect(app.renderer.currentFocusedRenderable).toBe(app.surface);
    app.publish(app.requests.at(-1)!); await app.render();
    expect(app.inputs.join("")).toBe("EDIT"); expect(app.attaches).toBe(1);
  } finally { await app.close(); }
});

test("너비 상한으로 실제 PTY 크기가 같으면 오지 않을 리사이즈 응답을 기다리지 않는다", async () => {
  const app = await mount();
  try {
    app.resize(600, 24); await app.render(); app.publish(app.requests.at(-1)!); await app.render();
    expect(app.surface.width).toBe(500);
    const requests = app.requests.length;
    app.leader("b"); await app.render();
    expect(app.sidebar.visible).toBe(false); expect(app.surface.width).toBe(500); expect(app.requests).toHaveLength(requests);
  } finally { await app.close(); }
});

test("준비 중 반대 토글은 즉시 원래 의도로 돌아가고 늦은 확대 화면이 다시 사이드바를 닫지 않는다", async () => {
  const app = await mount(), captured = record(app);
  try {
    // 확대 응답보다 사용자의 반대 토글이 먼저 들어온다.
    app.leader("b"); await app.render(); const old = app.requests.at(-1)!;
    app.leader("b"); await app.render(); expect(app.sidebar.visible).toBe(true);
    expect(app.requests.at(-1)).toEqual({ cols: 76, rows: 21 });

    app.publish(old); await app.render();
    expect(app.sidebar.visible).toBe(true); expect(app.surface.width).toBe(76);
    app.publish(app.requests.at(-1)!); await app.render();
    expect(captured.frames.every((frame) => frame.sidebar && frame.right === 113)).toBe(true);
    expect(app.renderer.currentFocusedRenderable).toBe(app.surface); expect(app.inputs).toEqual([]);
  } finally { captured.stop(); await app.close(); }
});

test("연속 세 번 토글은 마지막 숨김 의도를 반영하고 중간 크기 프레임은 현재 화면에 쓰지 않는다", async () => {
  const app = await mount(), captured = record(app);
  try {
    app.leader("b"); await app.render(); app.leader("b"); await app.render(); app.leader("b"); await app.render();
    const final = app.requests.at(-1)!;
    expect(final.cols).toBe(116); expect(app.sidebar.visible).toBe(true);

    app.publish(final); await app.renderOnce(); expect(app.sidebar.visible).toBe(false);
    app.publish({ cols: 76, rows: 21 }); await app.render();
    expect(app.sidebar.visible).toBe(false); expect(app.surface.width).toBe(116);
    expect(captured.frames.every((frame) => frame.right === 113)).toBe(true);
  } finally { captured.stop(); await app.close(); }
});

test("준비 중 Agents로 이동하면 마지막 사이드바 의도는 적용하되 늦은 Editor 응답이 화면을 되돌리지 않는다", async () => {
  const app = await mount();
  try {
    app.leader("b"); await app.render(); const old = app.requests.at(-1)!;
    app.leader("1"); await app.render();
    expect(app.sidebar.visible).toBe(false); expect(app.renderer.root.findDescendantById("agent-view")!.visible).toBe(true);
    app.publish(old); await app.render();
    expect(app.renderer.root.findDescendantById("editor-view")!.visible).toBe(false);
    expect(app.selection.sessionId).toBe("a1"); expect(app.view.promptDrafts.a1).toBe("keep draft");
  } finally { await app.close(); }
});

test("실제 창 크기 변경은 준비 중이던 옛 치수를 무효화하며 늦은 응답으로 사이드바가 복원되지 않는다", async () => {
  const app = await mount();
  try {
    app.leader("b"); await app.render(); const old = app.requests.at(-1)!;
    app.resize(100, 28); await app.render();
    expect(app.sidebar.visible).toBe(false); expect(app.surface.width).toBe(96);
    app.publish(old); await app.render(); expect(app.sidebar.visible).toBe(false);
    app.publish(app.requests.at(-1)!); await app.render();
    expect(app.surface.width).toBe(96); expect(app.renderer.currentFocusedRenderable).toBe(app.surface);
  } finally { await app.close(); }
});

test("검색 포커스 명령은 준비를 취소하고 바로 뒤의 입력을 Editor가 아닌 검색창으로 보낸다", async () => {
  const app = await mount();
  try {
    app.leader("b"); await app.render(); const old = app.requests.at(-1)!;
    app.leader("f"); await app.mockInput.typeText("query"); await app.render();
    expect(app.sidebar.visible).toBe(true); expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
    expect((app.renderer.currentFocusedRenderable as InputRenderable).value).toBe("query");
    app.publish(old); await app.render();
    expect(app.sidebar.visible).toBe(true); expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-search");
    expect(app.inputs).toEqual([]);
  } finally { await app.close(); }
});

test("준비 중 열린 History 팝업은 늦은 Editor 화면이 도착해도 포커스를 빼앗기지 않는다", async () => {
  const app = await mount();
  try {
    app.leader("b"); await app.render(); const pending = app.requests.at(-1)!;
    app.leader("h"); await app.render(); const focused = app.renderer.currentFocusedRenderable;
    app.publish(pending); await app.render();
    expect(app.sidebar.visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(focused);
    expect(app.renderer.root.findDescendantById("session-history")!.visible).toBe(true); expect(app.inputs).toEqual([]);
  } finally { await app.close(); }
});

test("준비 중 Editor가 종료되면 사이드바 전환을 끝내고 종료 안내를 유지한다", async () => {
  const app = await mount();
  try {
    app.leader("b"); await app.render();
    app.publish(app.requests.at(-1)!, true); await app.render();
    expect(app.sidebar.visible).toBe(false); expect(app.captureCharFrame()).toContain("Neovim exited (0)");
    expect(app.attaches).toBe(1);
  } finally { await app.close(); }
});

test("준비 중 화면을 제거한 뒤 늦은 응답은 파괴된 UI를 갱신하지 않는다", async () => {
  const app = await mount();
  try {
    app.leader("b"); await app.render(); const pending = app.requests.at(-1)!;
    app.view.dispose(); app.publish(pending); await app.render();
    expect(app.renderer.root.findDescendantById("workspace-screen")).toBeUndefined();
    expect(app.attaches).toBe(1);
  } finally { await app.close(); }
});

test("준비 중 연결 실패가 발생해도 사이드바는 마지막 의도로 전환되고 명시적 재접속 안내가 남는다", async () => {
  const app = await mount();
  try {
    app.leader("b"); await app.render();
    app.fail(); await app.render();
    expect(app.sidebar.visible).toBe(false); expect(app.captureCharFrame()).toContain("Editor unavailable");
    app.leader("b"); await app.render(); expect(app.sidebar.visible).toBe(true);
    expect(app.attaches).toBe(1);
  } finally { await app.close(); }
});
