import { expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { AgentPanel, type AgentActions } from "./agent-panel.ts";
import type { Worktree } from "../../workspace/model.ts";
import { ok, type Result } from "../../result.ts";
import type { ExpectedError } from "../../errors.ts";

const tree: Worktree = { id: "tree", path: "/fixture", name: "fixture", branch: "main", sessions: [
  { id: "a", name: "Session A", status: null, subagents: [] },
  { id: "b", name: "Session B", status: null, subagents: [] },
] };
const openIds = new Set(["a", "b"]);
async function mount(actions: Partial<AgentActions> = {}, scroll: Record<string, number> = {}) {
  const app = await createTestRenderer({ width: 80, height: 18, kittyKeyboard: true });
  const notices: string[] = [], saved: Record<string, number> = {};
  const panel = new AgentPanel(app.renderer, {
    onNewSession: () => {}, onPrompt: () => ok(undefined),
    getSessionDetails: (id) => ({ status: null, output: `Output ${id}`, error: null }), ...actions,
  }, (label, activate) => {
    const button = new BoxRenderable(app.renderer, { height: 1, flexShrink: 0, focusable: true, onMouseDown: activate });
    button.add(new TextRenderable(app.renderer, { content: label })); return button;
  }, (notice) => notices.push(notice), () => {}, () => panel.prompt.blur(), scroll, (id, value) => { saved[id] = value; });
  app.renderer.root.add(panel.root);
  panel.update(tree, "a", openIds, true);
  await app.renderOnce(); await app.renderOnce();
  return { ...app, panel, notices, saved, async close() { panel.dispose(); await app.dispose(); } };
}

test("독립 Agent 패널은 세션이 없을 때 명시적인 생성 클릭만 전달한다", async () => {
  // Workbench 없이도 빈 상태를 표시하며 패널 진입 자체는 세션을 만들지 않는다.
  const created: string[] = [];
  const app = await mount({ onNewSession: (id) => created.push(id) });
  try {
    app.panel.update({ ...tree, sessions: [] }, null, new Set(), true);
    await app.renderOnce();
    expect(created).toEqual([]); expect(app.captureCharFrame()).toContain("No open sessions");

    // 사용자가 빈 상태의 생성 버튼을 직접 누른다.
    const rows = app.captureCharFrame().split("\n"), y = rows.findIndex((row) => row.includes("+ New session"));
    await app.mockMouse.click(rows[y]!.indexOf("+ New session") + 1, y);

    expect(created).toEqual(["tree"]);
  } finally { await app.close(); }
});

test("Agent 패널의 늦은 전송 수락은 다른 세션의 초안을 지우지 않는다", async () => {
  // A의 요청이 수락을 기다리는 동안 B로 전환할 수 있다.
  const pending = Promise.withResolvers<Result<void, ExpectedError>>();
  const sent: { id: string; text: string }[] = [];
  const app = await mount({ onPrompt: (id, text) => { sent.push({ id, text }); return pending.promise; } });
  try {
    app.panel.prompt.focus(); await app.mockInput.typeText("first");
    const submission = app.panel.submitPrompt(); await app.panel.submitPrompt();
    app.panel.update(tree, "b", openIds, true);
    await app.mockInput.typeText("second");

    // A의 수락은 캡처한 A의 초안만 정리하고 현재 입력은 보존해야 한다.
    pending.resolve(ok(undefined)); await submission; await app.renderOnce();

    expect(sent).toEqual([{ id: "a", text: "first" }]);
    expect(app.panel.promptDrafts).toEqual({ b: "second" });
    expect(app.captureCharFrame()).toContain("second");
    expect(app.notices).toEqual([]);
  } finally { pending.resolve(ok(undefined)); await app.close(); }
});

test("독립 Agent 패널도 첫 표시 프레임부터 긴 세션의 저장 위치를 복원한다", async () => {
  // 짧은 A의 레이아웃으로 B의 저장 위치가 잘리지 않아야 한다.
  const app = await mount({ getSessionDetails: (id) => ({ status: null, error: null,
    output: id === "a" ? "SHORT" : Array.from({ length: 100 }, (_, index) => `LONG-${String(index).padStart(3, "0")}`).join("\n") }) }, { b: 53 });
  const frames: (string | null)[] = [];
  const capture = () => frames.push(app.captureCharFrame().match(/LONG-\d{3}/)?.[0] ?? null);
  try {
    app.renderer.on("frame", capture);
    app.panel.update(tree, "b", openIds, true);
    await app.renderOnce(); await app.renderOnce();

    // 최종 화면만이 아니라 실제 표시된 모든 전환 프레임을 확인한다.
    expect(frames.length).toBeGreaterThan(0);
    expect(new Set(frames)).toEqual(new Set(["LONG-053"]));
    app.panel.transcriptScroll.scrollTo(57);
    expect(app.saved.b).toBe(57);
  } finally { app.renderer.off("frame", capture); await app.close(); }
});
