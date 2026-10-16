import { expect, test } from "bun:test";
import { CodeRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer, MockTreeSitterClient } from "@opentui/core/testing";
import { WorkspaceView } from "./workspace.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import type { GitActions } from "./git.ts";
import type { GitCommit, GitComparison, GitSnapshot, GitSource } from "../git/model.ts";
import type { WorkViewPreferences } from "../runtime/protocol.ts";
import { ClipboardError, InputError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const commit: GitCommit = { oid: "a".repeat(40), parents: ["b".repeat(40)], subject: "Update login", author: "Ada", date: "2026-10-15" };
const rootCommit: GitCommit = { ...commit, oid: "b".repeat(40), parents: [], subject: "Initial login" };
const snapshot = (): GitSnapshot => ({ head: "main", headOid: commit.oid, commits: [commit, rootCommit],
  refs: [{ kind: "local", name: "main", ref: "refs/heads/main", oid: commit.oid },
    { kind: "remote", name: "origin/main", ref: "refs/remotes/origin/main", oid: rootCommit.oid },
    { kind: "tag", name: "v1", ref: "refs/tags/v1", oid: rootCommit.oid }],
  files: [{ kind: "unstaged", status: "M", path: "src/login.ts" }, { kind: "untracked", status: "?", path: "notes.txt" }],
  reflog: [{ oid: commit.oid, selector: "HEAD@{0}", subject: "commit: Update login", date: "2026-10-15" }],
});
const comparison = (): GitComparison => {
  const before = Array.from({ length: 70 }, (_, i) => `const line${String(i).padStart(2, "0")} = ${i};`).join("\n") + "\n";
  return { before, after: before.replace("line30 = 30", "line30 = 300"), beforeLabel: "HEAD:src/login.ts", afterLabel: "worktree:src/login.ts" };
};

async function mount(options: { actions?: Partial<GitActions>; initial?: WorkViewPreferences; source?: GitSource } = {}) {
  const app = await createTestRenderer({ width: 160, height: 32, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const copies: string[] = [], requests: { id: string; text: string }[] = [], loads: string[] = [], creations: string[] = [];
  const highlighter = new MockTreeSitterClient({ autoResolveTimeout: 0 });
  const source: GitSource = options.source ?? {
    load: async (ref) => { loads.push(ref ?? "all"); return ok(snapshot()); },
    details: async (selected) => ok({ commit: selected, message: `${selected.subject}\n\nFull explanation of the change.\n`,
      files: [{ kind: "commit", status: "M", path: "src/login.ts", commit: selected }, { kind: "commit", status: "M", path: "src/other.ts", commit: selected }] }),
    compare: async () => ok(comparison()),
  };
  const git: GitActions = {
    source: () => source, treeSitterClient: highlighter,
    createSession: async (id) => { creations.push(id); return ok("new-session"); },
    prompt: (id, text) => { requests.push({ id, text }); return ok(undefined); },
    copy: async (text) => { copies.push(text); return ok("Copied to clipboard"); }, ...options.actions,
  };
  const view = new WorkspaceView(app.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, onPrompt: git.prompt, git,
    initialWorkViews: options.initial ?? { active: {}, agentScroll: {} }, initialDrafts: { a1: "existing Agent draft" },
    getSessionDetails: () => ({ status: "working", output: "Existing agent run", error: null }),
  });
  const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)];
  const get = (id: string) => { const result = walk(app.renderer.root).find((node) => node.id === id); if (!result) throw new Error(`Missing ${id}`); return result; };
  await app.renderOnce();
  const click = async (text: string) => {
    const lines = app.captureCharFrame().split("\n"); const y = lines.findIndex((line) => line.includes(text)), x = lines[y]?.indexOf(text) ?? -1;
    if (x < 0) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
    await app.mockMouse.click(x + Math.min(1, text.length - 1), y); await app.renderOnce();
  };
  if (!options.initial?.active["demo:main"]) await click("Git");
  await app.waitForFrame((frame) => frame.includes("Working tree") || frame.includes("Before / After") || frame.includes("HEAD@{"));
  return { ...app, view, selection, copies, requests, loads, creations, get, click,
    async clickIn(id: string, text: string) {
      const region = get(id), lines = app.captureCharFrame().split("\n");
      for (let y = region.y; y < region.y + region.height; y++) {
        const x = lines[y]?.slice(region.x, region.x + region.width).indexOf(text) ?? -1;
        if (x >= 0) { await app.mockMouse.click(region.x + x + 1, y); await app.renderOnce(); return; }
      }
      throw new Error(`Missing ${text} in ${id}`);
    },
    codes: () => walk(get("git-diff")).filter((node): node is CodeRenderable => node instanceof CodeRenderable),
    async chooseCommit() { await click("Update login"); await app.waitForFrame((frame) => frame.includes("Author: Ada")); },
    async ask(text: string) { app.mockInput.pressKey("a"); await app.renderOnce(); await app.mockInput.typeText(text); app.mockInput.pressEnter(); await app.waitFor(() => requests.length > 0); await app.renderOnce(); },
    async close() { view.dispose(); await app.dispose(); await highlighter.destroy(); },
  };
}

