import { expect, test } from "bun:test";
import { InputRenderable, ScrollBoxRenderable, parseKeypress } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { modelCommand } from "../../agents/model-selection.ts";
import { ok } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";
import { SearchInput } from "../../ui/search-input.ts";

type Surface = "workspace" | "history" | "monitor" | "model";
const surfaces = ["workspace", "history", "monitor", "model"] as const;
const count = 40;

async function mount(surface: Surface) {
  const clock = new ManualClock(), app = await createTestRenderer({ width: 140, height: 30, kittyKeyboard: true, exitOnCtrlC: false, clock });
  const repository = demoWorkspace()[0]!, original = repository.worktrees[0]!;
  const names = Array.from({ length: count }, (_, index) => `candidate-${index}`);
  const sessions = names.map((name, index) => ({ id: `session-${index}`, name, status: "working" as const, subagents: [] }));
  const worktrees = surface === "workspace" ? names.map((name, index) => ({ ...original, id: `tree-${index}`, path: `/demo/${index}`, name, sessions: index ? [] : sessions }))
    : [{ ...original, sessions }];
  const selection = new WorkspaceSelection([{ ...repository, worktrees }]), opened: string[] = [], submitted: string[] = [];
  const interrupted: string[] = [], closed: string[] = [], detached: string[] = [];
  const body = Array.from({ length: 100 }, (_, index) => `Preview line ${index}`).join("\n");
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {}, onCloseSession: (_tree, id) => { closed.push(id); },
    onDetach: () => { detached.push("detach"); }, onInterrupt: async id => { interrupted.push(id); return ok(undefined); },
    initialDrafts: { "session-0": "KEEP_AGENT_DRAFT" },
    onPrompt: (_id, text) => { submitted.push(text); return ok(undefined); },
    getSessionDetails: id => ({ conversationId: `conversation-${id}`, status: "working", output: body, error: null }),
    onComplete: async () => ok({ items: [modelCommand], truncated: false }),
    onListHistory: async worktreeId => ok(names.map((title, index) => ({ id: `saved-${index}`, title, worktreeId, modified: "2026-10-21T00:00:00Z", messageCount: 1, openSessionId: null, unavailableReason: null }))),
    onPreviewHistory: async (worktreeId, id) => ok({ worktreeId, id, text: body, truncated: false }),
    onResumeSession: async (_tree, id) => { opened.push(id); return ok("session-0"); },
    onListModels: async (_id, conversationId) => ok({ conversationId, current: { provider: "fixture", id: names[0]! }, effort: "off",
      models: names.map(id => ({ provider: "fixture", id, name: id, contextWindow: 1000, images: false, reasoning: false, efforts: ["off"], effort: "off" })) }),
    onSelectModel: async (_id, _conversation, model) => { opened.push(model.id); return ok(null); },
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  await render();
  if (surface === "model") {
    const prompt = get("session-prompt") as InputRenderable;
    prompt.focus(); prompt.value = "/model"; await render(); clock.advance(150); await render(); app.mockInput.pressEnter(); await render(); app.mockInput.pressKey("/");
  } else if (surface === "workspace") app.mockInput.pressKey("f", { ctrl: true });
  else { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(surface === "history" ? "h" : "s"); }
  await render();
  const input = get(surface === "workspace" ? "workspace-search" : `${surface}-search`) as InputRenderable;
  const list = get(surface === "workspace" ? "workspace-tree" : `${surface}-list`) as ScrollBoxRenderable;
  return { ...app, clock, view, selection, opened, submitted, interrupted, closed, detached, input, list, get, render,
    async close() { view.dispose(); await app.dispose(); } };
}

