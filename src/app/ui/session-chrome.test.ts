import { expect, test } from "bun:test";
import type { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import { icons } from "../../icons.ts";
import { parseKeymap, type Keymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";

async function mount(empty = false, keymap?: Keymap) {
  const app = await createTestRenderer({ width: 160, height: 28, kittyKeyboard: true });
  const repositories = demoWorkspace().map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree, sessions: empty ? [] : tree.sessions })) }));
  const selection = new WorkspaceSelection(repositories), created: string[] = [], lookups: string[] = [], sent: string[] = [];
  const view = new Workbench(app.renderer, selection, { ...(keymap ? { keymap } : {}), onNewSession: (id) => created.push(id), onCloseSession: (treeId, id) => {
    selection.replaceSnapshot(selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== treeId ? tree : { ...tree, sessions: tree.sessions.filter((session) => session.id !== id) }) })));
  }, onPrompt: (_id, text) => { sent.push(text); return ok(undefined); }, initialDrafts: { a1: "preserved prompt" },
    onListHistory: async (id) => { lookups.push(id); return ok([]); },
    getSessionDetails: () => ({ status: "complete", output: "Existing conversation", error: null, telemetry: { provider: "openai-codex", model: "gpt-5.5", effort: "high", fast: false, context: { usedTokens: 72000, maxTokens: 200000 }, weekly: null,
      usage: { provider: "openai", status: "ready", windows: [{ id: "period", usedPercent: 18, resetsAt: Date.now() + 3600000, periodMs: 604800000 }], updatedAt: Date.now(), errorCode: null } } }) });
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  const render = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await app.renderOnce(); await app.renderOnce(); };
  const line = (id: string) => { const node = get(id); return app.captureCharFrame().split("\n")[node.y]!.slice(node.x, node.x + node.width); };
  const history = async () => { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("h"); await render(); };
  await render();
  return { ...app, selection, view, created, lookups, sent, get, render, line, history, async close() { view.dispose(); await app.dispose(); } };
}

test("상단 오른쪽의 워크트리·생성·History 버튼은 없고 선택한 워크트리와 브랜치는 프롬프트 아래에 표시한다", async () => {
  const app = await mount();
  try {
    expect(app.renderer.root.findDescendantById("work-view-tabs")).toBeUndefined();
    expect(app.line("agent-session-tabs")).not.toContain("New session"); expect(app.line("agent-session-tabs")).not.toContain("History");
    expect(app.renderer.root.findDescendantById("agent-history-button")).toBeUndefined();
    expect(app.line("session-worktree-context")).toBe(`[ ${icons.folder} radian · ${icons.branch} main ]`);
    const scope = app.get("session-worktree-context"), status = app.get("session-status"), composer = app.get("agent-composer");
    expect(scope.y).toBe(status.y + 1); expect(status.y).toBe(composer.y + composer.height); expect(status.height).toBe(3);
    expect(app.created).toEqual([]); expect(app.lookups).toEqual([]); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("탐색 커서가 아니라 활성 워크트리를 표시하고 실제 전환·브랜치 갱신·detached 상태를 반영한다", async () => {
  const app = await mount();
  try {
    app.mockInput.pressKey("f", { ctrl: true }); app.mockInput.pressTab();
    app.mockInput.pressKey("j"); await app.render(); expect(app.line("session-worktree-context")).toBe(`[ ${icons.folder} radian · ${icons.branch} main ]`);
    app.mockInput.pressEnter(); await app.render(); expect(app.line("session-worktree-context")).toContain("radian-ui");
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== "demo:feature" ? tree : { ...tree, branch: "fix/status" }) })));
    await app.render(); expect(app.line("session-worktree-context")).toBe(`[ ${icons.folder} radian-ui · ${icons.branch} fix/status ]`);
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== "demo:feature" ? tree : { ...tree, branch: null }) })));
    await app.render(); expect(app.line("session-worktree-context")).toContain("detached");
    expect(app.view.promptDrafts.a1).toBe("preserved prompt"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("버튼 없이도 세션 목록의 생성 명령과 전역 History 단축키를 사용할 수 있다", async () => {
  const app = await mount();
  try {
    app.get("agent-session-list").focus();
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("n"); await app.render();
    expect(app.created).toEqual(["demo:main"]);
    app.mockInput.pressKey("e", { ctrl: true }); await app.render(); const prompt = app.get("session-prompt");
    await app.history(); expect(app.get("session-history").visible).toBe(true); expect(app.lookups).toEqual(["demo:main"]);
    app.mockInput.pressEscape(); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(prompt); expect(app.view.promptDrafts.a1).toBe("preserved prompt"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("빈 워크트리에서도 Tab으로 빈 세션 목록에 도달해 명시적으로 생성한다", async () => {
  const app = await mount(true);
  try {
    const list = app.get("agent-session-list");
    for (let i = 0; i < 14 && app.renderer.currentFocusedRenderable !== list; i++) { app.mockInput.pressTab(); await app.render(); }
    expect(list.visible).toBe(true); expect(app.renderer.currentFocusedRenderable).toBe(list); expect(app.created).toEqual([]);
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("n"); await app.render(); expect(app.created).toEqual(["demo:main"]);
    await app.history(); expect(app.get("session-history").visible).toBe(true); expect(app.lookups).toEqual(["demo:main"]);
  } finally { await app.close(); }
});

test("마지막 세션을 닫은 뒤에도 목록 포커스와 새 세션 생성 명령은 유지한다", async () => {
  const app = await mount();
  try {
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== "demo:main" ? tree : { ...tree, sessions: tree.sessions.slice(0, 1) }) })));
    await app.render(); const list = app.get("agent-session-list"); list.focus();
    app.mockInput.pressKey("x"); await app.render();
    expect(app.selection.worktree!.sessions).toHaveLength(0); expect(app.renderer.currentFocusedRenderable).toBe(list); expect(list.visible).toBe(true);
    expect(app.created).toEqual([]);
    expect(app.captureCharFrame()).toContain("No AI sessions");
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("n"); await app.render(); expect(app.created).toEqual(["demo:main"]);
  } finally { await app.close(); }
});

