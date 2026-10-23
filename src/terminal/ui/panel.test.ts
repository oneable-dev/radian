import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { parseKeypress, TextAttributes, TextRenderable } from "@opentui/core";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons } from "../../icons.ts";
import { err, ok } from "../../result.ts";
import { PtyError } from "../../errors.ts";
import { uiTheme } from "../../ui/theme.ts";
import { parseKeymap, type Keymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import type { TerminalInfo, WorkViewPreferences } from "../../runtime/protocol.ts";
import type { TerminalActions } from "./panel.ts";

async function mount(initial?: WorkViewPreferences, clock?: ManualClock, keymap?: Keymap) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, exitOnCtrlC: false, ...(clock ? { clock } : {}) });
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
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {}, onDetach: () => commands.push("detach"), terminal: actions,
    ...(initial ? { initialWorkViews: initial } : {}), ...(keymap ? { keymap } : {}) });
  await app.renderOnce();
  return { ...app, selection, view, actions, created, closed, inputs, detaches, commands,
    exit(id: string) { items = items.filter((item) => item.id !== id); selection.replaceSnapshot(selection.snapshot); },
    async showView(key: "a" | "e" | "g" | "t") {
      app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); await app.renderOnce();
    },
    async createTerminal() {
      app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("t"); await app.renderOnce();
    },
    async click(text: string, right = false) {
      if (text.startsWith(icons.folder) && !app.renderer.root.findDescendantById("workspace-sidebar")!.visible) {
        app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("b"); await app.renderOnce(); await app.renderOnce();
      }
      const lines = app.captureCharFrame().split("\n");
      const start = right ? app.renderer.root.findDescendantById("work-panel")!.x : 0;
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

test("복원한 Terminal 화면에 열린 쉘이 없으면 기본 쉘 하나를 생성한다", async () => {
  // 런타임 재시작 뒤에는 이전 화면과 사라진 터미널 선택만 복원된다.
  const app = await mount({ active: { "demo:main": "terminal" }, agentScroll: {}, terminalSelection: { "demo:main": "stale" } });
  try {
    // 복원된 화면의 첫 렌더가 기본 쉘 준비를 완료한다.
    await app.visible("Shell shell-1");

    // 이전 명령이나 사라진 선택 대신 새 쉘 하나만 활성화된다.
    expect(app.created).toEqual(["demo:main"]);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-1");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.inputs).toEqual([]);
  } finally { await app.close(); }
});

test("Terminal leader+c selects new tabs without sending shell control characters", async () => {
  // Request another terminal while the default shell owns input.
  const app = await mount();
  try {
    await app.showView("t"); await app.visible("Shell shell-1");
    expect(app.captureCharFrame().trimEnd().split("\n").at(-1)).toContain("<leader>c New terminal");

    // Creation shortcuts during input prepare a second shell.
    app.leader("c"); await app.visible("Shell shell-2");

    // 새 탭이 입력을 소유하고 leader 시퀀스는 어느 PTY에도 전달되지 않는다.
    expect(app.created).toEqual(["demo:main", "demo:main"]);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.inputs).toEqual([]);
  } finally { await app.close(); }
});

test("터미널 입력의 Ctrl+N/P는 쉘에 전달하고 새 탭을 만들지 않는다", async () => {
  // 생성과 탐색을 분리한 뒤 PTY가 원래 readline 키를 소유한다.
  const app = await mount();
  try {
    await app.showView("t"); await app.visible("Shell shell-1");

    // 쉘에서 다음·이전 입력 키를 직접 누른다.
    app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("p", { ctrl: true }); await app.renderOnce();

    // 제어 바이트를 그대로 전달하며 쉘과 선택을 추가 생성으로 바꾸지 않는다.
    expect(app.inputs).toContain("0e"); expect(app.inputs).toContain("10");
    expect(app.created).toEqual(["demo:main"]);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-1");
  } finally { await app.close(); }
});

