import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { uiTheme } from "../../ui/theme.ts";

async function fixture(options: Partial<WorkbenchActions> = {}) {
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock: new ManualClock() });
  const result = { id: "result-b", outcome: "complete" as const, completedAt: 1000, request: { text: "Fix authentication", images: 0, files: 0 } };
  const repositories = demoWorkspace().map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => tree.id === "demo:feature"
    ? { ...tree, sessions: [{ id: "b1", name: "opaque", status: "complete" as const, subagents: [], request: result.request, result, attention: result }] } : tree) }));
  const selection = new WorkspaceSelection(repositories), acknowledged: string[] = [], submitted: string[] = [], lookups: string[] = [];
  const states: Record<string, ExecutionState> = {
    a1: { conversationId: "conv-a", status: "working", output: "ACTIVE BODY", error: null },
    b1: { conversationId: "conv-b", status: "complete", error: null, output: "", request: result.request, result, attention: result,
      sections: [{ id: "request", kind: "user", title: "You", text: "Fix authentication", status: "complete" },
        { id: "answer", kind: "assistant", title: "Agent", text: "PREVIEW_RESULT", status: "complete" }] },
  };
  const view = new Workbench(app.renderer, selection, { onNewSession() {}, onCloseSession() {}, initialDrafts: { a1: "KEEP_DRAFT" },
    onPrompt: (_id, text) => { submitted.push(text); return ok(undefined); }, getSessionDetails: id => { lookups.push(id); return states[id] ?? null; },
    onAcknowledge: async (id, _conversation, resultId) => {
      acknowledged.push(resultId);
      const state = states[id]; if (state?.attention?.id === resultId) { const { attention: _attention, ...next } = state; states[id] = next; }
      selection.replaceSnapshot(selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree, sessions: tree.sessions.map(session => {
        if (session.id !== id || session.attention?.id !== resultId) return session;
        const { attention: _attention, ...next } = session; return next;
      }) })) })));
      return ok(undefined);
    }, ...options });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  const leader = (key: string) => { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); };
  await render();
  return { ...app, view, selection, states, acknowledged, submitted, lookups, get, render, leader,
    async close() { view.dispose(); await app.dispose(); } };
}

test("워크스페이스 팝업은 작업 너비를 바꾸지 않고 퍼지 검색 후 Enter에서만 전환한다", async () => {
  // 영구 사이드바 없이 현재 세션과 초안이 열린 상태에서 시작한다.
  const app = await fixture();
  try {
    const pane = app.get("work-panel"), width = pane.width, prompt = app.get("session-prompt");
    expect(width).toBe(120); expect(app.get("workspace-picker").visible).toBe(false);

    app.mockInput.pressKey("f", { ctrl: true }); await app.render();
    await app.mockInput.typeText("rdui"); await app.render();
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(pane.width).toBe(width);
    expect(app.captureCharFrame()).toContain("radian-ui");
    app.mockInput.pressEnter(); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:feature"); expect(app.get("workspace-picker").visible).toBe(false);
    expect(app.view.promptDrafts.a1).toBe("KEEP_DRAFT"); expect(app.submitted).toEqual([]); expect(prompt.isDestroyed).toBe(false);
  } finally { await app.close(); }
});

test("워크스페이스 팝업의 Esc와 Tab은 원래 포커스·선택·대화 위치를 보존한다", async () => {
  // 취소는 탐색 중인 후보를 활성 워크스페이스로 적용하면 안 된다.
  const app = await fixture();
  try {
    const prompt = app.get("session-prompt"); prompt.focus();
    app.leader("b"); await app.render();
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    for (let index = 0; index < 6; index++) { app.mockInput.pressTab(); await app.render(); expect(["workspace-search", "workspace-tree"]).toContain(app.renderer.currentFocusedRenderable?.id ?? ""); }
    await app.mockMouse.click(0, 0); await app.render();
    expect(app.get("workspace-picker").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();

    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.view.promptDrafts.a1).toBe("KEEP_DRAFT");
  } finally { await app.close(); }
});

