import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { ok } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";
import type { Repository } from "../../workspace/model.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

const empty = (): ExecutionState => ({ status: null, output: "", error: null, sections: [], conversationId: "initial" });
const conversation = (): ExecutionState => ({ status: "complete", output: "Existing answer", error: null, sections: [
  { id: "request", kind: "user", title: "You", text: "First request", status: "complete" },
  { id: "answer", kind: "assistant", title: "Agent", text: "Existing answer", status: "complete" },
] });
async function mount(initial: ExecutionState | null = empty()) {
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true });
  const repositories: Repository[] = [{ id: "repo", name: "repo", worktrees: [{ id: "tree", name: "tree", path: "/demo/tree", branch: "main",
    sessions: [{ id: "first", name: "First session", status: null, subagents: [] }] }] }];
  const selection = new WorkspaceSelection(repositories), sent: string[] = [];
  const states: Record<string, ExecutionState | null> = { first: initial, existing: conversation() };
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {},
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); }, getSessionDetails: (id) => states[id] ?? null });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  const scroll = get("session-transcript"); if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript");
  const prompt = get("session-prompt"); if (!(prompt instanceof PromptInput)) throw new Error("Missing prompt");
  const mark = get("radian-logo-mark"); if (!(mark instanceof TextRenderable)) throw new Error("Missing logo");
  const region = (x: number, y: number, width: number, height: number) => app.captureCharFrame().split("\n").slice(y, y + height)
    .map((line) => line.slice(x, x + width)).join("\n");
  await render();
  return { ...app, view, states, selection, sent, render, get, scroll, prompt, mark,
    transcriptFrame: () => region(scroll.viewport.x, scroll.viewport.y, scroll.viewport.width, scroll.viewport.height),
    logoFrame: () => region(mark.x, mark.y, mark.width, mark.height),
    async update(state: ExecutionState | null) { states.first = state; selection.replaceSnapshot(selection.snapshot); await render(); },
    async close() { view.dispose(); await app.dispose(); } };
}
// The artwork is intentionally replaceable; behavior tests require its actual rendering, not a fixed shape.
function expectLogo(app: Awaited<ReturnType<typeof mount>>): void {
  expect(app.get("radian-logo").visible).toBe(true);
  expect(app.logoFrame().trim()).not.toBe("");
  expect(app.logoFrame()).toBe(app.mark.plainText);
}

