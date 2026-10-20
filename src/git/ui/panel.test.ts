import { expect, test } from "bun:test";
import { CodeRenderable, DiffRenderable, TextAttributes, TextRenderable, type Renderable, type TerminalColors } from "@opentui/core";
import { uiTheme } from "../../ui/theme.ts";
import { Button } from "../../ui/button.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { createTestRenderer, ManualClock, MockTreeSitterClient } from "@opentui/core/testing";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { icons } from "../../icons.ts";
import type { GitActions } from "./panel.ts";
import type { GitCommit, GitComparison, GitSnapshot, GitSource } from "../model.ts";
import type { WorkViewPreferences } from "../../runtime/protocol.ts";
import { ClipboardError, InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";

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

async function mount(options: { actions?: Partial<GitActions>; initial?: WorkViewPreferences; source?: GitSource; clock?: ManualClock } = {}) {
  const app = await createTestRenderer({ width: 160, height: 32, kittyKeyboard: true, ...(options.clock ? { clock: options.clock } : {}) });
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
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, onPrompt: git.prompt, git,
    initialWorkViews: options.initial ?? { active: {}, agentScroll: {} }, initialDrafts: { a1: "existing Agent draft" },
    getSessionDetails: () => ({ status: "working", output: "Existing agent run", error: null }),
  });
  const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)];
  const get = (id: string) => { const result = walk(app.renderer.root).find((node) => node.id === id); if (!result) throw new Error(`Missing ${id}`); return result; };
  await app.renderOnce();
  const click = async (text: string) => {
    if (text.startsWith(icons.folder)) { app.mockInput.pressKey("f", { ctrl: true }); app.mockInput.pressKey("u", { ctrl: true }); await app.renderOnce(); }
    const lines = app.captureCharFrame().split("\n"); const y = lines.findIndex((line) => line.includes(text)), x = lines[y]?.indexOf(text) ?? -1;
    if (x < 0) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
    await app.mockMouse.click(x + Math.min(1, text.length - 1), y); await app.renderOnce();
  };
  const showGit = async () => { app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("g"); await app.renderOnce(); await app.renderOnce(); };
  if (!options.initial?.active["demo:main"]) await showGit();
  await app.waitForFrame((frame) => frame.includes("Working tree") || get("git-diff").visible || frame.includes("HEAD@{"));
  const positionIn = (id: string, text: string) => {
    const region = get(id), lines = app.captureCharFrame().split("\n");
    for (let y = region.y; y < region.y + region.height; y++) {
      const offset = lines[y]?.slice(region.x, region.x + region.width).indexOf(text) ?? -1;
      if (offset >= 0) return { x: region.x + offset, y };
    }
    throw new Error(`Missing ${text} in ${id}\n${app.captureCharFrame()}`);
  };
  return { ...app, view, selection, copies, requests, loads, creations, get, click, showGit, positionIn,
    async clickIn(id: string, text: string) {
      const { x, y } = positionIn(id, text);
      await app.mockMouse.click(x + Math.min(1, text.length - 1), y); await app.renderOnce();
    },
    spanIn(id: string, text: string) {
      const position = positionIn(id, text); let x = 0;
      const span = app.captureSpans().lines[position.y]!.spans.find((item) => { x += item.width; return x > position.x; });
      if (!span) throw new Error(`Missing colored text ${text} in ${id}`);
      return span;
    },
    codes: () => walk(get("git-diff")).filter((node): node is CodeRenderable => node instanceof CodeRenderable),
    async chooseCommit() { await click("Update login"); await app.waitForFrame((frame) => frame.includes("Author: Ada")); },
    async ask(text: string) { app.mockInput.pressKey("a"); await app.renderOnce(); await app.mockInput.typeText(text); app.mockInput.pressEnter(); await app.waitFor(() => requests.length > 0); await app.renderOnce(); },
    async close() { view.dispose(); await app.dispose(); await highlighter.destroy(); },
  };
}

test("Git의 Agent 요청도 여러 줄·접힌 원문·이미지 참조를 같은 입력 규칙으로 전달한다", async () => {
  const sent: {text:string;images:readonly string[]}[]=[];
  const app=await mount({actions:{prompt:(_id,text,images)=>{sent.push({text,images:images??[]});return ok(undefined);}}});
  try {
    await app.chooseCommit();app.mockInput.pressKey("a");await app.renderOnce();
    const input=app.get("git-prompt");if(!(input instanceof PromptInput))throw new Error("Missing Git prompt");
    const original="Long Git request\n".repeat(100);
    await app.mockInput.pasteBracketedText(original);app.mockInput.pressEnter({shift:true});await app.mockInput.pasteBracketedText("/tmp/image.png /tmp/context.txt");await app.renderOnce();
    expect(input.value).toContain("[Pasted Content");expect(input.value).toContain("[Image #1]");expect(sent).toEqual([]);
    app.mockInput.pressEnter();await app.waitFor(()=>sent.length>0);

    expect(sent[0]!.text).toContain(original);expect(sent[0]!.text).toContain('@"/tmp/context.txt"');expect(sent[0]!.text).toContain(commit.oid);
    expect(sent[0]!.images).toEqual(["/tmp/image.png"]);expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
  }finally{await app.close();}
});