test("모니터 Preview와 후보 이동은 읽음 처리하지 않고 Enter로 연 세션만 확인한다", async () => {
  // 다른 워크스페이스의 미확인 결과를 현재 대화와 분리한다.
  const app = await fixture();
  try {
    app.leader("s"); await app.render();
    expect(app.get("session-monitor").visible).toBe(true); expect(app.captureCharFrame()).toContain("PREVIEW_RESULT");
    expect(app.captureCharFrame()).toContain("Needs attention"); expect(app.acknowledged).toEqual([]);
    expect(app.selection.sessionId).toBe("a1");
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    app.mockInput.pressKey("p", { ctrl: true }); await app.render();
    expect(app.acknowledged).toEqual([]);

    app.mockInput.pressEnter(); await app.render();

    expect(app.selection.sessionId).toBe("b1"); expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.get("session-monitor").visible).toBe(false); expect(app.acknowledged).toEqual(["result-b"]);
    expect(app.states.b1?.result?.outcome).toBe("complete"); expect(app.view.promptDrafts.a1).toBe("KEEP_DRAFT");
    expect(app.submitted).toEqual([]);
    app.leader("s"); await app.render(); expect(app.renderer.root.findDescendantById("monitor:b1")).toBeUndefined();
  } finally { await app.close(); }
});

test("모니터는 실시간 요약 갱신에도 선택과 목록 노드를 유지하고 닫힌 동안 Preview를 조회하지 않는다", async () => {
  // 스트리밍 중 후보 목록의 구성은 바뀌지 않고 선택한 대화 내용만 바뀐다.
  const app = await fixture();
  try {
    app.leader("s"); await app.render(); const row = app.get("monitor:b1");
    app.states.b1 = { ...app.states.b1!, sections: [{ id: "answer", kind: "assistant", title: "Agent", text: "UPDATED_PREVIEW", status: "streaming" }] };
    app.selection.replaceSnapshot(structuredClone(app.selection.snapshot)); await app.render();

    expect(app.get("monitor:b1")).toBe(row); expect(app.captureCharFrame()).toContain("UPDATED_PREVIEW");
    app.mockInput.pressEscape(); await app.render();
    expect(app.get("session-monitor").visible).toBe(false); expect(app.acknowledged).toEqual([]);
    app.lookups.length = 0; app.selection.replaceSnapshot(app.selection.snapshot); await app.render();
    expect(app.lookups).not.toContain("b1");
  } finally { await app.close(); }
});

test("좁은 화면의 모니터는 History처럼 목록과 Preview를 전환하고 검색 입력을 보존한다", async () => {
  // 좁은 터미널에 두 열을 억지로 넣지 않는다.
  const app = await fixture();
  try {
    app.resize(60, 14); app.leader("s"); await app.render();
    await app.mockInput.typeText("auth"); await app.render();
    expect(app.get("monitor-list").visible).toBe(true); expect(app.get("monitor-preview-pane").visible).toBe(false);

    app.mockInput.pressKey("o", { ctrl: true }); await app.render();

    expect(app.get("monitor-preview-pane").visible).toBe(true); expect(app.captureCharFrame()).toContain("PREVIEW_RESULT");
    expect((app.get("monitor-search") as InputRenderable).value).toBe("auth"); expect(app.acknowledged).toEqual([]);
  } finally { await app.close(); }
});

