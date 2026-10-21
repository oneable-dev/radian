import { expect, spyOn, test } from "bun:test";
import { BoxRenderable, CodeRenderable, EditBufferRenderable, InputRenderable, MarkdownRenderable, ScrollBoxRenderable, parseKeypress, type Renderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import type { HistoryItem } from "../history.ts";
import type { HistoryPreview } from "../history-preview.ts";
import type { TranscriptSection } from "../transcript.ts";
import { Workbench } from "../../app/ui/workbench.ts";
import { capture, HistoryError, type ExpectedError } from "../../errors.ts";
import { ok, type Result } from "../../result.ts";
import { parseKeymap, type Keymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";

const saved = (id: string, title = id): HistoryItem => ({ id, title, worktreeId: "demo:main", modified: "2026-10-14T12:34:00.000Z", messageCount: 4, openSessionId: null, unavailableReason: null });
type Options = {
  list?: (id: string, signal?: AbortSignal) => Promise<readonly HistoryItem[]>;
  preview?: (tree: string, id: string, signal?: AbortSignal) => Promise<Result<HistoryPreview, ExpectedError>>;
  resume?: (tree: string, id: string) => Promise<string>;
  keymap?: Keymap;
  liveSections?: readonly TranscriptSection[];
};
async function mount(options: Options = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, clock });
  const listenerLimit = app.renderer.getMaxListeners(), selection = new WorkspaceSelection(demoWorkspace());
  const resumed: string[] = [], previews: string[] = [], runs: string[] = [];
  const view = new Workbench(app.renderer, selection, { ...(options.keymap ? { keymap: options.keymap } : {}),
    onNewSession: () => runs.push("create"), onCloseSession: () => runs.push("close"), onPrompt: (_id, text) => { runs.push(text); return ok(undefined); },
    initialDrafts: { a1: "untouched draft" }, getSessionDetails: () => ({ status: "complete", error: null, output: Array.from({ length: 80 }, (_, i) => `Transcript line ${i}`).join("\n"), ...(options.liveSections ? { sections: options.liveSections } : {}) }),
    onListHistory: (id, signal) => capture(() => options.list ? options.list(id, signal) : Promise.resolve([saved("first", "Saved layout review"), saved("second", "Saved keyboard navigation")])),
    onPreviewHistory: async (tree, id, signal) => { previews.push(id); return options.preview ? options.preview(tree, id, signal) : ok({ id, worktreeId: tree, text: `You\nSaved question ${id}\n\nAgent\nSaved answer ${id}`, truncated: false, sections: [
      { id: `${id}:prompt`, kind: "user", title: "You", text: `Saved question ${id}`, status: "complete" },
      { id: `${id}:answer`, kind: "assistant", title: "Agent", text: `Saved answer ${id}`, status: "complete" },
    ] }); },
    onResumeSession: async (tree, id) => { resumed.push(`${tree}/${id}`); return capture(() => options.resume ? options.resume(tree, id) : Promise.resolve("a2")); },
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  return { ...app, clock, view, selection, resumed, previews, runs, get, render,
    leader(key: string) { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(key); },
    async open() { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("h"); await render(); },
    async click(id: string) { const node = get(id); await app.mockMouse.click(node.x, node.y); await render(); },
    async visible(text: string) {
      const deadline = Date.now() + 1500;
      while (!app.captureCharFrame().includes(text)) {
        if (Date.now() > deadline) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
        await render();
      }
    },
    async close() { view.dispose(); expect(app.renderer.getMaxListeners()).toBe(listenerLimit); await app.dispose(); },
  };
}

test("History는 Agents의 검색 팝업이고 좌측에는 Workspace만 남긴다", async () => {
  // Browsing metadata is not a model/session action, and sidebar space is no longer spent on history.
  const app = await mount();
  try {
    expect(app.renderer.root.findDescendantById("agent-history-button")).toBeUndefined();
    await app.open(); await app.visible("Saved layout review");

    expect(app.get("session-history").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
    expect(app.captureCharFrame()).toContain("History · radian");
    expect(app.captureCharFrame()).toContain("2026-10-14 12:34"); expect(app.captureCharFrame()).toContain("4 messages");
    expect(app.selection.sessionId).toBe("a1"); expect(app.resumed).toEqual([]); expect(app.runs).toEqual([]);
    // 첫 후보는 가짜 시계를 진행하지 않아도 조회하고 Preview에는 로딩 표시를 만들지 않는다.
    expect(app.previews).toEqual(["first"]); expect(app.captureCharFrame()).toContain("Saved answer first");
    expect(!!app.renderer.root.findDescendantById("history-preview-loading")).toBe(false);
    expect(app.captureCharFrame()).not.toContain("Loading preview");
  } finally { await app.close(); }
});

test("미리보기는 Agent와 같은 섹션 카드·접힘·오류 UI를 쓰며 마지막 프롬프트부터 읽기만 한다", async () => {
  // Live and preview surfaces receive identical structured data, but must not share view state.
  const sections: TranscriptSection[] = [
    { id: "latest-q", kind: "user", title: "You", text: "Newest prompt", status: "complete" },
    { id: "thought", kind: "thinking", title: "Thinking", text: "Visible reasoning", status: "complete" },
    { id: "tool", kind: "tool", title: "read", text: "Arguments:\n{}\n\nResult:\nRead failed", status: "error", error: "Read failed" },
    { id: "answer", kind: "assistant", title: "Agent", text: "Latest reply", status: "complete" },
  ];
  const app = await mount({ liveSections: sections, preview: async (worktreeId, id) => ok({ id, worktreeId, sections, text: "DO NOT RENDER THE LEGACY STRING", truncated: false }) });
  const body = (root: Renderable, text: string): EditBufferRenderable | undefined => {
    if (root instanceof EditBufferRenderable && root.plainText === text) return root;
    for (const child of root.getChildren()) { const found = body(child, text); if (found) return found; }
  };
  try {
    const live = app.get("session-transcript"), state = app.view.workViewPreferences.agentViews;
    await app.open(); app.clock.advance(150); await app.render();
    const preview = app.get("history-preview") as ScrollBoxRenderable;
    // 라이브 대화의 바만 숨기고 독립된 History 미리보기의 탐색 표시는 유지한다.
    if (!(live instanceof ScrollBoxRenderable)) throw new Error("Missing live transcript");
    expect(live.verticalScrollBar.visible).toBe(false); expect(preview.verticalScrollBar.visible).toBe(true);
    for (const section of sections) {
      const original = body(live, section.text), shown = body(preview, section.text);
      if (!(original?.parent instanceof BoxRenderable) || !(shown?.parent instanceof BoxRenderable)) throw new Error("Expected native section cards");
      expect(shown.parent.backgroundColor.toInts()).toEqual(original.parent.backgroundColor.toInts());
      expect(shown.parent.border).toEqual(original.parent.border); expect(shown.parent.paddingLeft).toBe(original.parent.paddingLeft);
      expect(shown.visible).toBe(original.visible);
    }
    // A fresh preview starts at its latest prompt, not at the old conversation's beginning or the last card.
    expect(preview.scrollTop).toBe(0); expect(app.captureCharFrame()).toContain("Newest prompt");
    expect(app.captureCharFrame()).toContain("Visible reasoning"); expect(app.captureCharFrame()).not.toContain("[thinking]"); expect(app.captureCharFrame()).not.toContain("DO NOT RENDER THE LEGACY STRING");
    const prompt = body(preview, "Newest prompt")!; prompt.focus();
    await app.mockInput.pasteBracketedText("must not edit"); app.mockInput.pressBackspace(); await app.render();
    expect(prompt.plainText).toBe("Newest prompt"); expect(app.view.workViewPreferences.agentViews).toEqual(state);
    expect(app.selection.sessionId).toBe("a1"); expect(app.resumed).toEqual([]); expect(app.runs).toEqual([]);
    app.mockInput.pressEscape(); await app.render(); expect(app.get("session-history").visible).toBe(false);
  } finally { await app.close(); }
});

test("History의 답변·Thinking도 동일한 Markdown을 표시하되 검색·원래 세션은 바꾸지 않는다", async () => {
  // 미리보기는 별도 텍스트 변환기가 아니라 실시간 transcript와 같은 Markdown 렌더러를 쓴다.
  const sections: TranscriptSection[] = [
    { id: "q", kind: "user", title: "You", text: "Saved question", status: "complete" },
    { id: "a", kind: "assistant", title: "Agent", text: "### Preview title\n\n**Saved answer**", status: "complete" },
    { id: "t", kind: "thinking", title: "Thinking", text: "**Saved thought**", status: "complete" },
  ];
  const app = await mount({ preview: async (worktreeId, id) => ok({ id, worktreeId, text: "", sections, truncated: false }) });
  const children = (node: Renderable): Renderable[] => node.getChildren().flatMap((child) => [child, ...children(child)]);
  try {
    // Three padded cards need a taller dialog to inspect all Markdown surfaces together.
    app.resize(120, 36); await app.render();
    await app.open(); app.clock.advance(150); await app.render();
    const preview = app.get("history-preview");
    for (let pass = 0; pass < 3; pass++) {
      await Promise.all(children(preview).filter((node): node is CodeRenderable => node instanceof CodeRenderable).map((node) => node.highlightingDone));
      await app.render();
    }
    // 표시 문법을 숨겨도 선택된 실시간 세션·초안·읽기 전용 계약을 보존한다.
    const frame = app.captureCharFrame();
    expect(children(preview).filter((node) => node instanceof MarkdownRenderable)).toHaveLength(2);
    expect(frame).toContain("Preview title"); expect(frame).toContain("Saved answer"); expect(frame).toContain("Saved thought");
    expect(frame).not.toContain("### Preview title"); expect(frame).not.toContain("**Saved answer**"); expect(frame).not.toContain("[thinking]");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
    expect(app.selection.sessionId).toBe("a1"); expect(app.view.promptDrafts.a1).toBe("untouched draft"); expect(app.runs).toEqual([]);
  } finally { await app.close(); }
});

test("검색은 fuzzy·한글을 지원하고 hjkl과 r은 검색 입력으로 남긴다", async () => {
  const app = await mount({ list: async () => [saved("a", "Layout review"), saved("b", "키보드 검색"), saved("c", "hjkl refresh")] });
  try {
    await app.open();
    await app.mockInput.typeText("lyt rvw"); await app.render();
    expect(app.captureCharFrame()).toContain("Layout review"); expect(app.captureCharFrame()).not.toContain("키보드 검색");
    const search = app.get("history-search") as InputRenderable;
    search.value = "키검"; await app.render(); expect(app.captureCharFrame()).toContain("키보드 검색");
    search.value = ""; await app.mockInput.typeText("hjkl r"); await app.render();
    expect(search.value).toBe("hjkl r"); expect(app.captureCharFrame()).toContain("hjkl refresh");
    expect(app.resumed).toEqual([]); expect(app.runs).toEqual([]);
  } finally { await app.close(); }
});

test("목록 클릭과 Ctrl+N/P는 미리보기만 바꾸고 Enter에서 선택한 세션을 연다", async () => {
  const app = await mount();
  try {
    await app.open(); await app.click("history:second");
    expect(app.resumed).toEqual([]); expect(app.selection.sessionId).toBe("a1");
    app.mockInput.pressKey("p", { ctrl: true }); app.mockInput.pressKey("n", { ctrl: true });
    await app.render(); expect(app.previews).toEqual(["first", "second"]);
    app.mockInput.pressEnter(); await app.waitFor(() => app.selection.sessionId === "a2"); await app.render();
    expect(app.resumed).toEqual(["demo:main/second"]); expect(app.get("session-history").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-transcript");
    expect(app.view.promptDrafts.a1).toBe("untouched draft"); expect(app.runs).toEqual([]);
  } finally { await app.close(); }
});

test("Esc는 프롬프트 커서·초안·대화 스크롤과 원래 포커스를 복원한다", async () => {
  const app = await mount();
  try {
    const prompt = app.get("session-prompt") as InputRenderable, transcript = app.get("session-transcript") as ScrollBoxRenderable;
    prompt.focus(); prompt.cursorOffset = 5; transcript.scrollTo(21); await app.render(); const top = transcript.scrollTop;
    // The global shortcut preserves the prompt as the owner without a visible trigger button.
    await app.open(); await app.mockInput.typeText("review"); await app.render();
    app.mockInput.pressEscape(); await app.render();
    expect(app.get("session-history").visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(prompt.cursorOffset).toBe(5); expect(app.view.promptDrafts.a1).toBe("untouched draft"); expect(transcript.scrollTop).toBe(top);
    expect(app.selection.sessionId).toBe("a1"); expect(app.resumed).toEqual([]); expect(app.runs).toEqual([]);
  } finally { await app.close(); }
});

test("팝업을 닫은 뒤 Enter·Esc kitty 반복 입력은 배경 명령으로 바뀌지 않는다", async () => {
  // Native kitty repeats sometimes carry repeated=true rather than eventType=repeat.
  const app = await mount();
  const raw = (text: string) => { const key = parseKeypress(text, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid kitty fixture"); app.renderer.keyInput.processParsedKey(key); };
  try {
    app.get("session-prompt").focus(); await app.open();
    raw("\u001b[27;1u"); raw("\u001b[27;1:2u"); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt"); expect(app.view.promptDrafts.a1).toBe("untouched draft");
    raw("\u001b[27;1:3u"); await app.open(); raw("\u001b[13;1u"); await app.render();
    const owner = app.renderer.currentFocusedRenderable;
    raw("\u001b[13;1:2u"); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(owner); expect(app.resumed).toEqual(["demo:main/first"]); expect(app.runs).toEqual([]);
  } finally { await app.close(); }
});

test("기존 입력이 사라졌다면 숨은 검색창 대신 표시된 탐색 영역에 포커스를 복귀한다", async () => {
  const app = await mount();
  try {
    app.get("session-prompt").focus(); await app.open();
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree, sessions: [] })) })));
    app.mockInput.pressEscape(); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("agent-session-list"); expect(app.get("session-history").visible).toBe(false);
    expect(app.resumed).toEqual([]);
  } finally { await app.close(); }
});