test.each([false, true])("밝기 %j에서도 Git의 모든 뷰·필터 탭은 포커스 배경 없이 밑줄만 표시한다", async (light) => {
  // 실제 Git 데이터와 Workbench 버튼 factory를 사용해 세 묶음의 탭을 함께 검증한다.
  const app = await mount();
  const controls = (node: Renderable): Button[] => [...(node instanceof Button ? [node] : []), ...node.getChildren().flatMap(controls)];
  const control = (name: string) => {
    const found = controls(app.get("git-view")).find((button) => button.getChildren().some((child) => child instanceof TextRenderable && child.plainText === name));
    if (!found) throw new Error(`Missing Git control ${name}`);
    return found;
  };
  const cell = (name: string) => {
    const button = control(name), label = button.getChildren()[0]!; let x = 0;
    return app.captureSpans().lines[label.y]!.spans.find((span) => { x += span.width; return x > label.x; })!;
  };
  const expectTab = (name: string) => {
    const button = control(name), spans = app.captureSpans().lines[button.y]!.spans;
    expect(cell(name).attributes & TextAttributes.UNDERLINE).not.toBe(0);
    for (let x = button.x; x < button.x + button.width; x++) {
      let end = 0; const span = spans.find((item) => { end += item.width; return end > x; })!;
      expect(span.bg.toInts()).toEqual(uiTheme(app.renderer).colors.panel.toInts());
    }
  };
  try {
    uiTheme(app.renderer).configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
    await app.renderOnce();
    const loads = app.loads.length;

    // 화면이나 필터를 확정하지 않은 포커스 이동에도 일관된 밑줄을 표시한다.
    for (const name of ["Commits", "Reflog", "Commit", "Refs"]) {
      control(name).focus(); await app.renderOnce(); expectTab(name);
    }
    expect(cell("Commits").attributes & TextAttributes.BOLD).not.toBe(0);
    expect(cell("Reflog").attributes & TextAttributes.BOLD).toBe(0);
    expect(app.loads.length).toBe(loads);

    // Refs 안의 Local/Remote/Tags도 같은 탭 스타일을 쓰고 기존 선택 동작은 보존한다.
    await app.clickIn("git-right", "Refs");
    for (const name of ["Local", "Remote", "Tags"]) {
      control(name).focus(); await app.renderOnce(); expectTab(name);
    }
    await app.clickIn("git-right", "Remote"); app.get("git-history").focus(); await app.renderOnce();
    expectTab("Remote"); expect(cell("Remote").attributes & TextAttributes.BOLD).not.toBe(0);
    expect(cell("Local").attributes & TextAttributes.BOLD).toBe(0);

    // 실행 버튼은 탭이 아니므로 기존 포커스 배경을 유지하고 아무 요청도 전송하지 않는다.
    await app.clickIn("git-right", "Commit"); await app.chooseCommit();
    app.get("git-history").focus(); app.mockInput.pressKey("a"); await app.renderOnce();
    expect(app.get("git-ask").visible).toBe(true);
    control("Cancel").focus(); await app.renderOnce();
    expect(cell("Cancel").bg.toInts()).toEqual(uiTheme(app.renderer).colors.selected.toInts());
    expect(cell("Cancel").attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(app.requests).toEqual([]); expect(app.creations).toEqual([]);
  } finally { await app.close(); }
});

test("Refresh 버튼 없이 r로 새로고침하고 spinner는 탭과 같은 행에서 최소 500ms 표시한다", async () => {
  // Keep refresh pending at the query boundary and drive animation with the renderer clock.
  const clock = new ManualClock(); let reads = 0;
  const pending = Promise.withResolvers<Result<GitSnapshot, ExpectedError>>();
  const app = await mount({ clock, source: {
    load: async () => ++reads === 1 ? ok(snapshot()) : pending.promise,
    details: async (commit) => ok({ commit, message: commit.subject, files: [] }), compare: async () => ok(comparison()),
  } });
  try {
    clock.advance(500); await app.renderOnce();
    const toolbar = app.get("git-toolbar"), spinner = app.get("git-loading"), tab = toolbar.getChildren()[0]!;
    const toolbarText = () => app.captureCharFrame().split("\n")[toolbar.y]!.slice(toolbar.x, toolbar.x + toolbar.width);
    expect(toolbarText()).not.toContain("Refresh");
    expect(spinner.visible).toBe(false);
    const position = [spinner.x, spinner.y, toolbar.height];

    // The scoped key still performs a real source reload, not just a visual animation.
    app.get("git-history").focus(); app.mockInput.pressKey("r"); await app.renderOnce();
    expect(reads).toBe(2); expect(spinner.visible).toBe(true);
    expect([spinner.y, spinner.height]).toEqual([tab.y, tab.height]);
    expect(toolbarText()).toContain("⠋");
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("r Refresh");
    clock.advance(80); await app.renderOnce();
    expect(toolbarText()).toContain("⠙");
    pending.resolve(ok(snapshot())); await app.renderOnce(); await app.renderOnce();
    clock.advance(419); await app.renderOnce(); expect(spinner.visible).toBe(true);
    clock.advance(1); await app.renderOnce(); expect(spinner.visible).toBe(false);
    expect([spinner.x, spinner.y, toolbar.height]).toEqual(position);
    expect(app.requests).toEqual([]);
  } finally { pending.resolve(ok(snapshot())); await app.close(); }
});

test("More 버튼 없이 + 키로 커밋을 300개씩 더 읽고 소진되면 추가 조회하지 않는다", async () => {
  // Keep pagination available without adding an action beside the history tabs.
  const limits: number[] = [];
  const app = await mount({ source: {
    load: async (_reference, limit) => {
      limits.push(limit); const data = snapshot();
      data.commits = limits.length === 1 ? Array.from({ length: 300 }, (_, index) => ({ ...commit,
        oid: (index + 1).toString(16).padStart(40, "0"), subject: `Commit ${index}` })) : [commit];
      return ok(data);
    },
    details: async (commit) => ok({ commit, message: commit.subject, files: [] }), compare: async () => ok(comparison()),
  } });
  try {
    expect(app.captureCharFrame()).not.toContain("+ More");
    app.get("git-history").focus(); app.mockInput.pressKey("+");
    await app.waitFor(() => limits.length === 2); await app.renderOnce();
    expect(limits).toEqual([300, 600]);
    expect(app.captureCharFrame()).not.toContain("+ More");
    app.mockInput.pressKey("+"); await app.renderOnce();
    expect(limits).toEqual([300, 600]); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Git 목록과 diff는 일반·좁은 화면 모두 사이드바 구분선 하단에 맞춘다", async () => {
  // Repository reads are controlled; list, diff and responsive native layout are real.
  const app = await mount();
  const aligned = (id: string) => {
    const pane = app.get("work-panel"), content = app.get(id);
    expect(content.y + content.height).toBe(pane.y + pane.height);
  };
  try {
    for (const [width, height] of [[160, 32], [60, 12], [79, 18], [80, 17], [160, 32]] as const) {
      app.resize(width, height); await app.renderOnce(); await app.renderOnce();
      aligned("git-history");
      const panel = app.get("git-view");
      expect(panel.y).toBe(app.get("work-panel").y);
      expect(app.get("git-history").y).toBe(panel.y + 2); // One blank row separates the tabs and content.
      expect(app.captureCharFrame()).not.toContain("Git ·");
      if (app.get("git-right").visible) aligned("git-right");
    }
    await app.click("Reflog"); aligned("git-history");
    await app.click("Commits"); await app.click("src/login.ts");
    await app.waitForFrame((frame) => frame.includes("const line00"));
    for (const [width, height] of [[160, 32], [60, 12], [79, 18], [80, 17], [160, 32]] as const) {
      app.resize(width, height); await app.renderOnce(); await app.renderOnce();
      aligned("git-diff"); aligned("git-file-diff");
    }
    expect(app.requests).toEqual([]); expect(app.creations).toEqual([]);
  } finally { await app.close(); }
});

test("Git 탭 아래에는 화면 크기와 Commit·Refs·Reflog 전환에 관계없이 한 줄 여백을 둔다", async () => {
  // Keep real terminal layout while using read-only fixture data.
  const app = await mount();
  try {
    await app.chooseCommit();
    for (const [width, height] of [[160, 32], [79, 18], [80, 18], [60, 12], [160, 32]] as const) {
      app.resize(width, height); await app.renderOnce(); await app.renderOnce();
      const toolbar = app.get("git-toolbar"), panel = app.get("git-view"), right = app.get("git-right");
      const rightTab = app.positionIn("git-right", "Commit");
      const contentX = app.positionIn("git-right", "Changed files").x;
      const lines = app.captureCharFrame().split("\n");

      // Both navigation bars reserve an actual blank row, not just text padding.
      expect(app.get("git-history").y).toBe(toolbar.y + toolbar.height + 1);
      expect(lines[toolbar.y + 1]!.slice(panel.x, panel.x + panel.width).trim()).toBe("");
      expect(app.get("git-details").y).toBe(rightTab.y + 2);
      expect(lines[rightTab.y + 1]!.slice(contentX, right.x + right.width).trim()).toBe("");

      await app.clickIn("git-right", "Refs");
      expect(app.positionIn("git-right", "Local").y).toBe(app.positionIn("git-right", "Commit").y + 2);
      await app.clickIn("git-right", "Commit");
      await app.click("Reflog");
      expect(app.positionIn("git-history", "HEAD@{0}").y).toBe(toolbar.y + 2);
      await app.click("Commits");
    }
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Git 탭·상세·Refs의 텍스트는 Changed files와 같은 왼쪽 시작선을 사용한다", async () => {
  // Changed files already has the desired content inset; it must not move to compensate for buttons.
  const app = await mount();
  try {
    await app.chooseCommit();
    // Select Remote while its full label is visible, then retain that view through resizes.
    await app.clickIn("git-right", "Refs"); await app.clickIn("git-right", "Remote"); await app.clickIn("git-right", "Commit");
    for (const [width, height] of [[160, 32], [79, 18], [80, 18], [60, 12], [160, 32]] as const) {
      app.resize(width, height); await app.renderOnce(); await app.renderOnce();
      const contentX = app.positionIn("git-right", "Changed files").x;

      expect(app.positionIn("git-toolbar", "Commits").x).toBe(app.get("git-history").x);
      expect(app.positionIn("git-right", "Commit").x).toBe(contentX);
      expect(app.get("git-detail-text").x).toBe(contentX);
      expect(app.get("git-files").x).toBe(contentX);

      await app.clickIn("git-right", "Refs");
      expect(app.positionIn("git-right", "Local").x).toBe(contentX);
      expect(app.captureCharFrame()).not.toContain("All refs");
      expect(app.get("git-refs").x).toBe(contentX);
      expect(app.positionIn("git-refs", `${icons.branch} origin/main`).x).toBe(contentX);
      expect(app.positionIn("git-refs", "origin/main").x).toBe(contentX + 2);
      await app.clickIn("git-right", "Commit");
    }
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Changed files와 Refs 종류 탭 아래에도 한 줄을 비우고 All refs 버튼은 표시하지 않는다", async () => {
  // Empty spacing replaces the extra action row without changing the content inset.
  const app = await mount();
  try {
    await app.chooseCommit();
    const details = app.get("git-details");
    expect(app.positionIn("git-right", "Changed files").y).toBe(details.y + details.height + 1);
    await app.click("Working tree");
    for (const [width, height] of [[160, 32], [79, 18], [80, 18], [60, 12], [160, 32]] as const) {
      app.resize(width, height); await app.renderOnce(); await app.renderOnce();
      const title = app.positionIn("git-right", "Changed files"), right = app.get("git-right");
      expect(title.y).toBe(app.positionIn("git-right", "Commit").y + 2);
      expect(app.get("git-files").y).toBe(title.y + 2);
      expect(app.captureCharFrame().split("\n")[title.y + 1]!.slice(title.x, right.x + right.width).trim()).toBe("");

      await app.clickIn("git-right", "Refs");
      const tabs = app.positionIn("git-right", "Local");
      expect(app.get("git-refs").y).toBe(tabs.y + 2);
      expect(app.captureCharFrame().split("\n")[tabs.y + 1]!.slice(tabs.x, right.x + right.width).trim()).toBe("");
      expect(app.captureCharFrame()).not.toContain("All refs");
      await app.clickIn("git-right", "Commit");
    }
  } finally { await app.close(); }
});

test("커밋 상세의 Changed files와 첫 파일 사이에는 화면 높이에 관계없이 실제 빈 줄 하나만 그린다", async () => {
  // A percent-height detail viewport must not introduce an extra rounded row below the title.
  const app = await mount({ source: { load: async () => ok(snapshot()), details: async (selected) => ok({ commit: selected,
    message: "Commit explanation\n".repeat(40), files: [{ kind: "commit", status: "M", path: "src/only-file.ts", commit: selected }] }), compare: async () => ok(comparison()) } });
  try {
    await app.chooseCommit();
    for (const width of [120, 160, 240]) for (let height = 20; height <= 70; height++) {
      app.resize(width, height); await app.renderOnce(); await app.renderOnce();
      const title = app.positionIn("git-right", "Changed files"), file = app.positionIn("git-files", "M src/only-file.ts");
      expect({ width, height, gap: file.y - title.y - 1 }).toEqual({ width, height, gap: 1 });
      expect(app.captureCharFrame().split("\n")[title.y + 1]!.slice(title.x, app.get("git-right").x + app.get("git-right").width).trim()).toBe("");
    }
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Refs 버튼에 포커스가 있어도 Esc는 커밋 선택과 초안을 유지하며 Commit으로 돌아간다", async () => {
  // Mouse focus stays on the tab button rather than entering the refs list.
  const app = await mount();
  try {
    await app.chooseCommit(); await app.clickIn("git-right", "Refs");
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("Esc Back");

    app.mockInput.pressEscape(); await app.renderOnce();

    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.right).toBe("commit");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(app.captureCharFrame()).toContain("Changed files");
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft"); expect(app.loads).toEqual(["all"]);
    expect(app.requests).toEqual([]); expect(app.creations).toEqual([]);
  } finally { await app.close(); }
});

test.each(["list", "button", "history"] as const)("Refs 필터를 고른 뒤 %s 포커스의 Esc는 checkout 없이 전체 커밋으로 돌아간다", async (focus) => {
  // A ref only changes the read query; Escape must replace the removed All refs action.
  const app = await mount();
  try {
    await app.clickIn("git-right", "Refs"); await app.clickIn("git-right", "Remote"); await app.clickIn("git-refs", "origin/main");
    await app.waitFor(() => app.loads.includes("refs/remotes/origin/main"));
    if (focus === "button") await app.clickIn("git-right", "Local");
    if (focus === "history") { await app.clickIn("git-right", "Commit"); app.get("git-history").focus(); await app.renderOnce(); }

    app.mockInput.pressEscape(); await app.waitFor(() => app.loads.at(-1) === "all"); await app.renderOnce();

    const state = app.view.workViewPreferences.gitViews?.["demo:main"];
    expect(state?.reference).toBeNull(); expect(state?.right).toBe("commit"); expect(state?.diff).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history");
    expect(app.captureCharFrame()).toContain("Working tree");
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft");
    expect(app.requests).toEqual([]); expect(app.creations).toEqual([]);
  } finally { await app.close(); }
});

test("필터된 diff의 Esc는 먼저 diff만 닫고 다음 Esc에서 ref 필터를 해제한다", async () => {
  // Going back one level must not unexpectedly discard the ref being reviewed.
  const app = await mount();
  try {
    await app.clickIn("git-right", "Refs"); await app.clickIn("git-right", "Remote"); await app.clickIn("git-refs", "origin/main");
    await app.waitFor(() => app.loads.includes("refs/remotes/origin/main"));
    await app.clickIn("git-right", "Commit"); await app.chooseCommit(); await app.click("M src/login.ts");
    await app.waitForFrame((frame) => frame.includes("const line00")); app.get("git-diff").focus(); await app.renderOnce();
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("Esc Back");
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).not.toContain("Esc Commits");

    app.mockInput.pressEscape(); await app.renderOnce();
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBe("refs/remotes/origin/main");
    expect(app.get("git-history").visible).toBe(true);
    app.mockInput.pressEscape(); await app.waitFor(() => app.loads.at(-1) === "all"); await app.renderOnce();

    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.reference).toBeNull();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("git-history"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Git은 Commits/Reflog와 오른쪽 Commit/Refs를 표시하고 Reflog에서는 오른쪽을 숨긴다", async () => {
  // No model, OS clipboard, or actual repository mutation is needed for layout interaction.
  const app = await mount();
  try {
    expect(app.captureCharFrame()).toMatch(/Commits\s+Reflog/); expect(app.captureCharFrame()).toMatch(/Commit\s+Refs/);
    const tab = (label: string) => app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text === label)!;
    expect(tab("Commits").attributes & TextAttributes.UNDERLINE).not.toBe(0);
    expect(tab("Reflog").attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(app.captureCharFrame()).toContain("UNSTAGED"); expect(app.captureCharFrame()).toContain("UNTRACKED");
    expect(app.captureCharFrame()).not.toContain("Submodules"); expect(app.get("git-right").visible).toBe(true);

    await app.click("Reflog");

    expect(app.get("git-right").visible).toBe(false);
    expect(tab("Reflog").attributes & TextAttributes.UNDERLINE).not.toBe(0);
    expect(tab("Commits").attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(app.captureCharFrame()).toContain("HEAD@{0}"); expect(app.captureCharFrame()).not.toContain("Changed files");
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Commits는 테마가 바뀌어도 해시와 그래프만 강조하고 메시지와 ref는 기본 텍스트색을 쓴다", async () => {
  // A visible graph and ref label expose accidental whole-row coloring.
  const app = await mount();
  try {
    await app.chooseCommit();
    const before = app.captureCharFrame();

    // Repaint the mounted list in both dark and light terminal palettes.
    for (const text of ["#EEEEEE", "#202020"]) {
      uiTheme(app.renderer).configure({ palette: [], defaultForeground: text, defaultBackground: text === "#EEEEEE" ? "#121212" : "#FAFAFA",
        cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
        highlightForeground: null, highlightBackground: null });
      await app.renderOnce();

      const colors = uiTheme(app.renderer).colors;
      expect(app.spanIn("git-history", "aaaaaaa").fg.equals(colors.text)).toBe(false);
      expect(app.spanIn("git-history", "aaaaaaa").fg.toInts()).toEqual(app.spanIn("git-history", "●").fg.toInts());
      expect(app.spanIn("git-history", "Update login").fg.toInts()).toEqual(colors.text.toInts());
      expect(app.spanIn("git-history", "HEAD → main").fg.toInts()).toEqual(colors.text.toInts());
      expect(app.spanIn("git-history", "Working tree").fg.toInts()).toEqual(colors.text.toInts());
      expect(app.captureCharFrame()).toBe(before);
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    }
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Reflog는 해시만 강조하고 selector와 메시지는 기본 텍스트색을 쓴다", async () => {
  // Reflog has no graph, so its hash needs an explicit semantic color.
  const app = await mount();
  try {
    await app.click("Reflog");

    const colors = uiTheme(app.renderer).colors;
    expect(app.spanIn("git-history", "aaaaaaa").fg.toInts()).toEqual(colors.warning.toInts());
    expect(app.spanIn("git-history", "HEAD@{0}").fg.toInts()).toEqual(colors.text.toInts());
    expect(app.spanIn("git-history", "commit: Update login").fg.toInts()).toEqual(colors.text.toInts());
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("변경 파일 섹션 사이에는 빈 줄 하나를 두고 빈 줄은 선택이나 diff 열기의 대상이 아니다", async () => {
  // Multiple staged files distinguish section spacing from per-file spacing.
  const data = snapshot();
  data.files.unshift({ kind: "staged", status: "A", path: "new.ts" }, { kind: "staged", status: "M", path: "staged.ts" });
  const app = await mount({ source: { load: async () => ok(data), details: async () => ok({ commit, message: commit.subject, files: [] }), compare: async () => ok(comparison()) } });
  try {
    const staged = app.positionIn("git-files", "STAGED"), first = app.positionIn("git-files", "A new.ts");
    const last = app.positionIn("git-files", "M staged.ts"), unstaged = app.positionIn("git-files", "UNSTAGED");
    const modified = app.positionIn("git-files", "M src/login.ts"), untracked = app.positionIn("git-files", "UNTRACKED");
    expect(staged.y).toBe(app.get("git-files").y);
    expect(first.y).toBe(staged.y + 1); expect(last.y).toBe(first.y + 1);
    expect(unstaged.y).toBe(last.y + 2); expect(modified.y).toBe(unstaged.y + 1);
    expect(untracked.y).toBe(modified.y + 2);
    expect(app.positionIn("git-files", "? notes.txt").y).toBe(untracked.y + 1);

    // Blank margins remain inert even though clicking them can focus the list.
    const list = app.get("git-files"), selected = app.view.workViewPreferences.gitViews?.["demo:main"]?.file;
    for (const y of [unstaged.y - 1, untracked.y - 1]) {
      expect(app.captureCharFrame().split("\n")[y]!.slice(list.x, list.x + list.width).trim()).toBe("");
      await app.mockMouse.click(list.x + 1, y); await app.renderOnce();
      expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.file).toBe(selected);
      expect(app.get("git-history").visible).toBe(true);
    }

    // Keyboard navigation counts only files, not headings or the new whitespace.
    list.focus(); app.mockInput.pressKey("HOME");
    for (let index = 0; index < 3; index++) app.mockInput.pressArrow("down");
    app.mockInput.pressKey("y"); await app.waitFor(() => app.copies.length > 0);
    expect(app.copies).toEqual(["notes.txt"]); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("비어 있는 변경 파일 섹션을 건너뛰어도 첫 섹션 위나 파일 사이에 여백을 더하지 않는다", async () => {
  // With no staged or unstaged files, untracked is the first visible section.
  const data = snapshot(); data.files = [{ kind: "untracked", status: "?", path: "first.txt" }, { kind: "untracked", status: "?", path: "second.txt" }];
  const app = await mount({ source: { load: async () => ok(data), details: async () => ok({ commit, message: commit.subject, files: [] }), compare: async () => ok(comparison()) } });
  try {
    const title = app.positionIn("git-files", "UNTRACKED"), first = app.positionIn("git-files", "? first.txt");
    expect(title.y).toBe(app.get("git-files").y);
    expect(first.y).toBe(title.y + 1);
    expect(app.positionIn("git-files", "? second.txt").y).toBe(first.y + 1);
    expect(app.captureCharFrame()).not.toContain("UNSTAGED"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Changed files는 M 글자만 강조하고 A·D·미추적 파일의 전체 색상은 유지한다", async () => {
  // Exercise working-tree statuses without changing repository files on disk.
  const data = snapshot();
  data.files.push({ kind: "staged", status: "A", path: "added.ts" }, { kind: "unstaged", status: "D", path: "deleted.ts" });
  const app = await mount({ source: { load: async () => ok(data), details: async () => ok({ commit, message: commit.subject, files: [] }), compare: async () => ok(comparison()) } });
  try {
    app.get("git-files").focus(); await app.renderOnce();

    const colors = uiTheme(app.renderer).colors;
    expect(app.spanIn("git-files", "M src/login.ts").fg.toInts()).toEqual(colors.warning.toInts());
    expect(app.spanIn("git-files", "src/login.ts").fg.toInts()).toEqual(colors.text.toInts());
    for (const text of ["A added.ts", "added.ts", "? notes.txt", "notes.txt"]) expect(app.spanIn("git-files", text).fg.toInts()).toEqual(colors.success.toInts());
    for (const text of ["D deleted.ts", "deleted.ts"]) expect(app.spanIn("git-files", text).fg.toInts()).toEqual(colors.error.toInts());
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

test("Refs는 브랜치·태그 아이콘을 표시하고 현재 브랜치만 체크 대신 강조색으로 구분한다", async () => {
  // Two local branches can share a tip without both being the checked-out branch.
  const data = snapshot(); data.refs.push({ kind: "local", name: "feature/topic", ref: "refs/heads/feature/topic", oid: commit.oid });
  const app = await mount({ source: { load: async () => ok(data), details: async () => ok({ commit, message: commit.subject, files: [] }), compare: async () => ok(comparison()) } });
  try {
    await app.clickIn("git-right", "Refs");
    const colors = uiTheme(app.renderer).colors;
    expect(app.positionIn("git-refs", `${icons.branch} main`).x).toBe(app.positionIn("git-refs", `${icons.branch} feature/topic`).x);
    expect(app.spanIn("git-refs", `${icons.branch} main`).fg.toInts()).toEqual(colors.accent.toInts());
    expect(app.spanIn("git-refs", "main").fg.toInts()).toEqual(colors.accent.toInts());
    expect(app.spanIn("git-refs", `${icons.branch} feature/topic`).fg.toInts()).toEqual(colors.text.toInts());
    expect(app.captureCharFrame()).not.toContain("✓ main");

    // Selecting a different ref changes the query, not which branch gets HEAD coloring.
    await app.clickIn("git-refs", "feature/topic");
    expect(app.spanIn("git-refs", `${icons.branch} main`).fg.toInts()).toEqual(colors.accent.toInts());
    expect(app.spanIn("git-refs", `${icons.branch} feature/topic`).fg.toInts()).toEqual(colors.text.toInts());
    app.mockInput.pressKey("y"); await app.waitFor(() => app.copies.length === 1);
    expect(app.copies).toEqual(["feature/topic"]);
    await app.clickIn("git-right", "Remote");
    expect(app.spanIn("git-refs", `${icons.branch} origin/main`).fg.toInts()).toEqual(colors.text.toInts());
    await app.clickIn("git-right", "Tags");
    expect(app.spanIn("git-refs", `${icons.tag} v1`).fg.toInts()).toEqual(colors.text.toInts());
    expect(app.requests).toEqual([]); expect(app.creations).toEqual([]);
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

test("Git diff의 h/l은 양쪽 코드의 가로 위치를 함께 움직이고 키 입력을 전송하지 않는다", async () => {
  const longLine = `const horizontal = "${"wide content ".repeat(30)}";\n`;
  const source: GitSource = { load: async () => ok(snapshot()), details: async () => { throw new Error("Unexpected details request"); },
    compare: async () => ok({ before: longLine, after: longLine + "// after\n", beforeLabel: "before", afterLabel: "after" }) };
  const app = await mount({ source });
  try {
    await app.click("M src/login.ts"); await app.waitForFrame((frame) => frame.includes("const horizontal"));
    app.get("git-diff").focus(); app.mockInput.pressKey("l"); await app.renderOnce();
    const panes = app.codes(); expect(panes).toHaveLength(2); expect(panes[0]!.scrollX).toBe(4); expect(panes[1]!.scrollX).toBe(4);
    app.mockInput.pressKey("h"); await app.renderOnce();
    expect(panes[0]!.scrollX).toBe(0); expect(panes[1]!.scrollX).toBe(0); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("파일 선택은 중앙만 전체 파일 diff로 바꾸고 양쪽을 하나의 포커스로 스크롤한다", async () => {
  // The comparison has unchanged content far outside the modified middle line.
  const app = await mount();
  try {
    await app.click("M src/login.ts");
    await app.waitForFrame((frame) => frame.includes("const line00"));
    expect(app.get("git-right").visible).toBe(true); expect(app.captureCharFrame()).toContain("Changed files");
    expect(app.captureCharFrame()).not.toContain("← Commits");
    expect(app.captureCharFrame()).not.toContain("Before / After");
    expect(app.get("git-file-diff").y).toBe(app.get("git-diff").y);
    expect(app.get("git-file-diff").height).toBe(app.get("git-diff").height);
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
    await app.click(`${icons.folder} radian-ui`); await app.click(`${icons.folder} radian`);
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
  const pending = Promise.withResolvers<Result<import("../model.ts").GitDetails, ExpectedError>>();
  let reads = 0;
  const app = await mount({ source: {
    load: async () => ok(snapshot()), compare: async () => ok(comparison()),
    details: async (selected) => ++reads === 1 ? pending.promise : ok({ commit: selected, message: "Fresh detail", files: [] }),
  } });
  try {
    await app.click("Update login"); await app.click(`${icons.folder} radian-ui`); await app.click(`${icons.folder} radian`);

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

test("Git diff의 테마 변경은 밝은 배경·구문색을 반영하고 스크롤과 요청 초안을 보존한다", async () => {
  // Theme updates must not reset navigation or accidentally send the open request.
  const app = await mount();
  const dark: TerminalColors = { palette: ["#000000", "#AA2222", "#228822", "#887700", "#2255AA", "#AA22AA", "#117799", "#DDDDDD"],
    defaultForeground: "#EEEEEE", defaultBackground: "#121212", cursorColor: null, mouseForeground: null, mouseBackground: null,
    tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null };
  try {
    uiTheme(app.renderer).configure(dark);
    await app.chooseCommit(); await app.click("M src/login.ts"); await app.waitForFrame((frame) => frame.includes("const line00"));
    const oldDiff = app.get("git-file-diff");
    if (!(oldDiff instanceof DiffRenderable)) throw new Error("Missing whole-file diff");
    expect(oldDiff.contextBg.toInts().slice(0, 3)).toEqual([18, 18, 18]);
    expect(oldDiff.addedBg.toInts().slice(0, 3)).toEqual([23, 53, 23]);
    expect(oldDiff.removedBg.toInts().slice(0, 3)).toEqual([64, 23, 23]);
    expect(oldDiff.addedSignColor.toInts().slice(0, 3)).toEqual([34, 136, 34]);
    expect(oldDiff.removedSignColor.toInts().slice(0, 3)).toEqual([170, 34, 34]);
    app.get("git-diff").focus(); app.mockInput.pressKey("END"); await app.renderOnce();
    const scroll = app.codes()[0]!.scrollY;
    app.mockInput.pressKey("a"); await app.renderOnce(); await app.mockInput.typeText("keep this request");
    const prompt = app.get("git-prompt");

    app.renderer.emit("palette", { ...dark, defaultForeground: "#202020", defaultBackground: "#FAFAFA", palette: [...dark.palette.slice(0, 5), "#664488", "#117799", "#DDDDDD"] });
    await app.renderOnce(); await app.renderOnce();

    const diff = app.get("git-file-diff");
    if (!(diff instanceof DiffRenderable) || !(prompt instanceof PromptInput)) throw new Error("Missing themed controls");
    expect(diff.contextBg.toInts().slice(0, 3)).toEqual([250, 250, 250]);
    expect(diff.lineNumberFg.toInts()[0]).toBeLessThan(160);
    expect(diff.addedBg.toInts().slice(0, 3)).toEqual([185, 216, 185]);
    expect(diff.removedBg.toInts().slice(0, 3)).toEqual([226, 185, 185]);
    expect(diff.addedContentBg?.toInts()).toEqual(diff.addedBg.toInts());
    expect(diff.removedContentBg?.toInts()).toEqual(diff.removedBg.toInts());
    expect(diff.addedLineNumberBg.toInts()).toEqual(diff.addedBg.toInts());
    expect(diff.removedLineNumberBg.toInts()).toEqual(diff.removedBg.toInts());
    expect(diff.syntaxStyle?.getStyle("keyword")?.fg?.toInts().slice(0, 3)).toEqual([102, 68, 136]);
    expect(app.codes()[0]!.scrollY).toBe(scroll); expect(app.codes()[1]!.scrollY).toBe(scroll);
    expect(prompt.value).toBe("keep this request"); expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.view.promptDrafts.a1).toBe("existing Agent draft"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("좁은 화면의 diff와 Reflog 전환은 기존 선택과 하단 푸터를 유지한다", async () => {
  // Native layout must not assume the original Neovim viewer's minimum terminal width.
  const app = await mount();
  try {
    await app.chooseCommit(); await app.click("M src/login.ts"); await app.waitForFrame((frame) => frame.includes("const line00"));

    app.resize(60, 12); await app.renderOnce(); app.resize(160, 32); await app.renderOnce(); await app.click("Reflog");

    expect(app.get("git-right").visible).toBe(false); expect(app.captureCharFrame()).toContain("Radian 0.0.0");
    expect(app.view.workViewPreferences.gitViews?.["demo:main"]?.selected).toBe(commit.oid);
    expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("renderer가 먼저 종료돼도 늦은 Git 응답과 정리는 native 버퍼를 접근하지 않는다", async () => {
  // UI shutdown is independent from the lifetime of a slow read-only query.
  const pending = Promise.withResolvers<Result<import("../model.ts").GitDetails, ExpectedError>>();
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
    await app.click(`${icons.folder} radian-ui`); await app.showGit(); await app.click(`${icons.folder} radian`);

    const delayed = snapshot(); delayed.commits[0] = { ...commit, subject: "Stale result" }; pending.resolve(ok(delayed)); await app.renderOnce();

    expect(app.captureCharFrame()).not.toContain("Stale result");
    expect(app.selection.worktree?.id).toBe("demo:main"); expect(app.requests).toEqual([]);
  } finally { pending.resolve(ok(snapshot())); await app.close(); }
});