test.each(surfaces)("%s 검색 팝업을 닫고 다시 열면 이전 검색어 없이 새 입력을 받는다", async surface => {
  // 같은 검색 입력 인스턴스를 재사용해도 팝업의 검색어는 초안으로 보존하지 않는다.
  const app = await mount(surface);
  try {
    await app.mockInput.typeText("candidate-1"); await app.render();
    app.mockInput.pressEscape(); await app.render();

    // 다시 여는 진입점이 달라도 검색어와 캐럿은 새 검색 상태여야 한다.
    if (surface === "model") {
      const prompt = app.get("session-prompt") as InputRenderable;
      prompt.focus(); prompt.value = "/model"; await app.render(); app.clock.advance(150); await app.render();
      app.mockInput.pressEnter(); await app.render(); app.mockInput.pressKey("/");
    } else if (surface === "workspace") app.mockInput.pressKey("f", { ctrl: true });
    else { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(surface === "history" ? "h" : "s"); }
    await app.render();

    // 필터만 초기화하거나 예전 텍스트 뒤에 새 검색어를 붙여서는 안 된다.
    expect(app.input.value).toBe(""); expect(app.input.cursorOffset).toBe(0);
    expect(app.captureCharFrame().split("\n")[app.input.y]).not.toContain("candidate-1");
    await app.mockInput.typeText("candidate-2"); await app.render();
    expect(app.input.value).toBe("candidate-2"); expect(app.captureCharFrame()).toContain("candidate-2");
    expect(app.opened).toEqual([]); expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test.each(surfaces)("%s 검색은 공용 입력의 여백·포커스 배경을 사용하고 리사이즈 후에도 커서를 보존한다", async surface => {
  // 검색 대상은 달라도 입력 영역 전체의 모양과 클릭 계약은 같아야 한다.
  const app = await mount(surface);
  try {
    if (!(app.input instanceof SearchInput)) throw new Error("Missing shared search field");
    const input = app.input, field = input.field;
    await app.mockInput.typeText("candidate"); app.mockInput.pressArrow("left");
    const value = input.value, cursor = input.cursorOffset;
    const background = (x: number, y: number) => {
      let end = 0;
      return app.captureSpans().lines[y]!.spans.find(span => { end += span.width; return end > x; })!.bg.toInts();
    };

    // 넓고 좁은 터미널에서 결과 목록으로 나갔다가 입력 여백을 눌러 돌아온다.
    for (const width of [120, 60]) {
      app.resize(width, 30); await app.render(); app.list.focus(); await app.render();
      expect(background(field.x + 1, field.y)).toEqual(uiTheme(app.renderer).styles["ui.input"].bg!.toInts());
      await app.mockMouse.click(field.x + 1, field.y); await app.render();

      // 입력은 한 줄이며 양쪽·상하 여백과 포커스 배경은 화면별 덮어쓰기 없이 일치한다.
      expect(field.height).toBe(3); expect(input.height).toBe(1); expect(input.y - field.y).toBe(1);
      expect(input.x - field.x).toBe(width < 80 ? 1 : 2);
      expect(field.x + field.width - input.x - input.width).toBe(width < 80 ? 1 : 2);
      expect(background(field.x + 1, field.y)).toEqual(uiTheme(app.renderer).styles["ui.inputFocused"].bg!.toInts());
      expect(app.renderer.currentFocusedRenderable).toBe(input); expect(input.value).toBe(value); expect(input.cursorOffset).toBe(cursor);
    }
    expect(input.maxLength).toBe(256); expect(app.opened).toEqual([]); expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test.each(surfaces)("%s 목록의 Ctrl+D/U는 반 페이지 후보를 왕복하며 Enter 전에는 확정하지 않는다", async surface => {
  // 실제 목록 높이와 행 간격에 맞춰 한 번에 여러 후보를 이동한다.
  const app = await mount(surface);
  try {
    await app.mockInput.typeText("candidate"); app.mockInput.pressTab(); await app.render();
    const stride = surface === "workspace" || surface === "monitor" ? 3 : 2;
    const step = Math.max(1, Math.floor(app.list.viewport.height / (2 * stride)));
    expect(step).toBeGreaterThan(1);

    // 위쪽 경계에서도 현재 후보를 유지하고 마지막 점프만 확정한다.
    app.mockInput.pressKey("d", { ctrl: true }); app.mockInput.pressKey("u", { ctrl: true });
    app.mockInput.pressKey("u", { ctrl: true }); app.mockInput.pressKey("d", { ctrl: true }); await app.render();

    expect(app.input.value).toBe("candidate"); expect(app.opened).toEqual([]);
    expect(app.selection.sessionId).toBe("session-0"); expect(app.submitted).toEqual([]);
    expect(app.renderer.currentFocusedRenderable).toBe(app.list);
    const id = surface === "workspace" ? `worktree:tree-${step}` : surface === "history" ? `history:saved-${step}`
      : surface === "monitor" ? `monitor:session-${step}` : `model:${JSON.stringify(["fixture", `candidate-${step}`])}`;
    const row = app.get(id);
    if (surface === "workspace") expect(app.captureCharFrame().split("\n")[row.y]![row.x]).toBe("┌");
    else {
      let column = 0;
      const span = app.captureSpans().lines[row.y]!.spans.find(span => { column += span.width; return column > row.x + 1; });
      expect(span?.bg.toInts()).toEqual(uiTheme(app.renderer).styles["ui.selection"].bg!.toInts());
    }
    app.mockInput.pressEnter(); await app.render();

    if (surface === "workspace") expect(app.selection.worktree?.id).toBe(`tree-${step}`);
    else if (surface === "monitor") expect(app.selection.sessionId).toBe(`session-${step}`);
    else expect(app.opened).toEqual([surface === "history" ? `saved-${step}` : `candidate-${step}`]);
  } finally { await app.close(); }
});

test.each(surfaces)("%s 목록의 반 페이지 점프는 마지막 후보에서 멈추고 위로 돌아간다", async surface => {
  // 목록 끝의 점프가 빈 선택이나 화면 밖 인덱스를 만들면 안 된다.
  const app = await mount(surface);
  try {
    app.mockInput.pressTab(); await app.render();
    const stride = surface === "workspace" || surface === "monitor" ? 3 : 2;
    const step = Math.max(1, Math.floor(app.list.viewport.height / (2 * stride)));

    app.mockInput.pressKey("END"); app.mockInput.pressKey("d", { ctrl: true }); app.mockInput.pressKey("u", { ctrl: true });
    app.mockInput.pressEnter(); await app.render();

    const index = count - 1 - step;
    if (surface === "workspace") expect(app.selection.worktree?.id).toBe(`tree-${index}`);
    else if (surface === "monitor") expect(app.selection.sessionId).toBe(`session-${index}`);
    else expect(app.opened).toEqual([surface === "history" ? `saved-${index}` : `candidate-${index}`]);
    expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test.each(surfaces.flatMap(surface => (["d", "u"] as const).map(key => ({ surface, key }))))("$surface 검색창의 Ctrl+$key 입력은 검색어를 보존하며 목록으로 포커스를 옮겨 점프한다", async ({ surface, key }) => {
  // 목록 중간 후보를 선택하고 입력 커서를 옮겨 문자 삭제와 필터 초기화를 모두 검출한다.
  const app = await mount(surface);
  try {
    await app.mockInput.typeText("candidate"); await app.render();
    for (let index = 0; index < 20; index++) { app.mockInput.pressKey("n", { ctrl: true }); await app.render(); }
    app.mockInput.pressArrow("left"); app.mockInput.pressArrow("left"); await app.render();
    const cursor = app.input.cursorOffset;
    const stride = surface === "workspace" || surface === "monitor" ? 3 : 2;
    const step = Math.max(1, Math.floor(app.list.viewport.height / (2 * stride)));
    const selected = 20 + (key === "d" ? step : -step);

    app.mockInput.pressKey(key, { ctrl: true }); await app.render();

    expect(app.input.value).toBe("candidate"); expect(app.input.cursorOffset).toBe(cursor);
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.list.id); expect(app.opened).toEqual([]); expect(app.submitted).toEqual([]);
    app.mockInput.pressEnter(); await app.render();
    if (surface === "workspace") expect(app.selection.worktree?.id).toBe(`tree-${selected}`);
    else if (surface === "monitor") expect(app.selection.sessionId).toBe(`session-${selected}`);
    else expect(app.opened).toEqual([surface === "history" ? `saved-${selected}` : `candidate-${selected}`]);
  } finally { await app.close(); }
});

test("빈 워크스페이스 검색창의 Ctrl+D/U도 현재 후보에서 목록 점프를 이어간다", async () => {
  // 검색어가 없더라도 현재 후보를 초기화하지 않고 결과 목록으로 포커스를 넘긴다.
  const app = await mount("workspace");
  try {
    for (let index = 0; index < 6; index++) app.mockInput.pressKey("n", { ctrl: true });
    await app.render();

    app.mockInput.pressKey("d", { ctrl: true }); app.mockInput.pressKey("u", { ctrl: true }); await app.render();

    expect(app.input.value).toBe(""); expect(app.input.cursorOffset).toBe(0);
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.list.id);
    app.mockInput.pressEnter(); await app.render(); expect(app.selection.worktree?.id).toBe("tree-6");
  } finally { await app.close(); }
});

test("검색창은 기본 후보 탐색과 반 페이지 점프를 푸터에서 생략한다", async () => {
  // 실제 점프 동작은 앞선 상호작용 시나리오로 유지하고 기본 안내만 숨긴다.
  const app = await mount("workspace");
  try {
    await app.mockInput.typeText("candidate"); await app.render();

    const footer = app.captureCharFrame().split("\n")[app.renderer.height - 1]!;

    expect(footer).not.toMatch(/<C-[npd]>|Navigate|½ page/u);
    expect(footer).toContain("Help");
  } finally { await app.close(); }
});

test.each(surfaces)("%s 검색창의 Ctrl+C는 검색어만 지우고 실행·초안·모달을 유지한다", async surface => {
  // 실행 중인 Agent와 열린 모달 뒤의 초안을 검색 취소 동작과 분리한다.
  const app = await mount(surface);
  try {
    await app.mockInput.typeText("candidate");
    const drafts = app.view.promptDrafts;
    const modal = app.get(surface === "workspace" ? "workspace-picker" : surface === "history" ? "session-history" : surface === "monitor" ? "session-monitor" : "model-picker");

    app.mockInput.pressCtrlC(); await app.render();
    expect(app.input.value).toBe("");
    app.mockInput.pressCtrlC(); await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id); expect(modal.visible).toBe(true);
    expect(app.opened).toEqual([]); expect(app.submitted).toEqual([]); expect(app.selection.sessionId).toBe("session-0");
    expect(app.interrupted).toEqual([]); expect(app.closed).toEqual([]); expect(app.detached).toEqual([]);
    expect(app.view.promptDrafts).toEqual(drafts); expect(app.view.root.isDestroyed).toBe(false);
  } finally { await app.close(); }
});

test.each(surfaces)("%s 검색창의 Ctrl+L은 검색어 지우기 별칭으로 동작하지 않는다", async surface => {
  // 검색 초기화는 Ctrl+C만 담당하고 Ctrl+L을 호환 별칭으로 남기지 않는다.
  const app = await mount(surface);
  try {
    await app.mockInput.typeText("candidate"); const cursor = app.input.cursorOffset;

    app.mockInput.pressKey("l", { ctrl: true }); await app.render();

    expect(app.input.value).toBe("candidate"); expect(app.input.cursorOffset).toBe(cursor);
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id); expect(app.opened).toEqual([]); expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test("빈 검색창의 Ctrl+C는 후보와 스크롤을 초기화하지 않고 기존 선택을 유지한다", async () => {
  // 검색어가 없는 상태에서는 전체 검색 초기화 이벤트도 필요하지 않다.
  const app = await mount("workspace");
  try {
    for (let index = 0; index < 6; index++) app.mockInput.pressKey("n", { ctrl: true });
    await app.render(); const top = app.list.scrollTop;

    app.mockInput.pressCtrlC(); await app.render();

    expect(app.input.value).toBe(""); expect(app.list.scrollTop).toBe(top); expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id);
    app.mockInput.pressEnter(); await app.render();
    expect(app.selection.worktree?.id).toBe("tree-6"); expect(app.interrupted).toEqual([]); expect(app.detached).toEqual([]);
  } finally { await app.close(); }
});

test.each(["d", "u"] as const)("검색창에서 누른 Ctrl+%s는 목록으로 이동한 뒤 반복 입력도 계속 점프한다", async key => {
  // 포커스 이동이 같은 키를 중복 처리하거나 이후의 의도적인 반복 입력을 막으면 안 된다.
  const app = await mount("workspace");
  const raw = (event: string) => { const parsed = parseKeypress(event, { useKittyKeyboard: true }); if (!parsed) throw new Error("Invalid Kitty key"); app.renderer.keyInput.processParsedKey(parsed); };
  const code = key === "d" ? 100 : 117;
  try {
    await app.mockInput.typeText("candidate");
    for (let index = 0; index < 15; index++) app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    const step = Math.max(1, Math.floor(app.list.viewport.height / 6));

    raw(`\x1b[${code};5u`); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.list.id);
    raw(`\x1b[${code};5:2u`); await app.render();

    expect(app.input.value).toBe("candidate");
    raw(`\x1b[${code};5:3u`); raw(`\x1b[${code};5u`); raw(`\x1b[${code};5:3u`); await app.render();
    app.mockInput.pressEnter(); await app.render();

    expect(app.selection.worktree?.id).toBe(`tree-${15 + (key === "d" ? 3 * step : -3 * step)}`);
    expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});

test.each(["history", "monitor"] as const)("좁은 %s 모달의 검색 점프는 미리보기에서 결과 목록으로 돌아간다", async surface => {
  // 좁은 화면에서 미리보기만 표시 중이어도 검색 점프의 대상은 결과 목록이다.
  const app = await mount(surface);
  try {
    app.resize(60, 18); await app.render(); await app.mockInput.typeText("candidate"); await app.render();
    for (let index = 0; index < 10; index++) { app.mockInput.pressKey("n", { ctrl: true }); await app.render(); }
    const step = Math.max(1, Math.floor(app.list.viewport.height / (2 * (surface === "history" ? 2 : 3))));
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expect(app.list.visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.input);

    app.mockInput.pressKey("d", { ctrl: true }); await app.render();

    expect(app.list.visible).toBe(true); expect(app.renderer.currentFocusedRenderable?.id).toBe(app.list.id);
    expect(app.get(`${surface}-preview-pane`).visible).toBe(false); expect(app.input.value).toBe("candidate");
    const selected = 10 + step, row = app.get(surface === "history" ? `history:saved-${selected}` : `monitor:session-${selected}`);
    expect(row.y).toBeGreaterThanOrEqual(app.list.viewport.y); expect(row.y + row.height).toBeLessThanOrEqual(app.list.viewport.y + app.list.viewport.height);
    app.mockInput.pressEnter(); await app.render();
    if (surface === "history") expect(app.opened).toEqual([`saved-${selected}`]);
    else expect(app.selection.sessionId).toBe(`session-${selected}`);
  } finally { await app.close(); }
});

test.each(surfaces)("%s 검색 결과가 없어도 점프 키는 입력을 보존하고 목록으로 포커스를 옮긴다", async surface => {
  // 빈 결과에서 점프를 확정이나 네이티브 문자 삭제로 해석하지 않는다.
  const app = await mount(surface);
  try {
    await app.mockInput.typeText("no-matching-candidate"); await app.render();
    const value = app.input.value, cursor = app.input.cursorOffset;

    app.mockInput.pressKey("d", { ctrl: true }); app.mockInput.pressEnter(); await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.list.id); expect(app.input.value).toBe(value); expect(app.input.cursorOffset).toBe(cursor);
    expect(app.opened).toEqual([]); expect(app.submitted).toEqual([]); expect(app.selection.sessionId).toBe("session-0");
  } finally { await app.close(); }
});

test.each(["history", "monitor"] as const)("%s 미리보기의 Ctrl+D/U는 후보를 바꾸지 않고 본문만 반 페이지 이동한다", async surface => {
  // 같은 모달 안에서도 목록과 미리보기는 포커스한 영역을 대상으로 점프한다.
  const app = await mount(surface);
  try {
    app.mockInput.pressKey("o", { ctrl: true }); app.clock.advance(150); await app.render();
    const preview = app.get(`${surface}-preview`) as ScrollBoxRenderable;
    preview.scrollTo(0); await app.render();
    const half = Math.max(1, Math.floor(preview.viewport.height / 2));

    app.mockInput.pressKey("d", { ctrl: true }); await app.render();
    expect(preview.scrollTop).toBe(half);
    app.mockInput.pressKey("u", { ctrl: true }); await app.render();

    expect(preview.scrollTop).toBe(0); expect(app.opened).toEqual([]);
    app.mockInput.pressKey("o", { ctrl: true }); app.mockInput.pressEnter(); await app.render();
    if (surface === "history") expect(app.opened).toEqual(["saved-0"]);
    else expect(app.selection.sessionId).toBe("session-0");
  } finally { await app.close(); }
});

test("상세 대화상자의 Ctrl+D/U는 본문을 반 페이지 이동한다", async () => {
  // 도움말과 알림 상세처럼 후보 선택이 없는 표면은 본문 스크롤이 점프 대상이다.
  const app = await mount("workspace");
  try {
    app.mockInput.pressEscape(); app.view.setNotice(Array.from({ length: 100 }, (_, index) => `Details line ${index}`).join("\n")); await app.render();
    const details = app.get("footer-notice-details"); await app.mockMouse.click(details.x, details.y); await app.render();
    const scroll = app.get("text-dialog-scroll") as ScrollBoxRenderable, half = Math.floor(scroll.viewport.height / 2);

    app.mockInput.pressKey("d", { ctrl: true }); await app.render();
    expect(scroll.scrollTop).toBe(half);
    app.mockInput.pressKey("u", { ctrl: true }); await app.render();

    expect(scroll.scrollTop).toBe(0);
    app.mockInput.pressKey("n", { ctrl: true }); await app.render(); expect(scroll.scrollTop).toBe(1);
    app.mockInput.pressKey("p", { ctrl: true }); await app.render(); expect(scroll.scrollTop).toBe(0);
    expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});
