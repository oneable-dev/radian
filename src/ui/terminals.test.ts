import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { parseKeypress } from "@opentui/core";
import { WorkspaceView } from "./workspace.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { ok } from "../result.ts";
import type { TerminalInfo, WorkViewPreferences } from "../runtime/protocol.ts";
import type { TerminalActions } from "./terminals.ts";

async function mount(initial?: WorkViewPreferences) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, exitOnCtrlC: false });
  const selection = new WorkspaceSelection(demoWorkspace());
  let items: TerminalInfo[] = []; let sequence = 0;
  const created: string[] = [], closed: string[] = [], inputs: string[] = [], detaches: string[] = [], commands: string[] = [];
  const actions: TerminalActions = {
    list: () => items,
    create: async (tree) => {
      const id = `shell-${++sequence}`; created.push(tree);
      items.push({ id, worktreeId: tree, title: `Terminal ${sequence}`, pid: 100 + sequence, shellPid: 200 + sequence, exited: false, exitCode: null });
      selection.replaceSnapshot(selection.snapshot); return ok(id);
    },
    close: async (id) => { closed.push(id); items = items.filter((item) => item.id !== id); selection.replaceSnapshot(selection.snapshot); return ok(undefined); },
    attach: async (id, receive) => {
      let revision = 0, offset = 0, cols = 80, rows = 24;
      const send = () => { const item = items.find((item) => item.id === id)!; receive({ ...item, cols, rows, revision: revision++, ansi: `\x1bcShell ${id} log ${offset}`, scrollback: { offset, available: 100, enabled: true } }); };
      send();
      return ok({ input: (data) => inputs.push(Buffer.from(data).toString("hex")), resize: (width, height) => { cols = width; rows = height; send(); },
        scroll: (lines) => { offset = Math.max(0, Math.min(100, offset - lines)); send(); }, disconnect: async () => { detaches.push(id); } });
    },
  };
  const view = new WorkspaceView(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {}, onDetach: () => commands.push("detach"), terminal: actions,
    ...(initial ? { initialWorkViews: initial } : {}) });
  await app.renderOnce();
  return { ...app, selection, view, actions, created, closed, inputs, detaches, commands,
    exit(id: string) { items = items.filter((item) => item.id !== id); selection.replaceSnapshot(selection.snapshot); },
    async click(text: string, right = false) {
      const lines = app.captureCharFrame().split("\n");
      const start = right ? (app.renderer.width < 80 ? 26 : 36) : 0;
      const y = lines.findIndex((line) => line.indexOf(text, start) >= 0), x = lines[y]?.indexOf(text, start) ?? -1;
      if (x < 0) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
      await app.mockMouse.click(x, y); await app.renderOnce();
    },
    async visible(text: string) {
      const deadline = Date.now() + 3000;
      while (!app.captureCharFrame().includes(text)) { if (Date.now() > deadline) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`); await app.renderOnce(); await Bun.sleep(1); }
    },
    leader(key: string) { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test("Terminal은 명시적으로 여러 쉘을 만들고 워크트리별 목록과 마지막 선택을 복원한다", async () => {
  const app = await mount();
  try {
    await app.click("Terminal", true); expect(app.created).toEqual([]);
    await app.click("+ New", true); await app.visible("Shell shell-1");
    app.leader("t"); await app.visible("Shell shell-2");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    await app.click("Terminal 1", true); await app.visible("Shell shell-1");
    await app.click("radian-ui (feature"); await app.click("Terminal", true); await app.click("+ New", true); await app.visible("Shell shell-3");

    await app.click("radian (main)"); await app.visible("Shell shell-1");

    expect(app.view.workViewPreferences.terminalSelection).toEqual({ "demo:main": "shell-1", "demo:feature": "shell-3" });
    expect(app.created).toEqual(["demo:main", "demo:main", "demo:feature"]);
    expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("활성 하위 탭 닫기는 다음·이전·빈 상태로 이동하며 마지막 탭을 자동 생성하지 않는다", async () => {
  const app = await mount();
  try {
    app.leader("t"); await app.visible("Shell shell-1"); app.leader("t"); await app.visible("Shell shell-2"); app.leader("t"); await app.visible("Shell shell-3");
    await app.click("Terminal 2", true); await app.visible("Shell shell-2");
    app.leader("x"); await app.visible("Shell shell-3");
    app.leader("x"); await app.visible("Shell shell-1");
    app.leader("x"); await app.visible("No terminals");

    expect(app.closed).toEqual(["shell-2", "shell-3", "shell-1"]);
    expect(app.created).toHaveLength(3); expect(app.view.workViewPreferences.active["demo:main"]).toBe("terminal");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBeUndefined();
  } finally { await app.close(); }
});

test("쉘이 종료된 탭은 이웃 탭으로 이동하고 마지막 종료는 새 터미널 없이 빈 화면을 남긴다", async () => {
  // 서버가 종료된 탭을 목록에서 제거하는 동안 현재 터미널 입력에 포커스가 있다.
  const app = await mount();
  try {
    app.leader("t"); await app.visible("Shell shell-1");
    app.leader("t"); await app.visible("Shell shell-2");
    app.leader("t"); await app.visible("Shell shell-3");
    await app.click("Terminal 2", true);

    // 가운데 탭의 자연 종료는 다음 이웃을, 마지막 탭의 종료는 이전 이웃을 고른다.
    app.exit("shell-2"); await app.visible("Shell shell-3");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-3");
    app.exit("shell-3"); await app.visible("Shell shell-1");
    app.exit("shell-1"); await app.visible("No terminals");

    expect(app.captureCharFrame()).not.toContain("Terminal 1");
    expect(app.created).toHaveLength(3);
    expect(app.closed).toEqual([]);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBeUndefined();
    expect(app.captureCharFrame().trimEnd().split("\n").at(-1)).toContain("Enter/Space New terminal");
    await app.click("Agent", true); await app.click("Terminal", true);
    expect(app.captureCharFrame()).toContain("No terminals");
    expect(app.created).toHaveLength(3);
  } finally { await app.close(); }
});

test("Ctrl+C는 native 입력이고 leader는 앱 분리·탭 전환·로그 스크롤을 제어한다", async () => {
  const app = await mount();
  try {
    app.leader("t"); await app.visible("Shell shell-1"); app.leader("t"); await app.visible("Shell shell-2");
    app.leader("["); await app.visible("Shell shell-1");
    app.mockInput.pressCtrlC();
    app.renderer.keyInput.processParsedKey(parseKeypress("\x1b[5;2~")!); await app.visible("scrollback");
    expect(app.inputs).toContain("03"); expect(app.commands).toEqual([]);
    await app.mockMouse.scroll(70, 10, "up"); await app.renderOnce();
    expect(app.captureCharFrame()).toContain("scrollback");
    app.leader("c"); expect(app.commands).toEqual(["detach"]);
    expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("여러 하위 탭과 좁은 화면에서도 선택한 탭과 생성·닫기 버튼을 표시한다", async () => {
  const app = await mount();
  try {
    for (let i = 1; i <= 6; i++) { app.leader("t"); await app.visible(`Shell shell-${i}`); }
    await app.renderOnce();
    expect(app.captureCharFrame().split("\n")[1]).toContain("[Terminal 6]");
    app.resize(60, 12); await app.renderOnce(); await app.renderOnce();
    const row = app.captureCharFrame().split("\n")[1]!;
    expect(row).toContain("[Terminal 6]"); expect(row).toContain("+ New"); expect(row).toContain("Close");
  } finally { await app.close(); }
});

test("늦은 터미널 생성 결과는 다른 워크트리의 Git 화면이나 선택을 빼앗지 않는다", async () => {
  const app = await mount(); const ready = Promise.withResolvers<ReturnType<typeof ok<string>>>();
  const create = app.actions.create;
  app.actions.create = async (tree, size) => { await ready.promise; return create(tree, size); };
  try {
    app.leader("t"); await app.renderOnce();
    await app.click("radian-ui (feature"); await app.click("Git", true);
    ready.resolve(ok("ready")); await Bun.sleep(0); await app.renderOnce();

    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.view.workViewPreferences.active["demo:feature"]).toBe("git");
  } finally { ready.resolve(ok("ready")); await app.close(); }
});