test.each(["default", "custom", "disabled"] as const)("빈 AI 화면은 %s 생성 키만 안내하고 설정된 leader 시퀀스로 생성한다", async mode => {
  // 빈 목록도 실제 키맵을 안내하며 기본 키나 세션을 임의로 만들어서는 안 된다.
  const keymap = expectOk(parseKeymap(mode === "custom" ? { leader: "ctrl+b" } : mode === "disabled" ? { bindings: { "tab.new": [] } } : {}));
  const app = await mount(true, keymap);
  try {
    const hint = app.get("agent-empty-state:hint");

    // 빈 화면의 탐색 키와 이전 생성 별칭은 새 세션을 만들지 않는다.
    app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("n"); await app.render();

    // 안내는 키 재설정·비활성화를 반영하고 생성 요청 전까지 빈 상태를 유지한다.
    expect(app.captureCharFrame()).toContain("No AI sessions"); expect(app.created).toEqual([]);
    if (mode === "disabled") expect(hint.visible).toBe(false);
    else {
      expect(app.line("agent-empty-state:hint")).toContain(mode === "custom" ? "Ctrl+b → n" : "Ctrl+Space → n");
      app.mockInput.pressKey(mode === "custom" ? "b" : " ", { ctrl: true }); app.mockInput.pressKey("n"); await app.render();
      expect(app.created).toEqual(["demo:main"]);
    }
  } finally { await app.close(); }
});

test("긴 한글·emoji 워크트리와 브랜치는 원문을 바꾸지 않고 같은 상태 한 줄에서 축약한다", async () => {
  const app = await mount();
  try {
    const name = "한글 👨‍👩‍👧‍👦 é very-long-worktree-name", branch = "feature/한글-👩🏽‍💻-very-long-branch";
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== "demo:main" ? tree : { ...tree, name, branch }) })));
    app.resize(100, 24); await app.render();
    const scope = app.get("session-worktree-context") as TextRenderable, text = scope.plainText;
    expect(scope.height).toBe(1); expect(Bun.stringWidth(text)).toBeLessThanOrEqual(scope.width); expect(text).toContain("…"); expect(text).not.toContain("\uFFFD");
    expect(text.startsWith(`[ ${icons.folder} `)).toBe(true); expect(text.endsWith(" ]")).toBe(true); expect(text).toContain(` · ${icons.branch} `);
    expect(app.selection.worktree?.name).toBe(name); expect(app.selection.worktree?.branch).toBe(branch);
    expect(app.view.promptDrafts.a1).toBe("preserved prompt"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("작은 화면의 범위 표시는 모델·미터와 겹치지 않고 수동 초안·입력 포커스 및 상태 여백을 유지한다", async () => {
  const app = await mount();
  try {
    app.mockInput.pressKey("e", { ctrl: true }); await app.render(); const prompt = app.get("session-prompt") as PromptInput;
    for (const width of [160, 100, 60, 160]) {
      app.resize(width, 24); await app.render();
      const scope = app.get("session-worktree-context"), status = app.get("session-status"), row = app.get("session-status-line");
      expect(scope.visible).toBe(true); expect(scope.x + scope.width).toBeLessThanOrEqual(status.x + status.width);
      const text = (scope as TextRenderable).plainText;
      expect(text.startsWith(`[ ${icons.folder} `)).toBe(true); expect(text.endsWith(" ]")).toBe(true); expect(text).toContain(` · ${icons.branch} `);
      expect(scope.y).toBe(row.y); expect(app.line("session-status-line")).toContain("64%"); expect(app.line("session-status-line")).toContain("18% used");
      expect(status.height).toBe(3); expect(status.y + status.height).toBeLessThanOrEqual(app.get("app-footer").y);
      expect(app.renderer.currentFocusedRenderable).toBe(prompt); expect(prompt.value).toBe("preserved prompt");
    }
    expect(app.line("session-worktree-context")).toBe(`[ ${icons.folder} radian · ${icons.branch} main ]`); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});