test("Stopped 탭은 벨보다 물음표 하나를 우선 표시하고 읽음과 무관하게 유지한다", async () => {
  // Stopped는 읽음과 별개로 유지되는 실행 결과다.
  const app = await fixture();
  try {
    const stopped = { id: "stopped", outcome: "unfinished" as const, completedAt: 2000 };
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree, sessions: tree.sessions.map(session => session.id === "a2"
      ? { ...session, status: null, result: stopped, attention: stopped } : session) })) })));
    await app.render();
    const tab = app.get("session:demo:main:a2"), region = () => app.captureCharFrame().split("\n")[tab.y]!.slice(tab.x, tab.x + tab.width);

    expect(region()).toBe(" ? a2 × ");
    expect(app.selection.worktree?.sessions.find(session => session.id === "a2")?.attention?.id).toBe("stopped");
    const colorAt = (column: number) => {
      let x = 0; return app.captureSpans().lines[tab.y]!.spans.find(span => { x += span.width; return x > column; })!.fg.toInts();
    };
    expect(colorAt(tab.x + 1)).toEqual(uiTheme(app.renderer).colors.warning.toInts());
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree, sessions: tree.sessions.map(session => {
      if (session.id !== "a2") return session;
      const { attention: _attention, ...next } = session; return next;
    }) })) })));
    await app.render();
    expect(region()).toBe(" ? a2 × ");
  } finally { await app.close(); }
});

test("백그라운드와 과거 대화 위치에서는 읽음 처리하지 않고 결과가 실제 보일 때 확인한다", async () => {
  // 미확인 세션으로 선택만 복원된 상태는 사용자가 결과를 읽었다는 증거가 아니다.
  const app = await fixture();
  try {
    app.renderer.emit("blur"); app.selection.selectSession("demo:feature", "b1"); await app.render();
    expect(app.acknowledged).toEqual([]);
    app.states.b1 = { ...app.states.b1!, sections: [{ id: "answer", kind: "assistant", title: "Agent", text: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"), status: "complete" }] };
    app.selection.replaceSnapshot(app.selection.snapshot); await app.render();
    const scroll = app.get("session-transcript") as ScrollBoxRenderable; scroll.scrollTo(0); await app.render();
    app.renderer.emit("focus"); await app.render();
    expect(app.acknowledged).toEqual([]);

    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("g"); app.mockInput.pressKey("e"); await app.render();

    expect(app.acknowledged).toEqual(["result-b"]);
  } finally { await app.close(); }
});

test("모니터 후보가 많으면 렌더링 한도를 알리고 검색으로 뒤쪽 세션에도 접근한다", async () => {
  // 수집은 전체 요약을 대상으로 하지만 네이티브 행 생성은 History처럼 제한한다.
  const app = await fixture();
  try {
    const sessions = Array.from({ length: 250 }, (_, index) => ({ id: `bulk-${index}`, name: index === 249 ? "Last special task" : `Bulk ${index}`, status: "working" as const, subagents: [] }));
    app.selection.replaceSnapshot(app.selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => tree.id === "demo:main" ? { ...tree, sessions: [...tree.sessions, ...sessions] } : tree) })));

    app.leader("s"); await app.render();
    expect(app.captureCharFrame()).toContain("Showing first 200 of 252 sessions; refine search");
    expect(app.renderer.root.findDescendantById("monitor:bulk-249")).toBeUndefined();
    await app.mockInput.typeText("lastspecial"); await app.render();

    expect(app.get("monitor:bulk-249")).toBeDefined(); expect(app.captureCharFrame()).toContain("Last special task"); expect(app.acknowledged).toEqual([]);
  } finally { await app.close(); }
});

test("저장소가 없는 화면에서 팝업을 취소하면 숨은 검색창 대신 도움말로 포커스를 복귀한다", async () => {
  // 복귀할 세션이나 PTY가 없을 때도 숨겨진 입력에 키가 남으면 안 된다.
  const app = await createTestRenderer({ width: 60, height: 12, kittyKeyboard: true });
  const view = new Workbench(app.renderer, new WorkspaceSelection([]), { onNewSession() {}, onCloseSession() {} });
  try {
    await app.renderOnce(); app.mockInput.pressKey("f", { ctrl: true }); await app.renderOnce();
    app.mockInput.pressEscape(); await app.renderOnce();

    expect(app.renderer.root.findDescendantById("workspace-picker")!.visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("footer-help");
  } finally { view.dispose(); await app.dispose(); }
});