test("팝업은 Tab 포커스·전역 명령·배경 클릭을 가두고 sidebar 접기 상태를 유지한다", async () => {
  const app = await mount();
  try {
    expect(app.get("workspace-picker").visible).toBe(false);
    await app.open(); const dialog = app.get("history-dialog");
    for (let i = 0; i < 9; i++) { app.mockInput.pressTab(); await app.render(); expect(["history-search", "history-list", "history-preview"]).toContain(app.renderer.currentFocusedRenderable!.id); }
    app.leader("e"); app.leader("b"); app.mockInput.pressKey("e", { ctrl: true }); await app.render();
    expect(app.get("agent-view").visible).toBe(true); expect(app.get("workspace-sidebar").visible).toBe(false);
    await app.mockMouse.click(0, 0); await app.render(); expect(app.get("session-history").visible).toBe(true);
    expect(dialog.x).toBeGreaterThan(0); expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.runs).toEqual([]);
    app.mockInput.pressEscape(); await app.render(); expect(app.get("workspace-sidebar").visible).toBe(false);
  } finally { await app.close(); }
});

test("빠른 결과는 즉시 표시하되 shared spinner는 500ms 유지하고 숨기면 취소한다", async () => {
  const app = await mount();
  try {
    await app.open(); expect(app.captureCharFrame()).toContain("Saved layout review"); expect(app.get("history-loading").visible).toBe(true);
    app.clock.advance(499); await app.render(); expect(app.get("history-loading").visible).toBe(true);
    app.clock.advance(1); await app.render(); expect(app.get("history-loading").visible).toBe(false);
    app.mockInput.pressKey("r", { ctrl: true }); await app.render(); expect(app.get("history-loading").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render(); expect(app.get("history-loading").visible).toBe(false); expect(!!app.renderer.root.findDescendantById("history-preview-loading")).toBe(false);
  } finally { await app.close(); }
});

test("새 목록 조회가 이전 응답을 무시하고 현재 spinner와 결과만 갱신한다", async () => {
  // The first read remains pending while an explicit refresh takes ownership of the popup.
  const first = Promise.withResolvers<readonly HistoryItem[]>(), second = Promise.withResolvers<readonly HistoryItem[]>();
  let calls = 0; const signals: (AbortSignal | undefined)[] = [];
  const app = await mount({ list: (_tree, signal) => { signals.push(signal); return ++calls === 1 ? first.promise : second.promise; } });
  try {
    await app.open(); app.mockInput.pressKey("r", { ctrl: true }); await app.render();
    expect(signals[0]?.aborted).toBe(true);
    first.resolve([saved("old", "STALE METADATA")]); await app.render();
    expect(app.captureCharFrame()).not.toContain("STALE METADATA"); expect(app.get("history-loading").visible).toBe(true);
    second.resolve([saved("new", "CURRENT METADATA")]); await app.visible("CURRENT METADATA");
    app.clock.advance(500); await app.render(); expect(app.get("history-loading").visible).toBe(false); expect(app.resumed).toEqual([]);
  } finally { first.resolve([]); second.resolve([]); await app.close(); }
});

test("늦은 응답은 자기 세션에만 캐시하고 다시 선택하면 즉시 재사용한다", async () => {
  // 첫 세션의 느린 응답이 두 번째 세션을 덮지 않으면서 재방문에는 유효해야 한다.
  const pending = Promise.withResolvers<Result<HistoryPreview, ExpectedError>>();
  const app = await mount({ preview: async (tree, id) => id === "first" ? pending.promise
    : ok({ worktreeId: tree, id, text: "CURRENT SECOND PREVIEW", truncated: false }) });
  try {
    await app.open(); expect(app.previews).toEqual(["first"]);
    app.mockInput.pressArrow("down"); await app.render();
    expect(app.previews).toEqual(["first", "second"]);
    pending.resolve(ok({ id: "first", worktreeId: "demo:main", text: "CACHED FIRST PREVIEW", truncated: false })); await app.render();

    // 응답 순서와 무관하게 현재 선택만 표시하고, A로 돌아가도 요청을 추가하지 않는다.
    expect(app.captureCharFrame()).toContain("CURRENT SECOND PREVIEW"); expect(app.captureCharFrame()).not.toContain("CACHED FIRST PREVIEW");
    app.mockInput.pressKey("p", { ctrl: true }); await app.render();
    expect(app.captureCharFrame()).toContain("CACHED FIRST PREVIEW"); expect(app.previews).toEqual(["first", "second"]);
    expect(app.resumed).toEqual([]); expect(app.selection.sessionId).toBe("a1");
  } finally { pending.resolve(ok({ id: "first", worktreeId: "demo:main", text: "late", truncated: false })); await app.close(); }
});

test("처음 보는 후보는 선택한 제목과 빈 본문을 표시하고 로딩 표시나 이전 내용을 남기지 않는다", async () => {
  // 캐시 미스에 이전 세션 내용을 보여주면 현재 후보의 답변처럼 오해할 수 있다.
  const pending = Promise.withResolvers<Result<HistoryPreview, ExpectedError>>();
  const app = await mount({ preview: async (tree, id) => id === "second" ? pending.promise
    : ok({ worktreeId: tree, id, text: "FIRST SESSION ANSWER", truncated: false }) });
  try {
    await app.open(); expect(app.captureCharFrame()).toContain("FIRST SESSION ANSWER");
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();

    // 실제 I/O는 미완료여도 고정 타이머나 다른 세션의 본문을 대신 표시하지 않는다.
    const frame = app.captureCharFrame();
    expect(frame).toContain("Preview · Saved keyboard"); expect(frame).not.toContain("FIRST SESSION ANSWER");
    expect(frame).not.toContain("Loading preview"); expect(!!app.renderer.root.findDescendantById("history-preview-loading")).toBe(false);
    expect(app.previews).toEqual(["first", "second"]);
    pending.resolve(ok({ worktreeId: "demo:main", id: "second", text: "SECOND SESSION ANSWER", truncated: false }));
    await app.visible("SECOND SESSION ANSWER");
  } finally { pending.resolve(ok({ worktreeId: "demo:main", id: "second", text: "late", truncated: false })); await app.close(); }
});

test("미리보기 캐시는 새로고침과 닫기에서 비우며 이전 세대 응답은 재사용하지 않는다", async () => {
  // 같은 saved ID라도 새로고침 이후에는 새 요청의 데이터만 사용할 수 있다.
  const old = Promise.withResolvers<Result<HistoryPreview, ExpectedError>>();
  const signals: (AbortSignal | undefined)[] = []; let calls = 0;
  const app = await mount({ preview: async (tree, id, signal) => {
    signals.push(signal); calls++;
    return calls === 1 ? old.promise : ok({ worktreeId: tree, id, text: `NEW PREVIEW ${calls}`, truncated: false });
  } });
  try {
    await app.open(); app.mockInput.pressKey("r", { ctrl: true }); await app.render();
    expect(signals[0]?.aborted).toBe(true); expect(app.captureCharFrame()).toContain("NEW PREVIEW 2");
    old.resolve(ok({ worktreeId: "demo:main", id: "first", text: "OBSOLETE PREVIEW", truncated: false })); await app.render();
    expect(app.captureCharFrame()).not.toContain("OBSOLETE PREVIEW");

    // 닫힌 모달의 본문 캐시를 다음 열기로 넘기지 않는다.
    app.mockInput.pressEscape(); await app.render(); await app.open();
    expect(app.captureCharFrame()).toContain("NEW PREVIEW 3"); expect(calls).toBe(3);
  } finally { old.resolve(ok({ worktreeId: "demo:main", id: "first", text: "late", truncated: false })); await app.close(); }
});

test("좁은 창은 목록과 미리보기를 전환하고 resize 뒤 검색과 커서를 유지한다", async () => {
  const app = await mount();
  try {
    await app.open(); await app.mockInput.typeText("keyboard"); app.clock.advance(150); await app.render();
    app.resize(60, 12); await app.render();
    expect(app.get("history-list").visible).toBe(true); expect(app.get("history-preview-pane").visible).toBe(false);
    expect(app.captureCharFrame().split("\n")[11]).toContain("Esc Close");
    expect(app.view.workViewPreferences.active["demo:main"] ?? "agent").toBe("agent");
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expect(app.get("history-list").visible).toBe(false); expect(app.get("history-preview-pane").visible).toBe(true);
    expect(app.captureCharFrame()).toContain("Saved question second");
    // Page through the card gutters as well as the content in the tiny preview viewport.
    const preview = app.get("history-preview") as ScrollBoxRenderable, initialScroll = preview.scrollTop;
    await app.mockInput.pressKeys(["\x1b[6~"]); await app.render();
    expect(preview.scrollTop).toBeGreaterThan(initialScroll);
    for (let page = 0; page < 10 && !app.captureCharFrame().includes("Saved answer second"); page++) {
      await app.mockInput.pressKeys(["\x1b[6~"]); await app.render();
    }
    expect(app.captureCharFrame()).toContain("Saved answer second");
    const dialog = app.get("history-dialog"); expect(dialog.x + dialog.width).toBeLessThanOrEqual(60); expect(dialog.y + dialog.height).toBeLessThanOrEqual(12);
    app.resize(140, 30); await app.render();
    expect(app.get("history-list").visible).toBe(true); expect(app.get("history-preview-pane").visible).toBe(true);
    expect((app.get("history-search") as InputRenderable).value).toBe("keyboard"); expect(app.resumed).toEqual([]);
  } finally { await app.close(); }
});

test("빈 목록·검색 결과 없음·조회 오류를 구분하고 커스텀 Refresh와 연결 복구를 지원한다", async () => {
  let calls = 0;
  const app = await mount({ keymap: expectOk(parseKeymap({ bindings: { "history.refresh": [{ keys: "ctrl+g", scope: "history-search" }] } })),
    list: async () => { calls++; if (calls === 1) throw new HistoryError("HISTORY_UNAVAILABLE", "Lookup failed"); return calls === 2 ? [] : [saved("restored", "Restored history")]; } });
  try {
    await app.open(); await app.visible("History error:"); expect(app.captureCharFrame()).toContain("Ctrl+g Refresh");
    app.mockInput.pressKey("r", { ctrl: true }); await app.render(); expect(calls).toBe(1);
    app.mockInput.pressKey("g", { ctrl: true }); await app.visible("No saved sessions");
    app.view.refreshHistory(); await app.visible("Restored history");
    await app.mockInput.typeText("nothing matches"); await app.visible("No matching sessions");
    app.mockInput.pressEscape(); app.view.refreshHistory(); await app.render(); expect(calls).toBe(3); expect(app.resumed).toEqual([]);
  } finally { await app.close(); }
});

test("busy와 resume 오류는 팝업에 남고 기존 열린 항목은 중복 생성 없이 선택한다", async () => {
  const app = await mount({ list: async () => [{ ...saved("busy", "Busy history"), unavailableReason: "Still closing" }, saved("broken", "Broken history"), { ...saved("open", "Open history"), openSessionId: "a1" }],
    resume: async (_tree, id) => { if (id === "broken") throw new HistoryError("HISTORY_UNAVAILABLE", "Cannot resume"); return "a1"; } });
  try {
    await app.open(); app.mockInput.pressEnter(); await app.render(); expect(app.captureCharFrame()).toContain("Still closing"); expect(app.resumed).toEqual([]);
    app.mockInput.pressArrow("down"); app.mockInput.pressEnter(); await app.visible("Resume error:"); expect(app.get("session-history").visible).toBe(true);
    expect(app.selection.sessionId).toBe("a1"); app.mockInput.pressArrow("down"); app.mockInput.pressEnter(); await app.waitFor(() => !app.get("session-history").visible);
    expect(app.resumed).toEqual(["demo:main/broken", "demo:main/open"]); expect(app.selection.sessionId).toBe("a1"); expect(app.runs).toEqual([]);
  } finally { await app.close(); }
});

test("미리보기 실패는 명시적으로 표시하며 검색과 Open은 계속 사용할 수 있다", async () => {
  const app = await mount({ preview: async () => ({ ok: false, error: new HistoryError("HISTORY_UNAVAILABLE", "Preview unavailable") }) });
  try {
    await app.open(); app.clock.advance(150); await app.visible("Preview unavailable");
    expect(app.selection.sessionId).toBe("a1"); app.mockInput.pressEnter(); await app.waitFor(() => app.selection.sessionId === "a2");
    expect(app.resumed).toEqual(["demo:main/first"]);
  } finally { await app.close(); }
});

test("팝업을 닫거나 워크트리가 바뀌면 이전 목록·미리보기 응답은 화면에 반영하지 않는다", async () => {
  const pending = Promise.withResolvers<readonly HistoryItem[]>(); let signal: AbortSignal | undefined;
  const app = await mount({ list: (_tree, current) => { signal = current; return pending.promise; } });
  try {
    await app.open(); app.selection.selectWorktree("demo:feature"); await app.render();
    expect(signal?.aborted).toBe(true); expect(app.get("session-history").visible).toBe(false);
    pending.resolve([saved("stale", "STALE RESPONSE")]); await app.render();
    expect(app.captureCharFrame()).not.toContain("STALE RESPONSE"); expect(app.resumed).toEqual([]);
  } finally { pending.resolve([]); await app.close(); }
});

test("Open 처리 중 닫아도 rollback을 보고하지 않고 늦은 응답으로 선택을 바꾸지 않는다", async () => {
  const pending = Promise.withResolvers<string>();
  const app = await mount({ resume: () => pending.promise });
  try {
    await app.open(); app.mockInput.pressEnter(); await app.render(); app.mockInput.pressEscape(); await app.render();
    expect(app.captureCharFrame()).toContain("does not cancel");
    pending.resolve("a2"); await app.render(); expect(app.selection.sessionId).toBe("a1"); expect(app.resumed).toEqual(["demo:main/first"]);
  } finally { pending.resolve("a2"); await app.close(); }
});

test("화면 제거 뒤 늦은 조회와 오류도 파괴된 native 버퍼에 쓰지 않고 타이머를 정리한다", async () => {
  const pending = Promise.withResolvers<readonly HistoryItem[]>();
  const app = await mount({ list: () => pending.promise });
  const cleared = spyOn(app.clock, "clearInterval");
  try {
    await app.open(); app.view.dispose(); pending.resolve([saved("late", "Late history")]); app.clock.advance(1000); await app.render();
    expect(cleared).toHaveBeenCalled(); expect(app.captureCharFrame()).not.toContain("Late history"); expect(app.resumed).toEqual([]);
  } finally { cleared.mockRestore(); await app.close(); }
});
