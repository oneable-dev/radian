import { expect, test } from "bun:test";
import { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { modelCommand } from "../../agents/model-selection.ts";
import { ok } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";

type Surface = "workspace" | "history" | "monitor" | "model";
const surfaces = ["workspace", "history", "monitor", "model"] as const;
const count = 40;

async function mount(surface: Surface) {
  const clock = new ManualClock(), app = await createTestRenderer({ width: 140, height: 30, kittyKeyboard: true, clock });
  const repository = demoWorkspace()[0]!, original = repository.worktrees[0]!;
  const names = Array.from({ length: count }, (_, index) => `candidate-${index}`);
  const sessions = names.map((name, index) => ({ id: `session-${index}`, name, status: "working" as const, subagents: [] }));
  const worktrees = surface === "workspace" ? names.map((name, index) => ({ ...original, id: `tree-${index}`, path: `/demo/${index}`, name, sessions: index ? [] : sessions }))
    : [{ ...original, sessions }];
  const selection = new WorkspaceSelection([{ ...repository, worktrees }]), opened: string[] = [], submitted: string[] = [];
  const body = Array.from({ length: 100 }, (_, index) => `Preview line ${index}`).join("\n");
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {}, onCloseSession() {},
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
  return { ...app, clock, view, selection, opened, submitted, input, list, get, render,
    async close() { view.dispose(); await app.dispose(); } };
}

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

test.each(surfaces)("%s 검색창에서는 Ctrl+D 삭제와 Ctrl+U 입력 지우기를 보존한다", async surface => {
  // 점프 키 때문에 검색어 편집이 후보 탐색으로 바뀌어서는 안 된다.
  const app = await mount(surface);
  try {
    await app.mockInput.typeText("abcd"); app.mockInput.pressArrow("left"); app.mockInput.pressArrow("left");

    app.mockInput.pressKey("d", { ctrl: true }); await app.render();
    expect(app.input.value).toBe("abd");
    app.mockInput.pressKey("END"); app.mockInput.pressKey("u", { ctrl: true }); await app.render();

    expect(app.input.value).toBe(""); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
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
