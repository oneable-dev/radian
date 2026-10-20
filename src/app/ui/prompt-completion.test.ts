import { expect, test } from "bun:test";
import { parseKeypress } from "@opentui/core";
import { resolve } from "node:path";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { filterCompletions, type CompletionResult } from "../../agents/completion.ts";
import type { CompletionProvider } from "../../agents/ui/completion-menu.ts";
import { CapabilityError, InputError } from "../../errors.ts";
import { err, ok } from "../../result.ts";

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
  await render(); app.mockInput.pressKey("e", { ctrl: true }); await render();
  const input = app.renderer.root.findDescendantById("session-prompt") as PromptInput;
  const complete = async () => { await render(); clock.advance(150); await render(); };
  return { ...app, clock, selection, view, input, sent, render, complete,
    menu: () => app.renderer.root.findDescendantById("prompt-completions")!,
    async type(text: string) { await app.mockInput.typeText(text); await complete(); },
    async stream(text: string) { output = text; selection.replaceSnapshot(selection.snapshot); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

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

test("재조회 중 후보와 선택·높이·푸터를 유지하고 이전 검색 결과는 확정하지 않는다", async () => {
  const pending: ReturnType<typeof Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>>[] = [];
  const items = Array.from({ length: 10 }, (_, index) => ({ kind: "file" as const, value: `abcdef-${index}.ts`, description: "File" }));
  const app = await mount(async () => { const gate = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>(); pending.push(gate); return gate.promise; });
  const geometry = () => [app.menu().height, app.renderer.root.findDescendantById("agent-composer")!.y,
    app.renderer.root.findDescendantById("session-transcript")!.height];
  const footer = () => app.captureCharFrame().split("\n")[app.renderer.height - 1]!;
  try {
    await app.type("@"); const initialGeometry = geometry();
    pending[0]!.resolve(ok({ items, truncated: false })); await app.render();
    expect(geometry()).toEqual(initialGeometry);
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

test.each(["escape", "blur", "session", "dispose", "renderer"] as const)("%s는 debounce 대기 타이머를 취소해 늦은 조회를 시작하지 않는다", async (action) => {
  let calls = 0; const app = await mount(async () => { calls++; return ok({ items: commandItems, truncated: false }); });
  try {
    app.mockInput.pressKey("/"); await app.render(); expect(calls).toBe(0);
    if (action === "escape") app.mockInput.pressEscape();
    if (action === "blur") app.mockInput.pressKey("f", { ctrl: true });
    if (action === "session") app.selection.selectSession("demo:feature", "b1");
    if (action === "dispose") app.view.dispose();
    if (action === "renderer") app.renderer.destroy();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    app.clock.advance(1000);
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(calls).toBe(0); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("로딩 표시가 끝나도 헤더 글자와 후보의 가로 위치를 바꾸지 않는다", async () => {
  const app = await mount();
  try {
    await app.type("@");
    const headerX = () => app.captureCharFrame().split("\n")[app.menu().y]!.indexOf("Files");
    const x = headerX(); expect(x).toBeGreaterThan(0);
    app.clock.advance(500); await app.render();
    expect(headerX()).toBe(x); expect(app.captureCharFrame()).toContain("src/main.ts");
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
    await app.type("/com"); expect(app.captureCharFrame()).toContain(`/${value}`);

    app.mockInput.pressEnter(); await app.render();

    expect(app.sent).toEqual([`/${value}`]); expect(app.input.value).toBe("");
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

test.each(["edit", "dismiss", "session", "blur", "dispose", "changed-selection"] as const)("명령 재조회 중 Enter 이후 %s이면 늦은 결과로 명령을 실행하지 않는다", async (action) => {
  const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
  const item = { kind: "command" as const, value: "compact", description: "Compact context" };
  const app = await mount(async (_id, query) => query.query === "com" ? pending.promise : ok({ items: [item], truncated: false }));
  try {
    await app.type("/co"); app.mockInput.pressKey("m"); await app.complete();
    app.mockInput.pressEnter(); await app.render();

    if (action === "edit") app.mockInput.pressKey("x");
    if (action === "dismiss") app.mockInput.pressEscape();
    if (action === "session") app.selection.selectSession("demo:feature", "b1");
    if (action === "blur") app.mockInput.pressKey("f", { ctrl: true });
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

test("Ctrl+N/P로 후보를 고르고 Tab은 자동완성만 하며 Enter는 선택한 명령을 즉시 전송한다", async () => {
  const app = await mount();
  try {
    await app.type("/");
    expect(app.captureCharFrame()).toContain("Ctrl+n Next");
    expect(app.captureCharFrame()).toContain("Tab Insert");
    expect(app.captureCharFrame()).toContain("Enter Queue");
    expect(app.captureCharFrame()).not.toContain("Tab/Enter");
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
