import { openWorkspaceSearch, pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { parseKeypress, ScrollBoxRenderable } from "@opentui/core";
import { resolve } from "node:path";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { filterCatalog, filterCompletions, type CompletionItem, type CompletionResult } from "../../agents/completion.ts";
import type { CompletionProvider } from "../../agents/ui/completion-menu.ts";
import { CapabilityError, InputError } from "../../errors.ts";
import { err, ok } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";

const commandItems = ["mcp", "memory"].map((value) => ({ kind: "command" as const, value, description: `Command ${value}` }));
const fileItems = ["src/main.ts", "src/문서 file.ts"].map((value) => ({ kind: "file" as const, value, description: "Worktree file" }));
async function mount(provider: CompletionProvider = async (_id, query) => ok(filterCompletions(query.kind === "file" ? fileItems : commandItems, query.query)), submit?: NonNullable<WorkbenchActions["onPrompt"]>) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace());
  const sent: string[] = [];
  let output = "Streaming transcript";
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {},
    onPrompt: (id, text, images) => { sent.push(text); return submit ? submit(id, text, images) : ok(undefined); }, onComplete: provider,
    getSessionDetails: () => ({ status: "working", output, error: null }),
  });
  const render = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await app.renderOnce(); await app.renderOnce(); };
  await render(); pressLeader(app, "a"); await render();
  const input = app.renderer.root.findDescendantById("session-prompt") as PromptInput;
  const complete = async () => { await render(); clock.advance(150); await render(); };
  return { ...app, clock, selection, view, input, sent, render, complete,
    menu: () => app.renderer.root.findDescendantById("prompt-completions")!,
    async type(text: string) { await app.mockInput.typeText(text); await complete(); },
    async stream(text: string) { output = text; selection.replaceSnapshot(selection.snapshot); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test("명령어 자동완성은 중간 문자열을 제외하고 접두사 후보만 표시한다", async () => {
  // The menu contains mcp, whose suffix must not become an executable candidate.
  const app = await mount();
  try {
    await app.type("/cp");

    // Editing within the same menu must immediately apply the prefix policy.
    expect(app.captureCharFrame()).toContain("No matches");
    app.input.value = "/mc"; await app.complete();

    // Candidate discovery preserves the draft and does not submit a command.
    expect(app.captureCharFrame()).toContain("Command mcp");
    expect(app.input.value).toBe("/mc"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test.each(["/", "$", "@"] as const)("준비된 %s 목록은 시계 대기·로딩·추가 조회 없이 바로 표시한다", async (trigger) => {
  // 캐시가 준비된 후에는 서버나 파일시스템을 다시 조회할 이유가 없다.
  const items: readonly CompletionItem[] = [
    { kind: "command", value: "compact", description: "Compact context" },
    { kind: "skill", value: "skill:review-code", description: "Review code" },
    { kind: "file", value: "docs/reference.ts", description: "Reference file" },
  ];
  let requests = 0, reads = 0;
  const provider: CompletionProvider = Object.assign(async () => { requests++; return ok({ items, truncated: false }); }, {
    read: (_id: string, query: Parameters<CompletionProvider>[1]) => { reads++; return ok(query.kind === "file" ? filterCompletions(items.filter(item => item.kind === "file"), query.query) : filterCatalog(items, query)); },
  });
  const app = await mount(provider);
  try {
    // 타이머를 진행시키지 않아도 첫 입력이 현재 종류의 후보를 즉시 표시한다.
    await app.mockInput.typeText(trigger); await app.render();

    const expected = trigger === "/" ? "compact" : trigger === "$" ? "review-code" : "docs/reference.ts";
    expect(app.menu().visible).toBe(true); expect(app.captureCharFrame()).toContain(`→ ${expected}`);
    expect(app.renderer.root.findDescendantById("completion-loading")!.visible).toBe(false);
    expect(app.captureCharFrame()).not.toContain("Loading"); expect(requests).toBe(0);
    const before = reads; await app.stream("More background output"); expect(reads).toBe(before);
    app.mockInput.pressTab(); await app.render();

    expect(app.input.value).toBe(trigger === "@" ? "[File #1] " : `${trigger}${expected} `);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test.each([
  { trigger: "/", width: 120 }, { trigger: "@", width: 120 }, { trigger: "$", width: 120 },
  { trigger: "/", width: 80 }, { trigger: "@", width: 80 }, { trigger: "$", width: 80 },
  { trigger: "/", width: 60 }, { trigger: "@", width: 60 }, { trigger: "$", width: 60 },
] as const)("%j에서 완성 화살표는 입력 시작 열과 일치하고 선택 이동 후에도 유지된다", async ({ trigger, width }) => {
  // 메뉴 종류와 패널 여백이 달라도 입력 시작보다 한 칸 더 들여쓰지 않아야 한다.
  const items: readonly CompletionItem[] = [
    { kind: "command", value: "clear", description: "Clear conversation" }, { kind: "command", value: "compact", description: "Compact context" },
    { kind: "skill", value: "skill:review-code", description: "Review code" }, { kind: "skill", value: "skill:write-tests", description: "Write tests" },
    { kind: "file", value: "a.ts", description: "First file" }, { kind: "file", value: "b.ts", description: "Second file" },
  ];
  const provider: CompletionProvider = Object.assign(async () => ok({ items, truncated: false }), {
    read: (_id: string, query: Parameters<CompletionProvider>[1]) => ok(query.kind === "file" ? filterCompletions(items.filter(item => item.kind === "file"), query.query) : filterCatalog(items, query)),
  });
  const app = await mount(provider);
  const arrowColumn = (row: number) => {
    const line = app.captureCharFrame().split("\n")[row]!;
    expect(line).toContain("→ ");
    return Bun.stringWidth(line.slice(0, line.indexOf("→ ")));
  };
  try {
    // 입력과 메뉴를 같은 화면에서 실제 렌더링한 뒤 다음 후보로 선택을 옮긴다.
    app.resize(width, 24); await app.render();
    await app.mockInput.typeText(trigger); await app.render();
    const first = app.renderer.root.findDescendantById("completion-option-0")!;

    expect(first.x).toBe(app.input.x); expect(arrowColumn(first.y)).toBe(app.input.x);
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    const second = app.renderer.root.findDescendantById("completion-option-1")!;
    expect(second.x).toBe(app.input.x); expect(arrowColumn(second.y)).toBe(app.input.x);
    expect(app.input.value).toBe(trigger); expect(app.input.cursorOffset).toBe(1);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("같은 검색어의 감시 갱신은 새 후보를 반영하면서 선택한 항목을 유지한다", async () => {
  // 파일 감시나 리로드 이벤트는 입력을 다시 치지 않아도 열린 목록을 갱신해야 한다.
  let items: readonly CompletionItem[] = ["command-a", "command-b"].map(value => ({ kind: "command", value, description: "Command" }));
  let changed: (() => void) | undefined;
  const provider: CompletionProvider = Object.assign(async () => ok({ items, truncated: false }), {
    read: (_id: string, query: Parameters<CompletionProvider>[1]) => ok(filterCatalog(items, query)),
    subscribe: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; },
  });
  const app = await mount(provider);
  try {
    await app.mockInput.typeText("/"); await app.render(); app.mockInput.pressKey("n", { ctrl: true }); await app.render();

    // 앞쪽에 새 항목이 들어와도 인덱스가 아니라 항목 이름으로 선택을 보존한다.
    items = [{ kind: "command", value: "command-0", description: "New" }, ...items]; changed?.(); await app.render();

    expect(app.captureCharFrame()).toContain("→ command-b"); expect(app.menu().height).toBe(3);
    app.mockInput.pressTab(); await app.render(); expect(app.input.value).toBe("/command-b ");
    expect(app.sent).toEqual([]);
  } finally { await app.close(); expect(changed).toBeUndefined(); }
});

test("캐시 재로딩 중 Enter는 이전 카탈로그의 명령을 실행하지 않는다", async () => {
  // 리로드 알림과 새 목록 도착 사이에도 이전 후보를 최신 후보로 간주하지 않아야 한다.
  const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
  let ready = true, changed: (() => void) | undefined;
  let items: readonly CompletionItem[] = [{ kind: "command", value: "compact", description: "Old command" }];
  const provider: CompletionProvider = Object.assign(async () => pending.promise, {
    read: (_id: string, query: Parameters<CompletionProvider>[1]) => ready ? ok(filterCatalog(items, query)) : undefined,
    subscribe: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; },
  });
  const app = await mount(provider);
  try {
    await app.mockInput.typeText("/co"); await app.render();

    // 캐시가 무효화된 상태에서 Enter를 눌러도 이전 명령으로 즉시 전송하지 않는다.
    ready = false; changed?.(); await app.render(); app.mockInput.pressEnter(); await app.render();
    expect(app.sent).toEqual([]);
    items = [{ kind: "command", value: "compare", description: "New command" }]; ready = true;
    changed?.(); pending.resolve(ok({ items, truncated: false })); await app.render();

    expect(app.sent).toEqual([]); expect(app.input.value).toBe("/co");
    expect(app.captureCharFrame()).toContain("→ compare");
  } finally { pending.resolve(ok({ items: [], truncated: false })); await app.close(); }
});

test("스킬은 슬래시 추천에서 제외하고 달러에서만 선택한다", async () => {
  // 이전 단일 카탈로그 공급자도 UI에서 명령과 스킬을 섞어 노출하지 않는다.
  const app = await mount(async () => ok({ items: [
    { kind: "command", value: "compact", description: "Compact context" },
    { kind: "skill", value: "skill:review-code", description: "Review fixture" },
  ], truncated: false }));
  try {
    await app.type("/");
    expect(app.captureCharFrame()).toContain("→ compact"); expect(app.captureCharFrame()).not.toContain("Review fixture");

    // 달러 선택은 기존 스킬을 제거하지 않고 별도 입구로만 노출한다.
    app.input.value = "$rev"; await app.complete();
    expect(app.captureCharFrame()).toContain("→ review-code"); expect(app.captureCharFrame()).not.toContain("Compact context");
    app.mockInput.pressEnter(); await app.render();

    expect(app.sent).toEqual(["$review-code"]); expect(app.input.value).toBe("");
  } finally { await app.close(); }
});

test("슬래시 목록은 닫혀 있을 때 공간이 없고 조회 상태와 결과 수에 맞춰 높이를 바꾼다", async () => {
  // 많은 후보·한 후보·빈 결과·오류가 모두 같은 입력 아래 공간을 동적으로 사용한다.
  const items = [
    { kind: "command" as const, value: "compact", description: "Compact context" },
    { kind: "command" as const, value: "model", description: "Select model" },
    ...Array.from({ length: 92 }, (_, i) => ({ kind: "command" as const, value: `fixture-${i}`, description: "Fixture command" })),
  ];
  const app = await mount(async (_id, query) => query.query === "error" ? err(new CapabilityError("Lookup failed")) : ok(filterCompletions(items, query.query)));
  const geometry = () => [app.input.y, app.renderer.root.findDescendantById("session-transcript")!.height];
  try {
    const closed = geometry(), composer = app.renderer.root.findDescendantById("agent-composer")!;
    const metadata = app.renderer.root.findDescendantById("session-status")!;
    expect(app.menu().visible).toBe(false); expect(metadata.y).toBe(composer.y + composer.height);

    // 슬래시를 누르면 로딩 한 줄부터 시작해 실제 후보 다섯 줄과 하단 위치 표시로 확장한다.
    app.mockInput.pressKey("/"); await app.render();
    expect(app.menu().height).toBe(1);
    app.clock.advance(150); await app.render();

    const menu = app.menu();
    const lines = () => app.captureCharFrame().split("\n").slice(menu.y, menu.y + menu.height);
    expect(menu.y).toBe(composer.y + composer.height); expect(menu.height).toBe(6);
    expect(lines()[0]).toContain("→ compact"); expect(lines().at(-1)).toContain("(1/94)");
    expect(lines().join("\n")).not.toContain("Commands · SDK resources");

    // 검색을 좁히거나 결과가 없어지면 사용하지 않는 후보 행을 즉시 돌려준다.
    app.input.value = "/model"; await app.complete();
    expect(menu.height).toBe(1); expect(lines()[0]).toContain("→ model");
    app.input.value = "/nomatch"; await app.complete();
    expect(menu.height).toBe(1); expect(lines()[0]).toContain("No matches");
    app.input.value = "/error"; await app.complete();
    expect(menu.height).toBe(1); expect(lines()[0]).toContain("Lookup failed");
    app.mockInput.pressEscape(); await app.render();

    // 닫힌 목록은 빈 행을 남기지 않고 원래 입력 위치와 대화 높이를 복원한다.
    expect(menu.visible).toBe(false); expect(metadata.y).toBe(composer.y + composer.height); expect(geometry()).toEqual(closed);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test.each([false, true])("완성 목록은 명령과 설명을 셀 너비로 정렬하고 선택은 화살표와 글자색으로 표시한다: light=%j", async (light) => {
  // 한글·결합 이모지가 있는 명령도 설명 열과 클릭 대상이 다른 행과 일치해야 한다.
  const items = [
    { kind: "template" as const, value: "guide:문서👩🏽‍💻", description: "Document guide" },
    { kind: "command" as const, value: "model", description: "Select model" },
  ];
  const app = await mount(async () => ok({ items, truncated: false }));
  const cell = (x: number, y: number) => {
    let column = 0;
    return app.captureSpans().lines[y]!.spans.find(span => { column += span.width; return column > x; })!;
  };
  try {
    uiTheme(app.renderer).configure({ palette: [], defaultForeground: light ? "#202020" : "#EEEEEE", defaultBackground: light ? "#FFFFFF" : "#101010",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });

    // 두 후보는 별도 제목이나 빈 행 없이 바로 입력창 아래에 배치된다.
    await app.type("/"); app.clock.advance(500); await app.render();

    const menu = app.menu(), lines = app.captureCharFrame().split("\n"), first = lines[menu.y]!, second = lines[menu.y + 1]!;
    const descriptionX = Bun.stringWidth(first.slice(0, first.indexOf("Document guide")));
    expect(menu.height).toBe(2); expect(first).toContain("→ guide:문서👩🏽‍💻");
    expect(descriptionX).toBe(Bun.stringWidth(second.slice(0, second.indexOf("Select model"))));
    const colors = uiTheme(app.renderer).colors;
    expect(cell(menu.x, menu.y).fg.toInts()).toEqual(colors.accent.toInts());
    expect(cell(descriptionX, menu.y + 1).fg.toInts()).toEqual(colors.muted.toInts());
    for (const y of [menu.y, menu.y + 1]) expect(cell(descriptionX, y).bg.toInts()).toEqual(colors.panel.toInts());

    // 후보 클릭은 삽입만 하고 입력 포커스와 기존 전송 계약을 유지한다.
    await app.mockMouse.click(menu.x + 4, menu.y + 1); await app.render();
    expect(app.input.value).toBe("/model "); expect(app.menu().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("많은 후보는 창 크기에 맞춰 줄이고 선택 위치를 스크롤하며 닫을 때 공간을 반환한다", async () => {
  // 화면에 다 들어가지 않는 후보는 전체 목록을 유지한 채 보이는 행만 제한한다.
  const items = Array.from({ length: 20 }, (_, i) => ({ kind: "command" as const, value: `command-${i}`, description: "Command description" }));
  const app = await mount(async () => ok({ items, truncated: true }));
  try {
    await app.type("/");

    // 첫 페이지를 넘긴 선택은 마지막 보이는 후보와 하단 위치 표시로 함께 이동한다.
    for (let i = 0; i < 7; i++) app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    const page = () => app.captureCharFrame().split("\n").slice(app.menu().y, app.menu().y + app.menu().height).join("\n");
    expect(page()).toContain("→ command-7"); expect(page()).toContain("(8/20+)");

    // 작은 창에서도 입력·정보·푸터를 덮지 않고 선택과 초안은 그대로 보존한다.
    app.resize(60, 11); await app.render();
    const footer = app.renderer.root.findDescendantById("app-footer")!;
    expect(page()).toContain("→ command-7"); expect(app.menu().y + app.menu().height).toBeLessThanOrEqual(footer.y);
    const height = app.menu().height;
    for (let i = 0; i < 6; i++) { await app.render(); expect(app.menu().height).toBe(height); }
    app.resize(120, 24); await app.render();
    expect(app.menu().height).toBe(6); expect(page()).toContain("(8/20+)");
    app.mockInput.pressTab(); await app.render();

    expect(app.input.value).toBe("/command-7 "); expect(app.menu().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("과거 대화를 읽는 중 목록 높이가 바뀌어도 첫 줄·스크롤·입력 포커스를 보존한다", async () => {
  // 큰 후보 목록의 확장·축소는 대화 뷰포트만 조정하고 사용자의 읽기 위치를 이동시키면 안 된다.
  const items = Array.from({ length: 20 }, (_, i) => ({ kind: "command" as const, value: `command-${i}`, description: "Command" }));
  const app = await mount(async (_id, query) => ok(filterCompletions(items, query.query)));
  try {
    await app.stream(Array.from({ length: 80 }, (_, i) => `HISTORY_${i}`).join("\n"));
    const scroll = app.renderer.root.findDescendantById("session-transcript");
    if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript viewport");
    scroll.scrollTo(12); await app.render();
    const first = () => app.captureCharFrame().split("\n").slice(scroll.viewport.y, scroll.viewport.y + scroll.viewport.height).join("\n").match(/HISTORY_\d+/u)?.[0];
    const before = first(), top = scroll.scrollTop;
    expect(before).toBeDefined(); expect(app.view.workViewPreferences.agentViews?.a1?.follow).toBe(false);

    // 넓은 목록에서 한 후보로 좁히고 닫아도 같은 기록을 계속 읽을 수 있다.
    await app.type("/");
    expect(app.menu().height).toBe(6); expect(first()).toBe(before); expect(scroll.scrollTop).toBe(top);
    app.input.value = "/command-19"; await app.complete();
    expect(app.menu().height).toBe(1); expect(first()).toBe(before); expect(scroll.scrollTop).toBe(top);
    app.mockInput.pressEscape(); await app.render();

    expect(first()).toBe(before); expect(scroll.scrollTop).toBe(top); expect(app.menu().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("빠른 입력은 마지막 변경 150ms 뒤 한 번만 조회하고 커서와 입력은 즉시 반영한다", async () => {
  const queries: string[] = [];
  const app = await mount(async (_id, query) => { queries.push(query.query); return ok({ items: fileItems, truncated: false }); });
  try {
    // Separate input turns must still share a trailing debounce window.
    app.mockInput.pressKey("@"); await app.render(); app.clock.advance(50);
    app.mockInput.pressKey("a"); await app.render(); app.clock.advance(50);
    app.mockInput.pressKey("b"); await app.render();
    expect(app.input.value).toBe("@ab"); expect(app.input.cursorOffset).toBe(3); expect(queries).toEqual([]);
    app.clock.advance(149); await app.render(); expect(queries).toEqual([]);
    app.clock.advance(1); await app.render(); expect(queries).toEqual(["ab"]); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("재조회 중 기존 후보의 높이·선택·푸터를 유지하고 이전 검색 결과는 확정하지 않는다", async () => {
  const pending: ReturnType<typeof Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>>[] = [];
  const items = Array.from({ length: 10 }, (_, index) => ({ kind: "file" as const, value: `abcdef-${index}.ts`, description: "File" }));
  const app = await mount(async () => { const gate = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>(); pending.push(gate); return gate.promise; });
  const geometry = () => [app.menu().height, app.renderer.root.findDescendantById("agent-composer")!.y,
    app.renderer.root.findDescendantById("session-transcript")!.height];
  const footer = () => app.captureCharFrame().split("\n")[app.renderer.height - 1]!;
  try {
    await app.type("@"); expect(app.menu().height).toBe(1);
    pending[0]!.resolve(ok({ items, truncated: false })); await app.render();
    expect(app.menu().height).toBeGreaterThan(1);
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    const filledGeometry = geometry(), filledFooter = footer();

    app.mockInput.pressKey("a"); await app.render();
    expect(app.captureCharFrame()).toContain("abcdef-1.ts"); expect(app.captureCharFrame()).toContain("Updating");
    expect(geometry()).toEqual(filledGeometry); expect(footer()).toBe(filledFooter);
    app.mockInput.pressTab(); await app.render();
    expect(app.input.value).toBe("@a"); expect(app.sent).toEqual([]);
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    app.clock.advance(150); await app.render(); pending[1]!.resolve(ok({ items, truncated: false })); await app.render();
    expect(geometry()).toEqual(filledGeometry); expect(footer()).toBe(filledFooter);
    app.mockInput.pressTab(); await app.render(); expect(app.input.value).toBe("[File #1] ");
    expect(app.input.submission.text).toBe(`@${JSON.stringify(resolve(app.selection.worktree!.path, "abcdef-2.ts"))} `);
  } finally { await app.close(); }
});

test.each(["escape", "blur", "session", "dispose", "renderer"] as const)("%s cancels debounce timers so delayed queries never start", async (action) => {
  let calls = 0; const app = await mount(async () => { calls++; return ok({ items: commandItems, truncated: false }); });
  try {
    app.mockInput.pressKey("/"); await app.render(); expect(calls).toBe(0);
    if (action === "escape") app.mockInput.pressEscape();
    if (action === "blur") openWorkspaceSearch(app);
    if (action === "session") app.selection.selectSession("demo:feature", "b1");
    if (action === "dispose") app.view.dispose();
    if (action === "renderer") app.renderer.destroy();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    app.clock.advance(1000);
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(calls).toBe(0); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("로딩 표시가 끝나도 후보의 열 위치와 높이를 바꾸지 않는다", async () => {
  // 빠른 조회의 스피너 꼬리는 후보를 지연하거나 별도 상태 행을 유지하지 않아야 한다.
  const app = await mount();
  try {
    await app.type("@");
    const position = () => [app.menu().height, app.captureCharFrame().split("\n")[app.menu().y]!.indexOf("src/main.ts")];
    const before = position();
    expect(before[1]).toBeGreaterThan(0); expect(app.menu().height).toBe(2);

    // 공유 로딩 표시의 최소 시간이 지나면 기존 후보의 제자리에서 표시만 사라진다.
    app.clock.advance(500); await app.render();

    expect(position()).toEqual(before); expect(app.captureCharFrame()).toContain("src/main.ts");
  } finally { await app.close(); }
});

test("빈 결과와 조회 오류도 열린 목록의 높이와 입력 위치를 바꾸지 않는다", async () => {
  let failure = false;
  const app = await mount(async () => failure ? err(new CapabilityError("Lookup failed")) : ok({ items: [], truncated: false }));
  try {
    app.mockInput.pressKey("/"); await app.render(); const geometry = [app.menu().height, app.input.y];
    app.clock.advance(150); await app.render(); expect(app.captureCharFrame()).toContain("No matches");
    expect([app.menu().height, app.input.y]).toEqual(geometry);
    failure = true; app.mockInput.pressKey("a"); await app.render(); app.clock.advance(150); await app.render();
    expect(app.captureCharFrame()).toContain("UNSUPPORTED_CAPABILITY");
    expect([app.menu().height, app.input.y]).toEqual(geometry); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("슬래시는 입력 맨 앞에서만 명령을 제안하고 이메일이 아닌 중간 @는 파일을 제안한다", async () => {
  // The real input and router stay active; only read-only discovery is replaced.
  const app = await mount();
  try {
    await app.type("text /mc"); expect(app.menu().visible).toBe(false);
    app.input.value = ""; await app.type("user@example.com"); expect(app.menu().visible).toBe(false);
    app.input.value = ""; await app.type("check @src/");
    expect(app.menu().visible).toBe(true); expect(app.captureCharFrame()).toContain("src/main.ts");
    expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test.each(["command", "template", "skill"] as const)("Enter 한 번으로 선택된 %s 후보를 완성하고 즉시 전송한다", async (kind) => {
  // The selected resource, not the incomplete token, is the intended command.
  const value = kind === "skill" ? "skill:compact-guide" : "compact";
  const app = await mount(async () => ok({ items: [{ kind, value, description: "Selected resource" }], truncated: false }));
  try {
    const trigger = kind === "skill" ? "$" : "/", name = value.replace(/^skill:/u, "");
    await app.type(`${trigger}com`); expect(app.captureCharFrame()).toContain(`→ ${name}`);

    app.mockInput.pressEnter(); await app.render();

    expect(app.sent).toEqual([`${trigger}${kind === "skill" ? name : value}`]); expect(app.input.value).toBe("");
    expect(app.menu().visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally { await app.close(); }
});

test("Enter는 첫 후보가 아닌 현재 선택 후보를 실행하고 명령 뒤 인수도 보존한다", async () => {
  const app = await mount(async () => ok({ items: ["compact", "compare"].map(value => ({ kind: "command" as const, value, description: value })), truncated: false }));
  try {
    app.input.value = "/com keep these instructions";
    app.input.cursorOffset = app.input.editBuffer.measureText("/com"); await app.complete();
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();

    app.mockInput.pressEnter(); await app.render();

    expect(app.sent).toEqual(["/compare keep these instructions"]); expect(app.input.value).toBe("");
  } finally { await app.close(); }
});

test("명령 재조회 중 Enter는 최신 결과를 기다리고 같은 선택 후보를 한 번만 전송한다", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
  const item = { kind: "command" as const, value: "compact", description: "Compact context" };
  const app = await mount(async (_id, query) => query.query === "com" ? pending.promise : ok({ items: [item], truncated: false }));
  try {
    await app.type("/co"); app.mockInput.pressKey("m"); await app.complete();

    app.mockInput.pressEnter(); app.mockInput.pressEnter(); await app.render();
    expect(app.sent).toEqual([]); expect(app.input.value).toBe("/com");
    pending.resolve(ok({ items: [item], truncated: false })); await app.render();

    expect(app.sent).toEqual(["/compact"]); expect(app.input.value).toBe("");
  } finally { pending.resolve(ok({ items: [item], truncated: false })); await app.close(); }
});

test.each(["edit", "dismiss", "session", "blur", "dispose", "changed-selection"] as const)("%s after Enter during command refresh prevents late execution", async (action) => {
  const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
  const item = { kind: "command" as const, value: "compact", description: "Compact context" };
  const app = await mount(async (_id, query) => query.query === "com" ? pending.promise : ok({ items: [item], truncated: false }));
  try {
    await app.type("/co"); app.mockInput.pressKey("m"); await app.complete();
    app.mockInput.pressEnter(); await app.render();

    if (action === "edit") app.mockInput.pressKey("x");
    if (action === "dismiss") app.mockInput.pressEscape();
    if (action === "session") app.selection.selectSession("demo:feature", "b1");
    if (action === "blur") openWorkspaceSearch(app);
    if (action === "dispose") app.view.dispose();
    pending.resolve(ok({ items: action === "changed-selection" ? [{ ...item, value: "compare" }] : [item], truncated: false }));
    await app.render();

    expect(app.sent).toEqual([]);
    expect(app.view.promptDrafts.a1).toBe(action === "edit" ? "/comx" : "/com");
  } finally { pending.resolve(ok({ items: [item], truncated: false })); await app.close(); }
});

test.each(["empty", "error"] as const)("명령 재조회가 %s로 끝나면 대기 중인 Enter가 미완성 명령을 대신 전송하지 않는다", async (outcome) => {
  const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>> | ReturnType<typeof err<CapabilityError>>>();
  const item = { kind: "command" as const, value: "compact", description: "Compact context" };
  const app = await mount(async (_id, query) => query.query === "com" ? pending.promise : ok({ items: [item], truncated: false }));
  try {
    await app.type("/co"); app.mockInput.pressKey("m"); await app.complete();
    app.mockInput.pressEnter(); await app.render();

    pending.resolve(outcome === "error" ? err(new CapabilityError("Lookup failed")) : ok({ items: [], truncated: false })); await app.render();

    expect(app.sent).toEqual([]); expect(app.input.value).toBe("/com"); expect(app.menu().visible).toBe(true);
    expect(app.captureCharFrame()).toContain(outcome === "error" ? "Lookup failed" : "No matches");
  } finally { pending.resolve(ok({ items: [], truncated: false })); await app.close(); }
});

test("선택 명령이 거절돼도 held Enter 반복은 재전송하지 않고 완성된 초안을 유지한다", async () => {
  const app = await mount(async () => ok({ items: [{ kind: "command", value: "compact", description: "Compact context" }], truncated: false }),
    () => err(new InputError("Command rejected")));
  const raw = (text: string) => { const key = parseKeypress(text, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid key fixture"); app.renderer.keyInput.processParsedKey(key); };
  try {
    await app.type("/com");

    raw("\u001b[13;1u"); await app.render(); raw("\u001b[13;1:2u"); await app.render(); raw("\u001b[13;1:3u"); await app.render();

    expect(app.sent).toEqual(["/compact"]); expect(app.input.value).toBe("/compact");
    expect(app.captureCharFrame()).toContain("Command rejected");
  } finally { await app.close(); }
});

test.each(["/", "$", "@"] as const)("%s 자동완성에서 방향키는 입력 커서 대신 후보를 이동한다", async trigger => {
  // 입력 포커스는 유지하면서 세 종류의 후보 목록 모두 기본 방향키를 지원한다.
  const kind = trigger === "/" ? "command" : trigger === "$" ? "skill" : "file";
  const items: CompletionItem[] = ["candidate-a", "candidate-b", "candidate-c"].map(value => ({ kind, value, description: "Candidate" }));
  const app = await mount(async () => ok({ items, truncated: false }));
  try {
    await app.type(trigger);
    const cursor = app.input.cursorOffset;

    // 두 칸 내려갔다 한 칸 올라가 이전과 다음 방향키를 모두 검증한다.
    app.mockInput.pressArrow("down"); app.mockInput.pressArrow("down"); app.mockInput.pressArrow("up"); await app.render();

    expect(app.captureCharFrame()).toContain("→ candidate-b");
    expect(app.input.value).toBe(trigger); expect(app.input.cursorOffset).toBe(cursor);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.sent).toEqual([]);
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).not.toContain("<C-n> Next");
    app.mockInput.pressTab(); await app.render();

    expect(app.input.value).toBe(trigger === "@" ? "[File #1] " : `${trigger}candidate-b `);
    expect(app.menu().visible).toBe(false); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("자동완성을 닫으면 방향키와 hjkl은 다시 원래 입력 편집에 사용한다", async () => {
  // 여러 줄 입력에서 메뉴를 닫은 뒤에는 방향키를 후보 탐색용으로 계속 소비하면 안 된다.
  const app = await mount();
  try {
    await app.mockInput.pasteBracketedText("first line\n@"); await app.complete();
    expect(app.menu().visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();
    const cursor = app.input.cursorOffset;

    // Esc 후 같은 입력창에서 커서를 위로 옮기고 Vim 문자를 실제 텍스트로 입력한다.
    app.mockInput.pressArrow("up"); await app.render();
    expect(app.input.cursorOffset).toBeLessThan(cursor);
    await app.mockInput.typeText("hjkl"); await app.render();

    expect(app.input.value).toContain("hjkl"); expect(app.menu().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Ctrl+N/P로 후보를 고르고 Tab은 자동완성만 하며 Enter는 선택한 명령을 즉시 전송한다", async () => {
  const app = await mount();
  try {
    await app.type("/");
    expect(app.captureCharFrame()).not.toContain("<C-n> Next");
    expect(app.captureCharFrame()).toContain("<Tab> Insert");
    expect(app.captureCharFrame()).not.toContain("<CR> Queue");
    expect(app.captureCharFrame()).not.toContain("<Tab>/<CR>");
    app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    app.mockInput.pressKey("p", { ctrl: true }); await app.render();
    app.mockInput.pressTab(); await app.render();

    expect(app.input.value).toBe("/mcp "); expect(app.menu().visible).toBe(false); expect(app.sent).toEqual([]);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    app.mockInput.pressEnter(); await app.render(); expect(app.sent).toEqual(["/mcp "]);

    // A fully typed command must not need a second Enter or acquire a completion's trailing space.
    await app.type("/memory");
    expect(app.menu().visible).toBe(true);
    app.mockInput.pressEnter(); await app.render();
    expect(app.input.value).toBe(""); expect(app.sent).toEqual(["/mcp ", "/memory"]);
    expect(app.menu().visible).toBe(false);
  } finally { await app.close(); }
});

test("kitty Tab을 누르고 있어도 후보 삽입 뒤 반복 입력이 포커스 이동으로 바뀌지 않는다", async () => {
  const app = await mount();
  const raw = (text: string) => { const key = parseKeypress(text, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid key fixture"); app.renderer.keyInput.processParsedKey(key); };
  try {
    await app.type("/"); raw("\u001b[9;1u"); raw("\u001b[9;1:2u"); await app.render();
    expect(app.input.value).toBe("/mcp "); expect(app.sent).toEqual([]);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    raw("\u001b[9;1:3u"); app.mockInput.pressEnter(); await app.render();
    expect(app.sent).toEqual(["/mcp "]);
  } finally { await app.close(); }
});

test("kitty Enter의 반복 입력도 선택 명령을 중복 전송하지 않는다", async () => {
  const app = await mount();
  const raw = (text: string) => { const key = parseKeypress(text, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid key fixture"); app.renderer.keyInput.processParsedKey(key); };
  try {
    // Key repeat can arrive before admission or after the accepted draft has been cleared.
    await app.type("/mcp"); raw("\u001b[13;1u"); raw("\u001b[13;1:2u"); await app.render();
    raw("\u001b[13;1:2u"); raw("\u001b[13;1:3u"); await app.render();

    expect(app.sent).toEqual(["/mcp"]); expect(app.input.value).toBe("");
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id);
  } finally { await app.close(); }
});

test.each([["/mc", "/mcp"], ["@src/", "@src/"]])("Enter는 명령 후보 %s만 완성하며 파일 후보는 자동 삽입하지 않는다", async (draft, submitted) => {
  const app = await mount();
  try {
    // Command execution uses the focused slash resource; file attachment remains a Tab action.
    await app.type(draft); app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    expect(app.menu().visible).toBe(true);
    app.mockInput.pressEnter(); await app.render();

    expect(app.sent).toEqual([submitted]); expect(app.input.value).toBe("");
    expect(app.menu().visible).toBe(false);
  } finally { await app.close(); }
});

test("트리거와 Enter가 같은 입력 묶음에 도착해도 후보가 아닌 실제 입력만 즉시 전송한다", async () => {
  const app = await mount();
  try {
    // Submission is independent of the completion debounce and its queued render.
    app.mockInput.pressKey("/"); app.mockInput.pressEnter(); await app.render();

    expect(app.sent).toEqual(["/"]); expect(app.input.value).toBe("");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.menu().visible).toBe(false);
  } finally { await app.close(); }
});

test.each(["/", "@"])("트리거 %s와 Tab이 같은 입력 묶음에 도착하면 전송하거나 포커스를 옮기지 않는다", async (trigger) => {
  const app = await mount();
  try {
    // Tab waits for fresh candidates instead of sending a partially typed command or reference.
    app.mockInput.pressKey(trigger); app.mockInput.pressTab(); await app.render();

    expect(app.sent).toEqual([]); expect(app.input.value).toBe(trigger);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.menu().visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();
    expect(app.menu().visible).toBe(false); expect(app.input.value).toBe(trigger);
  } finally { await app.close(); }
});

test.each(["pending", "empty", "error"] as const)("후보 조회가 %s 상태여도 Enter는 입력한 명령을 한 번만 전송한다", async (state) => {
  const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
  const app = await mount(async () => state === "pending" ? pending.promise
    : state === "error" ? err(new CapabilityError("Lookup unavailable")) : ok({ items: [], truncated: false }));
  try {
    // Read-only discovery must not gate execution, even when it fails or has no matches.
    await app.type("/mcp"); expect(app.menu().visible).toBe(true);
    if (state === "empty") expect(app.captureCharFrame()).toContain("No matches");
    if (state === "error") expect(app.captureCharFrame()).toContain("UNSUPPORTED_CAPABILITY");
    app.mockInput.pressEnter(); app.mockInput.pressEnter(); await app.render();

    expect(app.sent).toEqual(["/mcp"]); expect(app.input.value).toBe("");
    expect(app.menu().visible).toBe(false); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally { pending.resolve(ok({ items: commandItems, truncated: false })); await app.close(); }
});

test("Esc는 후보 목록만 닫고 hjkl은 입력 문자로 남으며 기존 초안을 전송하지 않는다", async () => {
  const app = await mount();
  try {
    await app.type("/"); app.mockInput.pressEscape(); await app.render();
    expect(app.input.value).toBe("/"); expect(app.menu().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);

    await app.type("hjkl");
    expect(app.input.value).toBe("/hjkl"); expect(app.view.promptDrafts.a1).toBe("/hjkl");
    expect(app.sent).toEqual([]);
    app.mockInput.pressEscape(); await app.render(); app.mockInput.pressEscape(); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally { await app.close(); }
});

test("한글·이모지 뒤의 토큰 중간에서도 전체 경로만 바꾸고 뒤의 요청과 native 커서를 보존한다", async () => {
  const app = await mount();
  try {
    const text = "한글 👩‍💻 @src/old.ts 뒤의 요청";
    // Bracketed paste sends intact Unicode; the test helper's typeText splits UTF-16 surrogate pairs.
    await app.mockInput.pasteBracketedText(text); await app.render(); expect(app.input.value).toBe(text);
    app.input.cursorOffset = app.input.editBuffer.measureText(text.slice(0, text.indexOf("old"))); await app.complete();
    app.mockInput.pressKey("n", { ctrl: true }); await app.render(); app.mockInput.pressTab(); await app.render();

    const prefix = "한글 👩‍💻 [File #1]";
    expect(app.input.value).toBe(prefix + " 뒤의 요청");
    expect(app.input.cursorOffset).toBe(app.input.editBuffer.measureText(prefix));
    expect(app.view.promptDrafts.a1).toBe(`한글 👩‍💻 @${JSON.stringify(resolve(app.selection.worktree!.path, "src/문서 file.ts"))} 뒤의 요청`);
    expect(app.input.draft.tokens).toHaveLength(1); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("조회 중 Tab은 전송하지 않고 실패를 빈 목록으로 숨기지 않으며 초안과 포커스를 유지한다", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof err<CapabilityError>>>();
  const app = await mount(async () => pending.promise);
  try {
    await app.type("/"); app.mockInput.pressTab(); await app.render();
    expect(app.sent).toEqual([]); expect(app.input.value).toBe("/");
    pending.resolve(err(new CapabilityError("Service needs an explicit upgrade"))); await app.render();
    expect(app.captureCharFrame()).toContain("UNSUPPORTED_CAPABILITY"); expect(app.menu().visible).toBe(true);
    expect(app.input.value).toBe("/"); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    app.mockInput.pressEscape(); await app.render(); expect(app.menu().visible).toBe(false);
  } finally { await app.close(); }
});

test("다른 세션으로 이동한 뒤 도착한 이전 후보는 무시하고 각 세션 초안을 보존한다", async () => {
  const pending: { id: string; signal: AbortSignal; gate: ReturnType<typeof Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>> }[] = [];
  const app = await mount(async (id, _query, signal) => {
    const gate = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>(); pending.push({ id, signal, gate }); return gate.promise;
  });
  try {
    await app.type("/");
    const other = app.selection.snapshot.flatMap((repo) => repo.worktrees).flatMap((tree) => tree.sessions.map((session) => ({ tree, session }))).find(({ session }) => session.id !== "a1")!;
    app.selection.selectSession(other.tree.id, other.session.id); await app.render(); await app.type("@");
    expect(pending[0]?.signal.aborted).toBe(true);
    pending.at(-1)!.gate.resolve(ok({ items: fileItems, truncated: false })); await app.render();
    pending[0]!.gate.resolve(ok({ items: [{ kind: "command", value: "stale-command", description: "" }], truncated: false })); await app.render();

    expect(app.captureCharFrame()).toContain("src/main.ts"); expect(app.captureCharFrame()).not.toContain("stale-command");
    expect(app.view.promptDrafts.a1).toBe("/"); expect(app.view.promptDrafts[other.session.id]).toBe("@"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("renderer가 먼저 종료되면 진행 중 후보 조회를 취소하고 늦은 응답은 native 버퍼를 접근하지 않는다", async () => {
  const gate = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>(); let signal: AbortSignal | undefined;
  const app = await mount(async (_id, _query, abort) => { signal = abort; return gate.promise; });
  try {
    await app.type("/"); app.renderer.destroy();
    gate.resolve(ok({ items: commandItems, truncated: false }));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(signal?.aborted).toBe(true); expect(app.sent).toEqual([]);
    app.view.dispose();
  } finally { await app.close(); }
});

test("스트리밍과 좁은 화면에서도 후보는 입력창 아래와 푸터 사이에 있고 선택을 유지한다", async () => {
  let queries = 0;
  const app = await mount(async (_id, query) => { queries++; return ok(filterCompletions(commandItems, query.query)); });
  try {
    await app.type("/"); app.mockInput.pressKey("n", { ctrl: true }); await app.render();
    const before = queries; await app.stream("Streaming more output");
    app.resize(60, 12); await app.render();
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const footer = app.renderer.root.findDescendantById("footer-bar")!;
    expect(app.menu().y).toBeGreaterThanOrEqual(composer.y + composer.height);
    expect(app.menu().y + app.menu().height).toBeLessThanOrEqual(footer.y);
    expect(queries).toBe(before); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    app.mockInput.pressTab(); await app.render();
    expect(app.input.value).toBe("/memory "); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});
