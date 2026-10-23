import { pressLeader } from "../../testing/keys.ts";
import { expect, spyOn, test } from "bun:test";
import { EditBufferRenderable, MarkdownRenderable, ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { TranscriptMarkdown } from "../../agents/ui/transcript-markdown.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { icons } from "../../icons.ts";
import { ok } from "../../result.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

const descendants = (node: Renderable): Renderable[] => node.getChildren().flatMap(child => [child, ...descendants(child)]);
const prose = (id: string, text: string, streaming = false): TranscriptSection => ({ id, text, kind: "assistant", title: "Agent", status: streaming ? "streaming" : "complete" });

async function mount() {
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock: new ManualClock() });
  let open = ["a", "b", "c", "d"];
  const states: Record<string, ExecutionState> = Object.fromEntries(open.map(id => [id, {
    conversationId: `conversation-${id}`, status: "working", output: "", error: null,
    // Section identities can repeat across conversations and must not share native buffers.
    sections: [prose("history", `${id} history`), prose("stream", `${id} streaming`, true), prose("tail", `${id} tail`)],
  }]));
  const snapshot = () => [{ id: "probe", name: "probe", worktrees: [{ id: "probe:main", name: "main", path: process.cwd(), branch: "main",
    sessions: open.map(id => ({ id, name: id, status: states[id]!.status, subagents: [] })),
  }] }];
  const selection = new WorkspaceSelection(snapshot());
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {}, onCloseSession() {}, onPrompt: () => ok(undefined), getSessionDetails: id => states[id] ?? null,
    initialDrafts: { a: "keep draft a", b: "keep draft b" },
  });
  const scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript viewport");
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  return { ...app, view, selection, states, scroll, render,
    markdown(text: string) {
      const node = descendants(scroll).find(node => node instanceof MarkdownRenderable && node.content === text);
      if (!(node instanceof MarkdownRenderable)) throw new Error(`Missing Markdown: ${text}`);
      return node;
    },
    async select(id: string) { selection.selectSession("probe:main", id); await render(); },
    async update(id: string, patch: Partial<ExecutionState>) { states[id] = { ...states[id]!, ...patch }; selection.replaceSnapshot(snapshot()); await render(); },
    async closeSession(id: string) { open = open.filter(current => current !== id); selection.replaceSnapshot(snapshot()); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test("다른 세션의 출력과 상태만 바뀌면 현재 대화는 갱신하지 않고 탭 상태만 반영한다", async () => {
  // A를 읽는 동안 B의 출력과 종료 상태가 함께 도착한다.
  const app = await mount(), updates = spyOn(TranscriptMarkdown.prototype, "update");
  try {
    const markdown = app.markdown("a history");
    updates.mockClear();

    // 비선택 세션의 변경도 실제 전역 snapshot 알림을 통해 전달한다.
    await app.update("b", { status: "failure", sections: [prose("history", "b background output")] });

    // 현재 대화는 그대로 두면서 B 탭의 실패 표시는 놓치지 않는다.
    expect(updates).not.toHaveBeenCalled();
    expect(app.markdown("a history") === markdown).toBe(true);
    expect(app.captureCharFrame()).toContain(icons.failure);
    expect(app.captureCharFrame()).not.toContain("b background output");
  } finally { updates.mockRestore(); await app.close(); }
});

test("현재 응답 한 섹션만 스트리밍되면 바뀌지 않은 과거 대화는 갱신하지 않는다", async () => {
  // 세 개의 Markdown 섹션 중 가운데 응답만 성장한다.
  const app = await mount(), updates = spyOn(TranscriptMarkdown.prototype, "update");
  try {
    const history = app.markdown("a history"), stream = app.markdown("a streaming");
    updates.mockClear();

    // IPC처럼 새 객체로 복원된 섹션도 값이 같은 과거 행은 변경으로 보지 않는다.
    await app.update("a", { sections: [prose("history", "a history"), prose("stream", "a streaming plus", true), prose("tail", "a tail")] });

    // 새 출력은 기존 버퍼에 반영하고 과거 Markdown의 갱신 비용은 발생시키지 않는다.
    expect(updates.mock.calls.map(([text]) => text)).toEqual(["a streaming plus"]);
    expect(app.markdown("a history") === history).toBe(true);
    expect(app.markdown("a streaming plus") === stream).toBe(true);
  } finally { updates.mockRestore(); await app.close(); }
});

test("Session round-trips reuse Markdown/source buffers while preserving drafts and selections", async () => {
  // Identical section IDs across sessions must not share A's selection.
  const app = await mount();
  try {
    const markdown = app.markdown("a history");
    pressLeader(app, "["); app.mockInput.pressKey("HOME"); app.mockInput.pressEnter();
    app.mockInput.pressKey("l"); app.mockInput.pressKey("v"); await app.render();
    const reader = app.renderer.currentFocusedRenderable;
    if (!(reader instanceof EditBufferRenderable)) throw new Error("Missing source reader");
    const selection = reader.getSelectedText(), cursor = reader.cursorOffset;

    // 화면에서는 이전 대화를 분리하되 객체와 읽기 상태는 파괴하지 않는다.
    await app.select("b");
    expect(markdown.isDestroyed).toBe(false);
    expect(descendants(app.scroll).includes(markdown)).toBe(false);
    await app.select("a");

    // 재진입 시에도 새 파싱이나 새 원문 버퍼 없이 같은 읽기 위치로 돌아온다.
    expect(app.markdown("a history") === markdown).toBe(true);
    expect(app.renderer.currentFocusedRenderable === reader).toBe(true);
    expect(reader.cursorOffset).toBe(cursor);
    expect(reader.getSelectedText()).toBe(selection);
    expect(app.view.promptDrafts).toMatchObject({ a: "keep draft a", b: "keep draft b" });
  } finally { await app.close(); }
});

test("보관 중인 세션의 응답이 바뀌면 돌아올 때 변경분과 삭제된 행을 반영한다", async () => {
  // A의 대화 UI를 보관한 상태에서 A에 새 출력이 들어온다.
  const app = await mount();
  try {
    const history = app.markdown("a history"), stream = app.markdown("a streaming"), removed = app.markdown("a tail");
    await app.select("b");
    await app.update("a", { sections: [prose("history", "a history"), prose("stream", "a finished"), prose("new", "a new response")] });

    // A를 다시 선택할 때 최신 snapshot과 보관된 행을 대조한다.
    await app.select("a");

    // 유지된 행은 재사용하고 삭제된 native 객체만 해제한다.
    expect(app.markdown("a history") === history).toBe(true);
    expect(app.markdown("a finished") === stream).toBe(true);
    expect(removed.isDestroyed).toBe(true);
    expect(app.captureCharFrame()).toContain("a new response");
  } finally { await app.close(); }
});

test("같은 탭의 conversation이 교체되면 보관된 이전 대화와 선택을 폐기한다", async () => {
  // 탭 ID가 같아도 초기화된 conversation에 이전 native 버퍼를 재사용해서는 안 된다.
  const app = await mount();
  try {
    const old = app.markdown("a history");
    await app.select("b");
    await app.update("a", { conversationId: "replacement-a", sections: [prose("history", "replacement history")] });

    // 초기화된 탭에 돌아오면 새 conversation으로 표시한다.
    await app.select("a");

    // 오래된 버퍼는 해제되고 예전 본문이나 선택이 새 대화에 섞이지 않는다.
    expect(old.isDestroyed).toBe(true);
    expect(app.markdown("replacement history") === old).toBe(false);
    expect(app.captureCharFrame()).not.toContain("a history");
    expect(app.view.workViewPreferences.agentViews?.a?.mode ?? "sections").toBe("sections");
  } finally { await app.close(); }
});

test("보관된 세션을 닫으면 화면 밖의 native 대화 객체도 즉시 해제한다", async () => {
  // A는 닫기 직전까지 화면 밖에서 재사용을 위해 보관된다.
  const app = await mount();
  try {
    const markdown = app.markdown("a history");
    await app.select("b");

    // 열린 세션 목록에서 사라진 대화는 캐시에 남겨두지 않는다.
    await app.closeSession("a");

    // 현재 세션은 유지되고 닫힌 대화의 native 자원은 해제된다.
    expect(markdown.isDestroyed).toBe(true);
    expect(app.selection.sessionId).toBe("b");
    expect(app.captureCharFrame()).toContain("b history");
  } finally { await app.close(); }
});

test("세션 보관 상한을 넘으면 가장 오래 안 본 대화를 해제하고 화면 종료 시 나머지도 해제한다", async () => {
  // 활성 대화 외에는 최근 사용한 두 세션까지만 native 트리를 보관한다.
  const app = await mount();
  const first = app.markdown("a history");
  let second: MarkdownRenderable | undefined, third: MarkdownRenderable | undefined;
  try {
    await app.select("b"); second = app.markdown("b history");
    await app.select("c"); third = app.markdown("c history");

    // 네 번째 세션으로 이동하면 가장 오래된 A가 보관 범위 밖으로 밀려난다.
    await app.select("d");

    // 최근 대화는 살아 있지만 오래된 대화는 계속 쌓이지 않는다.
    expect(first.isDestroyed).toBe(true);
    expect(second.isDestroyed).toBe(false);
    expect(third.isDestroyed).toBe(false);
  } finally { await app.close(); }
  expect(second?.isDestroyed).toBe(true);
  expect(third?.isDestroyed).toBe(true);
});

test.each([["following latest output", false], ["reading history", true]] as const)("Growing retained conversations preserve %s scroll intent on return", async (_label, paused) => {
  // Distinguish following latest output from reading historical content.
  const app = await mount();
  try {
    const history: TranscriptSection = { id: "history", kind: "user", title: "You", text: "Earlier line\n".repeat(80), status: "complete" };
    await app.update("a", { sections: [history] });
    if (paused) { pressLeader(app, "["); app.mockInput.pressKey("HOME"); await app.render(); }
    const position = app.scroll.scrollTop;
    await app.select("b");
    await app.update("a", { sections: [history, prose("new", "BACKGROUND_TAIL\n".repeat(30))] });

    // 화면 밖의 변경은 복귀 시 반영하되 사용자의 과거 읽기 의도는 덮어쓰지 않는다.
    await app.select("a");

    // 따라가던 대화만 새 맨 아래로 이동하고 멈춰 읽던 대화는 기존 위치를 유지한다.
    expect(app.view.workViewPreferences.agentViews?.a?.follow).toBe(!paused);
    if (paused) expect(app.scroll.scrollTop).toBe(position);
    else {
      expect(app.scroll.scrollTop).toBe(Math.max(0, app.scroll.scrollHeight - app.scroll.viewport.height));
      expect(app.captureCharFrame()).toContain("BACKGROUND_TAIL");
    }
  } finally { await app.close(); }
});

test("보관된 Markdown의 늦은 크기 변경은 현재 세션의 스크롤을 조작하지 않는다", async () => {
  // 하이라이트나 테마 작업이 끝나기 전에 A의 native 트리를 화면 밖으로 옮긴다.
  const app = await mount();
  try {
    const old = app.markdown("a history");
    await app.select("b");
    const scrollTo = spyOn(app.scroll, "scrollTo");
    try {
      // native 생명 주기에서 전달될 수 있는 늦은 resize를 그대로 전달한다.
      old.emit("resize");

      // 화면 밖의 소유자는 B의 자동 따라가기나 위치에 새 의도를 만들지 않는다.
      expect(scrollTo).not.toHaveBeenCalled();
      expect(app.selection.sessionId).toBe("b");
      expect(app.view.promptDrafts.b).toBe("keep draft b");
    } finally { scrollTo.mockRestore(); }
  } finally { await app.close(); }
});

test("보관된 섹션 수의 합이 상한을 넘으면 세션 개수가 적어도 오래된 대화를 해제한다", async () => {
  // 각 대화는 작아도 native 행이 합계 600개를 넘으면 계속 보관하지 않는다.
  const app = await mount();
  const sections = (id: string): TranscriptSection[] => [prose("history", `${id} history`),
    ...Array.from({ length: 300 }, (_, index): TranscriptSection => ({ id: `tool-${index}`, kind: "tool", title: "read", text: "result", status: "complete" }))];
  try {
    await app.update("a", { sections: sections("a") });
    const first = app.markdown("a history");
    await app.select("b");
    expect(first.isDestroyed).toBe(false);
    await app.update("b", { sections: sections("b") });
    const second = app.markdown("b history");

    // C로 이동하면 A와 B를 함께 보관하는 것이 섹션 수 예산을 초과한다.
    await app.select("c");

    // 최신 B를 남기고 오래된 A를 해제해 native 객체 수가 세션 수에만 의존하지 않는다.
    expect(first.isDestroyed).toBe(true);
    expect(second.isDestroyed).toBe(false);
  } finally { await app.close(); }
});

test("대화 원문이 보관 예산보다 크면 행이 적어도 화면을 떠날 때 native 버퍼를 해제한다", async () => {
  // 큰 도구 결과 하나가 섹션 수 제한만으로 보관되는 것을 막는다.
  const app = await mount();
  try {
    await app.update("a", { sections: [prose("history", "a history"),
      { id: "large-tool", kind: "tool", title: "read", text: "result line\n".repeat(200_000), status: "complete" }] });
    const markdown = app.markdown("a history");

    // 2 MiB가 넘는 원문을 가진 대화는 재사용 캐시에 넣지 않는다.
    await app.select("b");

    // 작은 Markdown을 포함해 같은 대화의 native 트리 전체가 해제된다.
    expect(markdown.isDestroyed).toBe(true);
    expect(app.captureCharFrame()).toContain("b history");
  } finally { await app.close(); }
});