test("Snapshots and creation shortcuts during default startup never duplicate terminals", async () => {
  // Delay the first request at slow shell startup boundaries.
  const app = await mount(), ready = Promise.withResolvers<void>();
  const create = app.actions.create; let attempts = 0;
  app.actions.create = async (tree, size) => { attempts++; await ready.promise; return create(tree, size); };
  try {
    // 같은 화면을 다시 그리고 명시적 생성도 요청한다.
    await app.showView("t"); app.selection.replaceSnapshot(app.selection.snapshot);
    app.leader("t"); app.leader("c"); app.mockInput.pressKey("n", { ctrl: true });
    await app.renderOnce(); await app.renderOnce();

    // 최초 요청 하나만 실행하고 완료된 쉘을 활성화한다.
    expect(attempts).toBe(1);
    expect(app.renderer.root.findDescendantById("terminal-empty-state")!.visible).toBe(false);
    ready.resolve(); await app.visible("Shell shell-1");
    expect(app.created).toEqual(["demo:main"]); expect(app.inputs).toEqual([]);
  } finally { ready.resolve(); await app.close(); }
});

test("쉘 시작 전에 Terminal을 나갔다 바로 돌아와도 기본 쉘 하나를 생성한다", async () => {
  // 최초 레이아웃 전에 화면 전환이 겹치면 취소된 생성 요청이 남아 있을 수 있다.
  const app = await mount();
  try {
    // 같은 입력 묶음에서 Terminal을 다시 열어 최신 진입 요청을 남긴다.
    app.leader("t"); app.leader("g"); app.leader("t");
    await app.visible("Shell shell-1");

    // 취소된 진입은 생성하지 않고 최종 화면만 쉘 하나를 소유한다.
    expect(app.created).toEqual(["demo:main"]);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally { await app.close(); }
});

test.each(["before-layout", "during-startup"] as const)("Search opened at %s retains query/focus through late default-shell creation", async timing => {
  // Allow search input while startup responses remain pending.
  const app = await mount(), ready = Promise.withResolvers<void>();
  const create = app.actions.create;
  app.actions.create = async (tree, size) => { await ready.promise; return create(tree, size); };
  try {
    app.leader("t");
    if (timing === "during-startup") { await app.renderOnce(); await app.renderOnce(); }

    // Enter workspace search before creation completes.
    app.leader("b"); await app.mockInput.typeText("feature"); await app.renderOnce();
    const focused = app.renderer.currentFocusedRenderable;
    ready.resolve(); await app.visible("Shell shell-1");

    // 탭은 백그라운드에 준비되지만 검색을 계속 입력할 수 있다.
    expect(app.renderer.currentFocusedRenderable).toBe(focused);
    expect(app.captureCharFrame()).toContain("feature");
    expect(app.created).toEqual(["demo:main"]); expect(app.inputs).toEqual([]);
  } finally { ready.resolve(); await app.close(); }
});

test("Default-shell failures never auto-retry and leader+c explicitly requests recovery", async () => {
  // Reject only the first startup with an operational error.
  const app = await mount(), create = app.actions.create; let attempts = 0;
  app.actions.create = async (tree, size) => ++attempts === 1 ? err(new PtyError("PTY_UNAVAILABLE", "Shell startup denied.")) : create(tree, size);
  try {
    // 실패 후 스냅샷 갱신과 같은 화면 선택은 새 시도를 만들지 않는다.
    await app.showView("t"); await app.visible("Shell startup denied.");
    app.selection.replaceSnapshot(app.selection.snapshot); app.leader("t"); await app.renderOnce();

    // 빈 화면은 단축키로 복구할 수 있으며 성공한 쉘만 탭에 남는다.
    expect(attempts).toBe(1); expect(app.created).toEqual([]);
    app.leader("c"); await app.visible("Shell shell-1");
    expect(attempts).toBe(2); expect(app.created).toEqual(["demo:main"]);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally { await app.close(); }
});

test.each(["disabled", "rebound"] as const)("새 탭 단축키가 %s이면 기본 Ctrl+N은 쉘로 전달하고 안내도 설정을 따른다", async mode => {
  // 새 탭 명령 전체를 끄거나 다른 터미널 키로 대체한다.
  const keymap = expectOk(parseKeymap({ bindings: { "tab.new": mode === "disabled" ? [] : [{ keys: "alt+n", scope: "terminal" }] } }));
  const app = await mount(undefined, undefined, keymap);
  try {
    await app.showView("t"); await app.visible("Shell shell-1");

    // 사용자 설정이 기본 Ctrl+N보다 우선한다.
    app.mockInput.pressKey("n", { ctrl: true }); await app.renderOnce();

    // 기본 키는 native 입력으로 돌아가고 안내에는 실제 키만 표시한다.
    expect(app.inputs).toContain("0e"); expect(app.created).toHaveLength(1);
    const footer = app.captureCharFrame().trimEnd().split("\n").at(-1)!;
    expect(footer).not.toContain("<C-n>");
    if (mode === "disabled") expect(footer).not.toContain("New terminal");
    else {
      expect(footer).toContain("<M-n> New terminal");
      app.mockInput.pressKey("n", { meta: true }); await app.visible("Shell shell-2");
      expect(app.created).toHaveLength(2);
    }
  } finally { await app.close(); }
});

test.each(["arrows", "vim", "control"] as const)("Terminal-tab %s navigation starts from focused tabs without forwarding shell input", async navigation => {
  // Navigate from focused inactive tabs, even when active terminals differ.
  const app = await mount();
  const tab = (id: string) => app.renderer.root.findDescendantById(`terminal-tab:${id}`)!.getChildren()[0]!;
  const move = (next: boolean) => navigation === "arrows" ? app.mockInput.pressArrow(next ? "right" : "left")
    : navigation === "control" ? app.mockInput.pressKey(next ? "n" : "p", { ctrl: true }) : app.mockInput.pressKey(next ? "l" : "h");
  try {
    await app.createTerminal(); await app.visible("Shell shell-1");
    app.leader("c"); await app.visible("Shell shell-2"); app.leader("c"); await app.visible("Shell shell-3");
    tab("shell-1").focus(); await app.renderOnce();

    // 연결 완료가 탐색 중인 탭에서 PTY로 포커스를 빼앗지 않아야 한다.
    move(true); await app.visible("Shell shell-2");
    expect(app.renderer.currentFocusedRenderable).toBe(tab("shell-2"));
    move(true); await app.visible("Shell shell-3"); move(false); await app.visible("Shell shell-2"); await app.renderOnce();

    expect(app.renderer.currentFocusedRenderable).toBe(tab("shell-2"));
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    expect(app.inputs).toEqual([]); expect(app.created).toHaveLength(3); expect(app.closed).toEqual([]);
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).not.toContain("h/l Terminal");
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("<leader>c New terminal");
    app.mockInput.pressEnter(); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");

    // 탭 탐색을 떠나면 같은 키도 원래 쉘 입력으로 전달한다.
    app.mockInput.pressKey("h"); app.mockInput.pressKey("l");
    app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("p", { ctrl: true });
    app.mockInput.pressKey("d", { ctrl: true }); app.mockInput.pressKey("u", { ctrl: true });
    app.mockInput.pressArrow("left"); app.mockInput.pressArrow("right");
    expect(app.inputs).toContain("68"); expect(app.inputs).toContain("6c");
    expect(app.inputs).toContain("0e"); expect(app.inputs).toContain("10");
    expect(app.inputs).toContain("04"); expect(app.inputs).toContain("15"); expect(app.inputs.length).toBeGreaterThanOrEqual(8);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
  } finally { await app.close(); }
});

test("Terminal viewport는 상단 탭 없이 작업 패널을 채우고 리사이즈해도 쉘을 다시 만들지 않는다", async () => {
  // The real native terminal is resized through the attachment boundary, not restarted.
  const app = await mount();
  try {
    await app.createTerminal(); await app.visible("Shell shell-1");
    for (const [width, height] of [[120, 24], [60, 12], [79, 18], [80, 17], [120, 24]] as const) {
      app.resize(width, height); await app.renderOnce(); await app.renderOnce();
      const viewport = app.renderer.root.findDescendantById("terminal-viewport")!;
      const terminal = app.renderer.root.findDescendantById("shell-terminal")!;

      // Neither panel padding nor a stale VT size may leave an unused bottom row.
      const panel = app.renderer.root.findDescendantById("work-panel")!;
      expect(viewport.y).toBe(panel.y + 1); // Only the process-tab row remains.
      expect(viewport.y + viewport.height).toBe(panel.y + panel.height);
      expect(terminal.y + terminal.height).toBe(panel.y + panel.height);
      expect(terminal.height).toBe(viewport.height);
      expect(app.renderer.currentFocusedRenderable).toBe(terminal);
    }
    expect(app.created).toEqual(["demo:main"]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("프로세스 탭 이름이 바뀌어도 terminal과 포커스·탭 인스턴스를 재생성하지 않는다", async () => {
  const clock = new ManualClock(); const app = await mount(undefined, clock);
  let process = "zsh";
  app.actions.titles = async (items) => ok(Object.fromEntries(items.map((item) => [item.id, process])));
  try {
    await app.createTerminal(); await app.visible("zsh");
    const terminal = app.renderer.root.findDescendantById("shell-terminal")!;
    const tab = app.renderer.root.findDescendantById("terminal-tab:shell-1")!;
    const detached = app.detaches.length;
    const number = app.renderer.root.findDescendantById("terminal-session:shell-1:number") as TextRenderable;
    expect(number.plainText).toBe("1.");
    process = "nvim"; clock.advance(750); await app.visible("nvim");

    expect(app.renderer.root.findDescendantById("shell-terminal")).toBe(terminal);
    expect(app.renderer.root.findDescendantById("terminal-tab:shell-1")).toBe(tab);
    expect(app.renderer.currentFocusedRenderable).toBe(terminal);
    expect(app.captureCharFrame()).not.toContain("Terminal 1");
    expect(app.captureCharFrame()).not.toContain(" · running");
    expect(app.detaches).toHaveLength(detached);
    expect(number.plainText).toBe("1.");
    expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("터미널을 숨기면 프로세스 이름 조회를 취소하고 늦은 응답이 Git 화면을 바꾸지 않는다", async () => {
  const clock = new ManualClock(); const app = await mount(undefined, clock);
  const pending = Promise.withResolvers<ReturnType<typeof ok<Record<string, string>>>>();
  let signal: AbortSignal | undefined;
  app.actions.titles = async (_items, value) => { signal = value; return pending.promise; };
  try {
    await app.createTerminal(); await app.visible("Shell shell-1");
    await app.showView("g");
    expect(signal?.aborted).toBe(true);
    pending.resolve(ok({ "shell-1": "late-process" })); await app.renderOnce();
    clock.advance(1000); await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.captureCharFrame()).not.toContain("late-process");
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
  } finally { pending.resolve(ok({})); await app.close(); }
});

test("이전 서비스의 Terminal 번호 접두사를 숨기고 쉘 프로세스 이름만 표시한다", async () => {
  const app = await mount(); const create = app.actions.create;
  app.actions.create = async (tree, size) => {
    const result = await create(tree, size);
    if (result.ok) app.actions.list().find((item) => item.id === result.value)!.title = "Terminal 1 · zsh";
    return result;
  };
  try {
    await app.createTerminal(); await app.visible("zsh");
    expect(app.captureCharFrame()).not.toContain("Terminal 1");
    expect(app.captureCharFrame()).not.toContain(" · running");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally { await app.close(); }
});

test("프로세스 이름 조회 실패는 명시적으로 알리지만 터미널 연결과 입력은 유지한다", async () => {
  const app = await mount();
  app.actions.titles = async () => err(new PtyError("PTY_UNAVAILABLE", "Process inspection denied."));
  try {
    await app.createTerminal(); await app.visible("Shell shell-1");
    expect(app.captureCharFrame()).toContain("Process names unavailable");
    app.mockInput.pressCtrlC();
    expect(app.inputs).toContain("03"); expect(app.closed).toEqual([]);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally { await app.close(); }
});

test("Empty Terminal entry creates first shells and restores per-worktree lists/last selections", async () => {
  // Default shells are needed only on each worktree's initial entry.
  const app = await mount();
  try {
    // 첫 진입과 추가 생성 후 다른 워크트리를 방문한다.
    await app.showView("t"); await app.visible("Shell shell-1");
    expect(app.captureCharFrame()).not.toContain("+ New");
    app.leader("c"); await app.visible("Shell shell-2");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    await app.click("Terminal 1", true); await app.visible("Shell shell-1");
    await app.click(`${icons.folder} radian-ui`); await app.showView("t"); await app.visible("Shell shell-3");

    await app.click(`${icons.folder} radian`); await app.visible("Shell shell-1");

    // 돌아온 워크트리는 새 쉘 없이 이전 선택을 그대로 사용한다.
    expect(app.view.workViewPreferences.terminalSelection).toEqual({ "demo:main": "shell-1", "demo:feature": "shell-3" });
    expect(app.created).toEqual(["demo:main", "demo:main", "demo:feature"]);
    expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test.each(["default", "custom", "disabled"] as const)("Final-terminal closure shows only %s creation keys centered in empty views", async mode => {
  // Closing defaults leaves only empty views and actually configured creation paths.
  const keymap = expectOk(parseKeymap(mode === "custom" ? { leader: "ctrl+b" } : mode === "disabled" ? { bindings: { "tab.new": [] } } : {}));
  const app = await mount(undefined, undefined, keymap);
  const leader = (key: string) => { app.mockInput.pressKey(mode === "custom" ? "b" : " ", { ctrl: true }); app.mockInput.pressKey(key); };
  try {
    leader("t"); await app.visible("Shell shell-1");
    const close = app.renderer.root.findDescendantById("close-terminal:shell-1")!;

    // 마지막 탭을 닫아 자동 생성 없는 빈 상태로 전환한다.
    await app.mockMouse.click(close.x, close.y); await app.visible("No terminals");
    app.mockInput.pressKey("n", { ctrl: true }); await app.renderOnce();

    // 빈 본문은 공통 안내를 표시하고 Ctrl+N은 생성 별칭이 아니다.
    const empty = app.renderer.root.findDescendantById("terminal-empty-state")!;
    const hint = app.renderer.root.findDescendantById("terminal-empty-state:hint") as TextRenderable;
    expect(empty.visible).toBe(true); expect(app.created).toHaveLength(1);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("terminal-view");
    if (mode === "disabled") expect(hint.visible).toBe(false);
    else {
      expect(hint.plainText).toContain("<leader>c");
      expect(hint.y).toBeGreaterThan(empty.y);
      leader("c"); await app.visible("Shell shell-2");
      expect(app.created).toHaveLength(2); expect(empty.visible).toBe(false);
    }
  } finally { await app.close(); }
});

test("Number shortcuts select current-worktree Terminal order without creating missing tabs", async () => {
  const app = await mount();
  try {
    // 첫 진입의 기본 쉘 외에는 존재하지 않는 숫자를 선택해도 생성하지 않는다.
    await app.showView("t"); await app.visible("Shell shell-1");
    app.leader("9"); await app.renderOnce();
    expect(app.created).toEqual(["demo:main"]);
    app.leader("c"); await app.visible("Shell shell-2");
    const creations = [...app.created];

    app.leader("1"); await app.visible("Shell shell-1");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-1");
    const terminal = app.renderer.root.findDescendantById("shell-terminal");
    app.leader("1"); await app.renderOnce();
    expect(app.renderer.root.findDescendantById("shell-terminal")).toBe(terminal);
    app.renderer.root.findDescendantById("footer-help")!.focus();
    app.leader("2"); await app.visible("Shell shell-2");
    app.leader("9"); await app.renderOnce();

    // Numeric selection and returning to Terminal must not leak app bytes or recreate shells.
    await app.showView("g"); await app.showView("t"); await app.visible("Shell shell-2");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    expect(app.created).toEqual(creations); expect(app.closed).toEqual([]); expect(app.inputs).toEqual([]);
  } finally { await app.close(); }
});

test("Closing earlier terminals renumbers tabs and numeric switching sends no PTY keys", async () => {
  // Display numbers represent current positions, not process names or internal IDs.
  const app = await mount();
  const number = (id: string) => (app.renderer.root.findDescendantById(`terminal-session:${id}:number`) as TextRenderable).plainText;
  try {
    await app.showView("t"); await app.visible("Shell shell-1");
    app.leader("c"); await app.visible("Shell shell-2"); app.leader("c"); await app.visible("Shell shell-3");
    expect(number("shell-1")).toBe("1."); expect(number("shell-2")).toBe("2."); expect(number("shell-3")).toBe("3.");
    const terminal = app.renderer.root.findDescendantById("shell-terminal")!;
    const tab = app.renderer.root.findDescendantById("terminal-session:shell-2")!;

    // 입력 중인 마지막 쉘은 그대로 두고 앞선 탭만 목록에서 사라진다.
    app.exit("shell-1"); await app.renderOnce(); await app.renderOnce();

    // 새 번호는 기존 탭에 반영되며 단축키도 같은 순서를 선택한다.
    expect(number("shell-2")).toBe("1."); expect(number("shell-3")).toBe("2.");
    expect(app.renderer.root.findDescendantById("terminal-session:shell-2")).toBe(tab);
    expect(app.renderer.currentFocusedRenderable).toBe(terminal);
    app.leader("1"); await app.visible("Shell shell-2");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    expect(app.inputs).toEqual([]); expect(app.created).toHaveLength(3);
  } finally { await app.close(); }
});

test("Closing active subtabs selects next, previous, or empty state without final-tab recreation", async () => {
  const app = await mount();
  try {
    await app.createTerminal(); await app.visible("Shell shell-1"); app.leader("c"); await app.visible("Shell shell-2"); app.leader("c"); await app.visible("Shell shell-3");
    await app.click("Terminal 2", true); await app.visible("Shell shell-2");
    app.leader("x"); await app.visible("Shell shell-3");
    app.leader("x"); await app.visible("Shell shell-1");
    app.leader("x"); await app.visible("No terminals");

    expect(app.closed).toEqual(["shell-2", "shell-3", "shell-1"]);
    expect(app.created).toHaveLength(3); expect(app.view.workViewPreferences.active["demo:main"]).toBe("terminal");
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBeUndefined();

    // Empty final-tab views can request new shells without removed buttons.
    app.leader("c"); await app.visible("Shell shell-4");
    expect(app.created).toHaveLength(4);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally { await app.close(); }
});

test("Shell-exited tabs select neighbors and final exits leave empty views without replacements", async () => {
  // Keep current terminal input focused while servers remove exited tabs.
  const app = await mount();
  try {
    await app.createTerminal(); await app.visible("Shell shell-1");
    app.leader("c"); await app.visible("Shell shell-2");
    app.leader("c"); await app.visible("Shell shell-3");
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
    expect(app.renderer.currentFocusedRenderable?.id).toBe("terminal-view");
    expect(app.captureCharFrame().trimEnd().split("\n").at(-1)).toContain("<leader>c New terminal");

    // 종료 직후가 아니라 빈 화면에 다시 진입할 때만 기본 쉘을 생성한다.
    await app.showView("a"); await app.showView("t"); await app.visible("Shell shell-4");
    expect(app.created).toHaveLength(4);
  } finally { await app.close(); }
});

test("Ctrl+C stays native while leaders control detach, tab switching, and log scrolling", async () => {
  const app = await mount();
  try {
    await app.createTerminal(); await app.visible("Shell shell-1"); app.leader("c"); await app.visible("Shell shell-2");
    app.leader("1"); await app.visible("Shell shell-1");
    app.mockInput.pressCtrlC();
    const page = app.renderer.root.findDescendantById("shell-terminal")!.height - 1;
    app.renderer.keyInput.processParsedKey(parseKeypress("\x1b[5;2~")!); await app.visible(`log ${page}`);
    expect(app.inputs).toContain("03"); expect(app.commands).toEqual([]);
    await app.mockMouse.scroll(70, 10, "up"); await app.visible(`log ${page + 3}`);
    expect(app.captureCharFrame()).not.toContain(" · running");
    app.leader("d"); expect(app.commands).toEqual(["detach"]);
    expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("Terminal tabs distinguish focus/active selection through backgrounds without underlines", async () => {
  // Keep real VT connections as fixtures while moving selection/focus independently.
  const app = await mount();
  try {
    await app.createTerminal(); await app.visible("Shell shell-1");
    app.leader("c"); await app.visible("Shell shell-2"); await app.renderOnce();
    const first = app.renderer.root.findDescendantById("terminal-tab:shell-1")!.getChildren()[0]!;
    const second = app.renderer.root.findDescendantById("terminal-tab:shell-2")!.getChildren()[0]!;
    const cell = (tab: typeof first) => {
      let x = 0; return app.captureSpans().lines[tab.y]!.spans.find((span) => { x += span.width; return x > tab.x + 1; })!;
    };
    const colors = uiTheme(app.renderer).colors;
    expect(cell(second).bg.toInts()).toEqual(colors.surface.toInts());
    expect(cell(second).attributes & TextAttributes.UNDERLINE).toBe(0);

    // 비활성 탭에 포커스만 두면 쉘을 전환하지 않고 포커스 배경만 표시한다.
    first.focus(); await app.renderOnce();
    expect(cell(first).bg.toInts()).toEqual(colors.selected.toInts());
    expect(cell(first).attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(cell(second).bg.toInts()).toEqual(colors.surface.toInts());
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");

    // Enter로 탭을 연 뒤 PTY로 돌아가도 활성 세션은 밑줄이 아닌 배경으로 남는다.
    app.mockInput.pressEnter(); await app.visible("Shell shell-1"); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(cell(first).bg.toInts()).toEqual(colors.surface.toInts()); expect(cell(first).attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(cell(second).bg.toInts()).toEqual(colors.panel.toInts()); expect(cell(second).attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(app.created).toEqual(["demo:main", "demo:main"]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("AI/Terminal tabs share 18-cell frames and right close positions regardless of names/status", async () => {
  // Compare AI geometry with short/long terminal names in the same work area.
  const clock = new ManualClock(), app = await mount(undefined, clock);
  const agent = app.renderer.root.findDescendantById("session:demo:main:a1")!;
  const agentWidth = agent.width;
  app.actions.titles = async items => ok(Object.fromEntries(items.map((item, index) => [item.id, index === 0 ? "zsh" : "프로세스👩‍💻-very-long-name"])));
  try {
    // 이름 길이가 서로 다른 두 터미널을 만들고 좁은 창으로 전환한다.
    await app.showView("t"); await app.visible("Shell shell-1");
    app.leader("c"); await app.visible("Shell shell-2"); await app.renderOnce();
    const first = app.renderer.root.findDescendantById("terminal-session:shell-1")!;
    const second = app.renderer.root.findDescendantById("terminal-session:shell-2")!;
    const title = app.renderer.root.findDescendantById(`${second.id}:title`) as TextRenderable;
    app.resize(60, 12); await app.renderOnce(); await app.renderOnce();

    // 고정 경계와 닫기 위치는 일치하고 긴 Unicode 이름만 안전하게 말줄임한다.
    expect(agentWidth).toBe(18); expect(first.width).toBe(agentWidth); expect(second.width).toBe(agentWidth);
    expect(second.x).toBe(first.x + first.width + 1);
    for (const [id, tab] of [["shell-1", first], ["shell-2", second]] as const) {
      const close = app.renderer.root.findDescendantById(`close-terminal:${id}`)!;
      expect(close.width).toBe(1); expect(close.x + close.width).toBe(tab.x + tab.width - 1);
    }
    expect(title.plainText).toEndWith("…"); expect(title.plainText).not.toContain("\uFFFD");
    expect(app.created).toHaveLength(2); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("Unselected terminal close buttons affect only their tab without changing active shell, connection, or focus", async () => {
  // Close the first shell while the second owns input.
  const app = await mount();
  try {
    await app.showView("t"); await app.visible("Shell shell-1");
    app.leader("c"); await app.visible("Shell shell-2");
    const terminal = app.renderer.root.findDescendantById("shell-terminal")!, detaches = [...app.detaches];
    const close = app.renderer.root.findDescendantById("close-terminal:shell-1")!;

    // 비활성 탭의 닫기를 직접 클릭한다.
    await app.mockMouse.click(close.x, close.y); await app.renderOnce(); await app.renderOnce();

    // 닫기 클릭은 선택 클릭이나 PTY 입력으로 전파되지 않는다.
    expect(app.closed).toEqual(["shell-1"]);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    expect(app.renderer.root.findDescendantById("terminal-tab:shell-1")).toBeUndefined();
    expect(app.renderer.root.findDescendantById("shell-terminal")).toBe(terminal);
    expect(app.renderer.currentFocusedRenderable).toBe(terminal);
    expect(app.detaches).toEqual(detaches); expect(app.inputs).toEqual([]);
  } finally { await app.close(); }
});

test("Rejected inactive-terminal closure notifies while preserving active input/connections", async () => {
  // Operational close failures must leave other shells editable.
  const app = await mount();
  try {
    await app.showView("t"); await app.visible("Shell shell-1");
    app.leader("c"); await app.visible("Shell shell-2");
    const terminal = app.renderer.root.findDescendantById("shell-terminal")!;
    const close = app.renderer.root.findDescendantById("close-terminal:shell-1")!;
    app.actions.close = async () => err(new PtyError("PTY_BUSY", "Cleanup was rejected."));

    // 활성 쉘이 아닌 첫 번째 탭의 닫기를 요청한다.
    await app.mockMouse.click(close.x, close.y); await app.visible("Cleanup was rejected.");

    // 거절된 탭과 활성 연결은 모두 남고 오류 알림만 추가된다.
    expect(app.renderer.root.findDescendantById("terminal-tab:shell-1")).toBeDefined();
    expect(app.renderer.root.findDescendantById("shell-terminal")).toBe(terminal);
    expect(app.renderer.currentFocusedRenderable).toBe(terminal);
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-2");
    app.mockInput.pressKey("h"); expect(app.inputs).toContain("68"); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("Terminal-tab Space enters shell input without forwarding control characters", async () => {
  // Navigation focus can rest on tabs other than active terminals.
  const app = await mount();
  try {
    await app.showView("t"); await app.visible("Shell shell-1");
    app.leader("c"); await app.visible("Shell shell-2");
    app.renderer.root.findDescendantById("terminal-session:shell-1")!.focus();

    // 공통 프레임이 버튼에서 바뀌어도 Space 활성화를 유지한다.
    app.mockInput.pressKey(" "); await app.visible("Shell shell-1");

    // 선택된 입력만 포커스를 받고 앱의 활성화 키는 PTY로 전달되지 않는다.
    expect(app.view.workViewPreferences.terminalSelection?.["demo:main"]).toBe("shell-1");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
    expect(app.inputs).toEqual([]); expect(app.created).toHaveLength(2);
  } finally { await app.close(); }
});

test("Closing focused final terminals leaves valid empty focus and leader+c recovers", async () => {
  // Per-tab closure must restore empty-state input routing without shared Close commands.
  const app = await mount();
  try {
    await app.showView("t"); await app.visible("Shell shell-1");
    app.renderer.root.findDescendantById("terminal-session:shell-1")!.focus();
    const close = app.renderer.root.findDescendantById("close-terminal:shell-1")!;

    // 마지막 탭을 닫은 뒤에는 자동 대체 쉘을 만들지 않는다.
    await app.mockMouse.click(close.x, close.y); await app.visible("No terminals");

    // 새 탭 단축키를 누르기 전까지 빈 상태와 유효한 포커스를 유지한다.
    expect(app.closed).toEqual(["shell-1"]); expect(app.created).toHaveLength(1);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("terminal-view");
    app.leader("c"); await app.visible("Shell shell-2");
    expect(app.created).toHaveLength(2); expect(app.renderer.currentFocusedRenderable?.id).toBe("shell-terminal");
  } finally { await app.close(); }
});

test("Multiple subtabs and compact layouts show only selected tabs with per-tab close buttons", async () => {
  const app = await mount();
  try {
    await app.showView("t"); await app.visible("Shell shell-1");
    for (let i = 2; i <= 6; i++) { app.leader("c"); await app.visible(`Shell shell-${i}`); }
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Terminal 6");
    const selectedTab = app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text === "Terminal 6")!;
    expect(selectedTab.attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(selectedTab.bg.toInts()).toEqual(uiTheme(app.renderer).colors.surface.toInts());
    app.resize(60, 12); await app.renderOnce(); await app.renderOnce();
    const row = app.captureCharFrame().split("\n").find((line) => line.includes("Terminal 6"))!;
    expect(row).toContain("Terminal 6"); expect(row).not.toContain("+ New"); expect(row).not.toContain("Close"); expect(row).toContain("×");
    const tab = app.renderer.root.findDescendantById("terminal-session:shell-6")!;
    const close = app.renderer.root.findDescendantById("close-terminal:shell-6")!;
    expect(tab.width).toBe(18);
    expect(close.x + close.width).toBe(tab.x + tab.width - 1);
    expect(close.x + close.width).toBeLessThanOrEqual(app.renderer.width);
  } finally { await app.close(); }
});

test("늦은 터미널 생성 결과는 다른 워크트리의 Git 화면이나 선택을 빼앗지 않는다", async () => {
  const app = await mount(); const ready = Promise.withResolvers<ReturnType<typeof ok<string>>>();
  const create = app.actions.create;
  app.actions.create = async (tree, size) => { await ready.promise; return create(tree, size); };
  try {
    await app.createTerminal();
    await app.click(`${icons.folder} radian-ui`); await app.showView("g");
    ready.resolve(ok("ready")); await Bun.sleep(0); await app.renderOnce();

    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.captureCharFrame()).toContain("Git preview");
    expect(app.view.workViewPreferences.active["demo:feature"]).toBe("git");
  } finally { ready.resolve(ok("ready")); await app.close(); }
});