test("Git은 Commits/Reflog와 오른쪽 Commit/Refs를 표시하고 Reflog에서는 오른쪽을 숨긴다", async () => {
  // No model, OS clipboard, or actual repository mutation is needed for layout interaction.
  const app = await mount();
  try {
    expect(app.captureCharFrame()).toContain("Commits Reflog"); expect(app.captureCharFrame()).toContain("Commit Refs");
    expect(app.captureCharFrame()).toContain("UNSTAGED"); expect(app.captureCharFrame()).toContain("UNTRACKED");
    expect(app.captureCharFrame()).not.toContain("Submodules"); expect(app.get("git-right").visible).toBe(true);

    await app.click("Reflog");

    expect(app.get("git-right").visible).toBe(false);
    expect(app.captureCharFrame()).toContain("HEAD@{0}"); expect(app.captureCharFrame()).not.toContain("Changed files");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("커밋 목록의 a는 해시만 보내고 y는 잘리지 않은 해시를 복사한다", async () => {
  // The graph row contains a subject and labels that must not leak into its context.
  const app = await mount();
  try {
    await app.chooseCommit();
    app.mockInput.pressKey("y"); await app.waitFor(() => app.copies.length === 1);

    await app.ask("review ay");

    expect(app.copies).toEqual([commit.oid]);
    expect(app.requests[0]).toEqual({ id: "a1", text: `review ay\n\nGit context (quoted data):\n${JSON.stringify(commit.oid)}` });
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
  } finally { await app.close(); }
});

test("Commit details에서 a는 전체 상세를 보내며 화면에 안 보이는 메시지도 포함한다", async () => {
  // A short detail viewport must not truncate what gets attached.
  const app = await mount();
  try {
    await app.chooseCommit(); await app.click("Author: Ada");

    await app.ask("explain");

    expect(app.requests[0]!.text).toContain("Author: Ada");
    expect(app.requests[0]!.text).toContain("Full explanation of the change.");
    expect(app.requests[0]!.text).not.toContain("const line");
  } finally { await app.close(); }
});

test("Refs의 Local/Remote/Tags는 이름만 첨부·복사하고 Enter는 조회 필터만 바꾼다", async () => {
  // Reference selection never changes the working branch or includes a tip hash.
  const app = await mount();
  try {
    await app.click("Refs"); await app.click("Remote"); await app.clickIn("git-refs", "origin/main");
    await app.waitFor(() => app.loads.includes("refs/remotes/origin/main"));
    app.mockInput.pressKey("y"); await app.waitFor(() => app.copies.length > 0);

    await app.ask("compare this branch");

    expect(app.copies[0]).toBe("origin/main");
    expect(app.requests[0]!.text).toContain(JSON.stringify("origin/main"));
    expect(app.requests[0]!.text).not.toContain(rootCommit.oid);
    await app.click("Tags"); await app.clickIn("git-refs", "v1"); app.mockInput.pressKey("y"); await app.waitFor(() => app.copies.length === 2);
    expect(app.copies[1]).toBe("v1");
  } finally { await app.close(); }
});

test("파일 선택은 중앙만 전체 파일 diff로 바꾸고 양쪽을 하나의 포커스로 스크롤한다", async () => {
  // The comparison has unchanged content far outside the modified middle line.
  const app = await mount();
  try {
    await app.click("M src/login.ts");
    await app.waitForFrame((frame) => frame.includes("const line00"));
    expect(app.get("git-right").visible).toBe(true); expect(app.captureCharFrame()).toContain("Changed files");
    app.get("git-diff").focus();

    app.mockInput.pressArrow("down"); await app.renderOnce();
    const codes = app.codes();
    expect(codes).toHaveLength(2); expect(codes[0]!.scrollY).toBeGreaterThan(0); expect(codes[0]!.scrollY).toBe(codes[1]!.scrollY);
    app.mockInput.pressKey("END"); await app.renderOnce();
    expect(app.captureCharFrame()).toContain("const line69");
    app.mockInput.pressKey("y"); await app.waitFor(() => app.copies.length > 0);
    expect(app.copies).toEqual(["src/login.ts"]);
    await app.ask("review file"); expect(app.requests[0]!.text).toContain("File: src/login.ts"); expect(app.requests[0]!.text).not.toContain("const line");

    app.mockInput.pressEscape(); await app.renderOnce();
    expect(app.get("git-history").visible).toBe(true);
  } finally { await app.close(); }
});

test("코드 드래그는 줄 번호 없이 한쪽만 자동 복사하고 Agent 요청을 만들지 않는다", async () => {
  // Both code panes are native renderables; only the final clipboard boundary is stubbed.
  const app = await mount();
  try {
    await app.click("M src/login.ts"); await app.waitForFrame((frame) => frame.includes("const line00"));
    const codes = app.codes().sort((a, b) => a.x - b.x), left = codes[0]!;

    await app.mockMouse.drag(left.x, left.y, left.x + 4, left.y); await app.waitFor(() => app.copies.length > 0);

    expect(app.copies[0]).toBe("const"); expect(app.requests).toEqual([]);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-diff");
    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
  } finally { await app.close(); }
});

test("Git 상태는 worktree 왕복과 새 UI 복원 뒤에도 선택·diff·스크롤을 유지한다", async () => {
  // Only view identities and positions are persisted, not file content or pending requests.
  const app = await mount(); let retained: WorkViewPreferences;
  try {
    await app.chooseCommit(); await app.click("M src/login.ts"); await app.waitForFrame((frame) => frame.includes("const line00"));
    app.get("git-diff").focus(); app.mockInput.pressKey("END"); await app.renderOnce();
    await app.click("radian-ui (feature"); await app.click("radian (main)");
    expect(app.get("git-diff").visible).toBe(true);
    retained = app.view.workViewPreferences;
    expect(retained.gitViews?.["demo:main"]?.diffScroll).toBeGreaterThan(0);
  } finally { await app.close(); }
  const restored = await mount({ initial: retained! });
  try {
    await restored.waitForFrame((frame) => frame.includes("const line69"));
    expect(restored.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(restored.requests).toEqual([]);
  } finally { await restored.close(); }
});

test("전송 거절은 Git 프롬프트를 보존하고 새 세션은 명시적 Send에서만 생성한다", async () => {
  // The session selector includes an explicit New session choice, never implicit creation on browse.
  const app = await mount({ actions: { prompt: () => err(new InputError("Request rejected")) } });
  try {
    await app.chooseCommit(); app.mockInput.pressKey("a"); await app.renderOnce();
    for (let i = 0; i < 3; i++) await app.click("Change session");
    expect(app.creations).toEqual([]); expect(app.captureCharFrame()).toContain("New session");

    app.get("git-prompt").focus(); await app.mockInput.typeText("keep this ay"); app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("Request rejected"));

    expect(app.creations).toEqual(["demo:main"]); expect(app.captureCharFrame()).toContain("keep this ay");
    expect(app.get("git-ask").visible).toBe(true); expect(app.view.workViewPreferences.active["demo:main"]).toBe("git");
  } finally { await app.close(); }
});

test("Reflog의 a는 이벤트 상세를 보내고 y는 전체 대상 해시를 복사한다", async () => {
  // Reflog uses the full-width history without resurrecting the right panel.
  const app = await mount();
  try {
    await app.click("Reflog"); app.mockInput.pressKey("y"); await app.waitFor(() => app.copies.length > 0);

    await app.ask("explain this event");

    expect(app.copies[0]).toBe(commit.oid);
    expect(app.requests[0]!.text).toContain("HEAD@{0}"); expect(app.requests[0]!.text).toContain("commit: Update login");
    expect(app.get("git-right").visible).toBe(false);
  } finally { await app.close(); }
});

test("파일명 드래그는 diff를 열지 않고 선택한 부분만 복사한다", async () => {
  // Selection is not activation: a text drag must not drill into a file.
  const app = await mount();
  try {
    const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes("M src/login.ts")), x = lines[y]!.indexOf("M src/login.ts") + 2;

    await app.mockMouse.drag(x, y, x + "src/login.ts".length - 1, y); await app.waitFor(() => app.copies.length > 0);

    expect(app.copies[0]).toBe("src/login.ts"); expect(app.get("git-diff").visible).toBe(false);
    expect(app.get("git-history").visible).toBe(true); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("diff의 반대쪽까지 드래그해도 시작한 코드 영역만 복사한다", async () => {
  // A terminal-native whole-screen selection would mix both columns and line numbers.
  const app = await mount();
  try {
    await app.click("M src/login.ts"); await app.waitForFrame((frame) => frame.includes("const line00"));
    const [left, right] = app.codes().sort((a, b) => a.x - b.x);

    await app.mockMouse.drag(left!.x, left!.y, right!.x + 4, right!.y); await app.waitFor(() => app.copies.length > 0); await app.renderOnce();

    expect(app.copies[0]).toBe("const line00 = 0;"); expect(right!.hasSelection()).toBe(false);
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("숨기면서 중단한 상세 조회는 복귀할 때 다시 읽고 이전 결과는 무시한다", async () => {
  // A cached commit list must not leave an aborted detail request stuck on Loading forever.
  const pending = Promise.withResolvers<Result<import("../git/model.ts").GitDetails, ExpectedError>>();
  let reads = 0;
  const app = await mount({ source: {
    load: async () => ok(snapshot()), compare: async () => ok(comparison()),
    details: async (selected) => ++reads === 1 ? pending.promise : ok({ commit: selected, message: "Fresh detail", files: [] }),
  } });
  try {
    await app.click("Update login"); await app.click("radian-ui (feature"); await app.click("radian (main)");

    await app.waitForFrame((frame) => frame.includes("Author: Ada"));
    pending.resolve(ok({ commit, message: "Stale detail", files: [] })); await app.renderOnce();

    expect(reads).toBe(2); expect(app.captureCharFrame()).not.toContain("Stale detail");
  } finally { pending.resolve(ok({ commit, message: "cleanup", files: [] })); await app.close(); }
});

test("지원하지 않는 클립보드는 복사 성공으로 표시하지 않는다", async () => {
  // The platform boundary can explicitly reject writes even when text selection works.
  const app = await mount({ actions: { copy: async () => err(new ClipboardError("Clipboard denied")) } });
  try {
    await app.chooseCommit(); app.mockInput.pressKey("y");

    await app.waitForFrame((frame) => frame.includes("Clipboard denied"));

    expect(app.captureCharFrame()).not.toContain("Copied to clipboard"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("좁은 화면의 diff와 Reflog 전환은 기존 선택과 하단 푸터를 유지한다", async () => {
  // Native layout must not assume the original Neovim viewer's minimum terminal width.
  const app = await mount();
  try {
    await app.chooseCommit(); await app.click("M src/login.ts"); await app.waitForFrame((frame) => frame.includes("const line00"));

    app.resize(60, 12); await app.renderOnce(); app.resize(160, 32); await app.renderOnce(); await app.click("Reflog");

    expect(app.get("git-right").visible).toBe(false); expect(app.captureCharFrame()).toContain("radian 0.0.0");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("renderer가 먼저 종료돼도 늦은 Git 응답과 정리는 native 버퍼를 접근하지 않는다", async () => {
  // UI shutdown is independent from the lifetime of a slow read-only query.
  const pending = Promise.withResolvers<Result<import("../git/model.ts").GitDetails, ExpectedError>>();
  const app = await mount({ source: { load: async () => ok(snapshot()), details: () => pending.promise, compare: async () => ok(comparison()) } });
  try {
    await app.click("Update login");

    app.renderer.destroy(); await app.renderer.closed;
    pending.resolve(ok({ commit, message: "Late detail", files: [] })); await Promise.resolve();
    app.view.dispose();

    expect(app.view.workViewPreferences.active["demo:main"]).toBe("git"); expect(app.requests).toEqual([]);
  } finally { pending.resolve(ok({ commit, message: "cleanup", files: [] })); await app.close(); }
});

test("다른 worktree 선택 뒤 늦은 조회 응답은 현재 Git 화면을 덮어쓰지 않는다", async () => {
  // The first source ignores cancellation deliberately to exercise the UI generation guard.
  const pending = Promise.withResolvers<Result<GitSnapshot, ExpectedError>>();
  const app = await mount({ actions: { source: (worktree) => worktree.id === "demo:feature" ? {
    load: () => pending.promise, details: async () => err(new InputError("unused")), compare: async () => err(new InputError("unused")),
  } : { load: async () => ok(snapshot()), details: async () => err(new InputError("unused")), compare: async () => err(new InputError("unused")) } } });
  try {
    await app.click("radian-ui (feature"); await app.click("Git"); await app.click("radian (main)");

    const delayed = snapshot(); delayed.commits[0] = { ...commit, subject: "Stale result" }; pending.resolve(ok(delayed)); await app.renderOnce();

    expect(app.captureCharFrame()).not.toContain("Stale result");
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { pending.resolve(ok(snapshot())); await app.close(); }
});