test("Initial empty sessions show only centered logos without guidance, Ready, or draft submission", async () => {
  // A new session has no transcript, child activity or runtime work to report.
  const app = await mount();
  try {
    // Typing an unsent draft must not dismiss the empty conversation's branding.
    pressLeader(app, "a"); await app.mockInput.typeText("unsent draft"); await app.render();

    // The mark is centered in the usable transcript viewport, with no idle status gutter.
    const { mark, scroll: { viewport } } = app;
    expectLogo(app);
    expect(Math.abs(mark.x + mark.width / 2 - viewport.x - viewport.width / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(mark.y + mark.height / 2 - viewport.y - viewport.height / 2)).toBeLessThanOrEqual(0.5);
    expect(app.captureCharFrame()).not.toMatch(/No messages yet|Enter a prompt|Ready/);
    expect(app.get("transcript-status-row").visible).toBe(false);
    expect(app.scroll.scrollTop).toBe(0); expect(app.scroll.scrollHeight).toBeLessThanOrEqual(viewport.height);
    expect(app.prompt.value).toBe("unsent draft"); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Missing details and legacy empty output never invent Transcript guidance", async () => {
  // Details can arrive after session selection, or omit structured sections on an older runtime.
  const app = await mount(null);
  try {
    // Entering the transcript cannot select a fabricated legacy notice in either snapshot.
    for (const state of [null, { status: null, output: "", error: null }] as const) {
      await app.update(state);
      pressLeader(app, "["); app.mockInput.pressEnter(); await app.render();

      expect(app.renderer.currentFocusedRenderable).toBe(app.scroll);
      expectLogo(app);
      expect(app.captureCharFrame()).not.toMatch(/Enter a prompt|Ready|Transcript/);
      expect(app.view.workViewPreferences.agentViews?.first?.selectedId).toBeNull();
      expect(app.get("transcript-status-row").visible).toBe(false);
    }
  } finally { await app.close(); }
});

test("First messages replace logos and new conversations/session round-trips restore empty screens and drafts", async () => {
  // An existing session is available alongside the new session without sharing its draft or content.
  const app = await mount();
  try {
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
      sessions: [...tree.sessions, { id: "existing", name: "Existing session", status: "complete" as const, subagents: [] }],
    })) })));
    pressLeader(app, "a"); await app.mockInput.typeText("keep this draft"); await app.render();

    // A delivered request replaces branding immediately, before any assistant answer exists.
    await app.update({ ...conversation(), status: "working", sections: conversation().sections!.slice(0, 1) });
    expect(app.transcriptFrame()).toContain("First request"); expect(app.get("radian-logo").visible).toBe(false);
    expect(app.get("agent-run-loading").visible).toBe(true);
    await app.update({ ...empty(), conversationId: "replacement" });
    app.selection.selectSession("tree", "existing"); await app.render();
    expect(app.transcriptFrame()).toContain("Existing answer"); expect(app.get("radian-logo").visible).toBe(false);
    app.selection.selectSession("tree", "first"); await app.render();

    // Resetting a conversation and returning to it restore only its own blank transcript and draft.
    expectLogo(app); expect(app.transcriptFrame()).not.toContain("Existing answer");
    expect(app.get("transcript-status-row").visible).toBe(false); expect(app.get("agent-run-loading").visible).toBe(false);
    expect(app.prompt.value).toBe("keep this draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Empty-conversation help leaves logos visible and restores logo/input focus on close", async () => {
  // Help remains available even though there are no transcript sections to select.
  const app = await mount();
  try {
    // Open the real transcript help through keyboard navigation, then dismiss it.
    pressLeader(app, "["); app.mockInput.pressKey("F1"); await app.render();
    expect(app.transcriptFrame()).toContain("Sections:"); expect(app.get("radian-logo").visible).toBe(false);
    app.mockInput.pressEscape(); await app.render();

    // Branding returns without manufacturing a message or trapping transcript focus.
    expectLogo(app); expect(app.transcriptFrame()).not.toContain("Sections:");
    app.mockInput.pressEscape(); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("작은 화면의 로고는 입력창을 침범하지 않고 확대·테마 변경 후에도 중앙에 남는다", async () => {
  // The terminal mark uses theme colors and must remain usable without image or font protocols.
  const app = await mount();
  try {
    // A short viewport uses a compact mark instead of spilling a large logo into the composer.
    app.resize(60, 12); await app.render();
    expectLogo(app); expect(app.mark.height).toBe(1);
    expect(app.mark.y).toBeGreaterThanOrEqual(app.scroll.viewport.y);
    expect(app.mark.y + app.mark.height).toBeLessThanOrEqual(app.get("agent-composer").y);
    app.resize(120, 30); await app.render();
    const previousColor = app.mark.fg;
    const theme = uiTheme(app.renderer);
    theme.configure({ palette: [], defaultForeground: "#202020", defaultBackground: "#FAFAF6", cursorColor: null,
      mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
    await app.render();

    // Resizing restores the full centered mark, and a light theme repaints its subdued foreground.
    expectLogo(app); expect(app.mark.height).toBeGreaterThan(1); expect(app.mark.fg).not.toEqual(previousColor);
    expect(Math.abs(app.mark.y + app.mark.height / 2 - app.scroll.viewport.y - app.scroll.viewport.height / 2)).toBeLessThanOrEqual(0.5);
    expect(app.get("transcript-status-row").visible).toBe(false); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("메시지가 없는 실행·실패도 실제 상태를 숨기지 않는다", async () => {
  // Empty transcript content must not suppress real operational feedback.
  const app = await mount();
  try {
    // Request-less work and its failure still cross the normal status boundary.
    await app.update({ ...empty(), status: "working" });
    expect(app.captureCharFrame()).toContain("Working (0s"); expect(app.get("agent-run-loading").visible).toBe(true);
    await app.update({ ...empty(), status: "failure", error: "Fixture failure" });

    // An actionable error keeps the status row visible instead of disappearing as idle decoration.
    expect(app.captureCharFrame()).toContain("Failed: Fixture failure");
    expect(app.get("transcript-status-row").visible).toBe(true); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});
