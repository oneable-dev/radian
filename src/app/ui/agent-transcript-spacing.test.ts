import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { ok } from "../../result.ts";

async function mount(section: TranscriptSection | undefined, additional: readonly TranscriptSection[] = []) {
  let current: readonly TranscriptSection[] | undefined = section ? [section, ...additional] : undefined;
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true });
  // Real idle sessions have no owned-subagent row to mask a missing transcript-to-composer gutter.
  const workspace = demoWorkspace().map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
    sessions: tree.sessions.map((session) => ({ ...session, subagents: [] })),
  })) }));
  const selection = new WorkspaceSelection(workspace), copies: string[] = [], prompts: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, initialDrafts: { a1: "Keep my draft" },
    onPrompt: (_id, text) => { prompts.push(text); return ok(undefined); },
    onCopyTranscript: async (text) => { copies.push(text); return ok("Copied"); },
    getSessionDetails: () => ({ status: "complete", output: current ? "" : "LEGACY_OUTPUT", error: null, ...(current ? { sections: current } : {}) }),
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  const scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript viewport");
  const cards = () => scroll.content.getChildren().filter((child): child is BoxRenderable => child instanceof BoxRenderable);
  const card = cards()[0];
  if (!card) throw new Error("Missing transcript section");
  return { ...app, view, scroll, card, cards, copies, prompts, render,
    async update(next: readonly TranscriptSection[] | undefined) { current = next; selection.replaceSnapshot(selection.snapshot); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

function expectVerticalInsets(card: BoxRenderable, inset = 1): void {
  const children = card.getChildren().filter((child) => child.visible);
  const first = children[0]!, last = children.at(-1)!;
  expect(first.y - card.y).toBe(inset);
  expect(card.y + card.height - last.y - last.height).toBe(inset);
}

const sections: TranscriptSection[] = [
  { id: "user", kind: "user", title: "You", text: "USER_CONTENT", status: "complete" },
  { id: "assistant", kind: "assistant", title: "Agent", text: "AGENT_CONTENT", status: "complete" },
  { id: "thinking", kind: "thinking", title: "Thinking", text: "THINKING_CONTENT", status: "complete" },
  { id: "tool", kind: "tool", title: "read", text: "HIDDEN_TOOL_CONTENT", status: "complete" },
  { id: "notice", kind: "notice", title: "Notice", text: "NOTICE_CONTENT", status: "complete" },
  { id: "skill", kind: "notice", title: "Skill", text: "review-code", skillName: "review-code", status: "complete" },
];

test.each([120, 60])("At width %i, tools, answers, compaction notices, and prompts have one visible row between them", async (width) => {
  // A long conversation puts the final folded compaction card at the actual viewport bottom.
  const history: TranscriptSection[] = [
    { id: "history", kind: "assistant", title: "Agent", text: "EARLIER_CONTENT\n".repeat(40), status: "complete" },
    { id: "request", kind: "user", title: "You", text: "Commit and push", status: "complete" },
    { id: "push", kind: "tool", title: "bash", command: "git push origin main", text: "PUSH_RESULT", status: "complete" },
    { id: "answer", kind: "assistant", title: "Agent", text: "PUSH_COMPLETED\n\n- Commit details\n\nChecks passed.", status: "complete",
      completion: { startedAt: 1_000_000, completedAt: 1_090_000, durationMs: 90_000, outcome: "complete" } },
    { id: "compact", kind: "notice", title: "Context compacted", text: "COMPACT_SUMMARY", status: "complete" },
  ];
  const app = await mount(history[0], history.slice(1));
  const expectVisibleGaps = () => {
    const [, , tool, answer, compact] = app.cards();
    const content = answer!.getChildren().filter((child) => child.visible);
    const first = content[0]!, last = content.at(-1)!;
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    // Check the visible text/surface boundaries, not only boxes with invisible internal padding.
    expect({ toolToAnswer: first.y - tool!.y - tool!.height, answerToCompact: compact!.y - last.y - last.height,
      compactToComposer: composer.y - compact!.y - compact!.height }).toEqual({ toolToAnswer: 1, answerToCompact: 1, compactToComposer: 1 });
    // The existing boundary row holds the focused section's bottom edge, never extra padding.
    const outlined = app.scroll.focused && app.view.workViewPreferences.agentViews?.a1?.selectedId === "compact";
    expect(app.captureCharFrame().split("\n")[composer.y - 1]!.slice(app.scroll.viewport.x, app.scroll.viewport.x + app.scroll.viewport.width).trim())
      .toBe(outlined ? "─".repeat(app.scroll.viewport.width) : "");
  };
  try {
    app.resize(width, 30); await app.render(); expectVisibleGaps();
    expect(app.captureCharFrame()).not.toContain("COMPACT_SUMMARY");
    // Expanding, folding and resizing the last notice must retain the bottom gutter while following.
    pressLeader(app, "["); app.mockInput.pressKey("END"); app.mockInput.pressKey("o", { ctrl: true });
    await app.render(); expectVisibleGaps(); expect(app.captureCharFrame()).toContain("COMPACT_SUMMARY");
    app.resize(width, 24); await app.render(); expectVisibleGaps();
    app.mockInput.pressKey("o", { ctrl: true }); await app.render(); expectVisibleGaps();
    // A compaction notice arriving after an already-rendered answer uses the same final gutter.
    await app.update(history.slice(0, -1)); await app.update(history); expectVisibleGaps();
    expect(app.captureCharFrame()).not.toContain("COMPACT_SUMMARY");
    expect(app.view.promptDrafts.a1).toBe("Keep my draft"); expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test.each([120, 60])("At width %i, transcripts space only tops and sections without duplicating bottom gaps", async (width) => {
  // Different section types share one spacing owner, including initially folded images and tools.
  const mixed: readonly TranscriptSection[] = [...sections, { id: "image", kind: "notice", title: "read", text: "clipboard-1.png", status: "complete",
    image: { id: "a".repeat(64), name: "clipboard-1.png", mimeType: "image/png", byteLength: 80 } }];
  const app = await mount(mixed[0], mixed.slice(1));
  const expectGaps = () => {
    const cards = app.cards();
    expect(cards).toHaveLength(mixed.length);
    expect(cards[0]!.y - app.scroll.content.y).toBe(1);
    const insets = [1, 0, 0, 1, 1, 1, 1];
    for (const [index, card] of cards.entries()) {
      expectVerticalInsets(card, insets[index]);
      const next = cards[index + 1]; if (next) expect(next.y - card.y - card.height).toBe(1);
    }
    const last = cards.at(-1)!;
    expect(app.scroll.scrollHeight - (last.y + last.height - app.scroll.content.y)).toBe(0);
  };
  try {
    app.resize(width, 30); await app.render(); expectGaps();
    // Folding and resizing change card heights, never the space between them.
    pressLeader(app, "["); app.mockInput.pressKey("HOME");
    app.mockInput.pressKey("z"); app.mockInput.pressKey("r"); await app.render(); expectGaps();
    app.resize(width, 18); await app.render(); expectGaps();
    app.mockInput.pressKey("z"); app.mockInput.pressKey("m"); await app.render(); expectGaps();

    // Help is not a transcript section and must not lose scarce viewport rows to its gutters.
    app.mockInput.pressKey("F1"); await app.render();
    const help = app.scroll.content.getChildren().find((node) => node.visible)!;
    expect(help.y).toBe(app.scroll.content.y); expect(app.scroll.scrollHeight).toBe(help.height);
    app.mockInput.pressKey("F1"); await app.render(); expectGaps();
    expect(app.view.promptDrafts.a1).toBe("Keep my draft"); expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test.each(["assistant", "thinking"] as const)("%s errors retain one-row spacing between sections, bodies, and completion metadata", async (kind) => {
  // Late errors on headerless bodies must not duplicate section and inner gaps.
  const tool: TranscriptSection = { id: "edit", kind: "tool", title: "edit", text: "HIDDEN_RESULT", status: "complete" };
  const prose: TranscriptSection = { id: "prose", kind, title: kind, text: "**PROSE_BODY**", status: "streaming" };
  const failed: TranscriptSection = { ...prose, status: "error", error: "ECONNRESET: The socket connection was closed unexpectedly. ERROR_END" };
  const app = await mount(tool, [prose]);
  const expectErrorGaps = () => {
    const [toolCard, proseCard] = app.cards();
    const lines = app.captureCharFrame().split("\n").map((line) => line.slice(app.scroll.viewport.x, app.scroll.viewport.x + app.scroll.viewport.width));
    const errorStart = lines.findIndex((line) => line.includes("ECONNRESET"));
    const errorEnd = lines.findIndex((line) => line.includes("ERROR_END"));
    const body = lines.findIndex((line) => line.includes("PROSE_BODY"));
    expect(errorStart - toolCard!.y - toolCard!.height).toBe(1);
    expect(errorEnd).toBeGreaterThanOrEqual(errorStart);
    expect(body - errorEnd).toBe(2);
    // Only the outer gap becomes an outline; the inner error-to-body gap stays blank.
    const outlined = (app.scroll.focused || app.scroll.hasFocusedDescendant) && app.view.workViewPreferences.agentViews?.a1?.selectedId === "prose";
    expect(lines[errorStart - 1]!.trim()).toBe(outlined ? "─".repeat(app.scroll.viewport.width) : "");
    expect(lines[body - 1]!.trim()).toBe("");
    expectVerticalInsets(proseCard!, 0);
    const content = proseCard!.getChildren().filter((child) => child.visible);
    for (let index = 1; index < content.length; index++) expect(content[index]!.y - content[index - 1]!.y - content[index - 1]!.height).toBe(1);
  };
  try {
    // Error wrapping and Markdown/source switching share visible spacing.
    await app.update([tool, failed]);
    for (const width of [120, 60, 120]) {
      app.resize(width, 30); await app.render(); expectErrorGaps();
      pressLeader(app, "["); app.mockInput.pressKey("END"); app.mockInput.pressEnter();
      await app.render(); expectErrorGaps();
      app.mockInput.pressEscape(); await app.render(); expectErrorGaps();
    }
    await app.update([tool, { ...failed, completion: { startedAt: 1000, completedAt: 2000, durationMs: 1000, outcome: "error" } }]);

    // Completion spaces only visible items; hidden errors leave no blank rows.
    expectErrorGaps(); expect(app.captureCharFrame()).toContain("Failed after");
    await app.update([tool, prose]);
    expect(app.captureCharFrame()).not.toContain("ECONNRESET");
    expectVerticalInsets(app.cards()[1]!, 0); expect(app.cards()[1]!.height).toBe(1);
    expect(app.view.promptDrafts.a1).toBe("Keep my draft"); expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test("Plain/structured transitions never duplicate gaps and section margins", async () => {
  const app = await mount(sections[0], sections.slice(1));
  try {
    const initial = app.cards();
    expect(initial[1]!.y - initial[0]!.y - initial[0]!.height).toBe(1);
    await app.update(undefined);
    expect(app.cards()).toHaveLength(1);
    expect(app.cards()[0]!.height).toBe(1); expect(app.captureCharFrame()).toContain("LEGACY_OUTPUT");
    await app.update(sections);
    const cards = app.cards();
    for (let index = 1; index < cards.length; index++) expect(cards[index]!.y - cards[index - 1]!.y - cards[index - 1]!.height).toBe(1);
    expect(app.view.promptDrafts.a1).toBe("Keep my draft"); expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test.each(sections)("$kind sections retain card/plain spacing in compact layouts: $id", async (section) => {
  // Tinted surfaces keep their internal gutters; plain prose relies on the parent's gutters instead.
  const inset = section.kind === "assistant" || section.kind === "thinking" ? 0 : 1;
  const app = await mount(section);
  try {
    for (const [width, height] of [[120, 30], [60, 12], [120, 30]] as const) {
      app.resize(width, height); await app.render();

      // Resize may scroll the card, but must not double the prose gutters or overlap the footer.
      expectVerticalInsets(app.card, inset);
      expect(app.card.height).toBe(inset ? section.id === "notice" ? 5 : 3 : 1);
      expect(app.card.y - app.scroll.content.y).toBe(app.scroll.viewport.height > 1 ? 1 : 0);
      if (!inset) expect(app.captureCharFrame()).toContain(section.text);
      expect(app.captureCharFrame().split("\n")[height - 1]).toContain("AGENT");
      expect(app.view.promptDrafts.a1).toBe("Keep my draft");
    }
    const frame = app.captureCharFrame().split("\n");
    for (const y of inset ? [app.card.y, app.card.y + app.card.height - 1] : []) {
      expect(frame[y]!.slice(app.card.x, app.card.x + app.card.width).trim()).toBe("");
    }
    expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test("Tool folding and summary-source entry preserve symmetric padding and exact copying", async () => {
  const source = "Arguments:\n{}\n\nResult:\nTOOL_RESULT";
  const app = await mount({ id: "tool", kind: "tool", title: "read", text: source, status: "error", error: "Permission denied" });
  try {
    // Keyboard readers switch between the summary and full source, not decorative padding.
    pressLeader(app, "["); app.mockInput.pressKey("HOME");
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expectVerticalInsets(app.card);
    expect(app.captureCharFrame()).toContain("TOOL_RESULT");
    app.mockInput.pressKey("y"); await app.render();
    expect(app.copies).toEqual([source]);

    app.mockInput.pressKey("o", { ctrl: true }); app.mockInput.pressEnter(); await app.render();
    expectVerticalInsets(app.card);
    expect(app.captureCharFrame()).not.toContain("TOOL_RESULT");
    app.mockInput.pressKey("y", { shift: true }); await app.render();

    // Neither the added blank rows nor the error heading become part of the copied tool result.
    expect(app.copies).toEqual([source, source]);
    expect(app.view.promptDrafts.a1).toBe("Keep my draft");
    expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test.each([120, 60])("At width %i, folded and expanded command errors have exactly one blank row above", async (width) => {
  // A multiline command exposes the boundary between its last visual line and the error summary.
  const app = await mount({ id: "failed-command", kind: "tool", title: "bash", command: "printf 'Header output'\nfalse",
    text: "RAW_TOOL_RESULT", status: "error", error: "Command exited with code 1" });
  try {
    app.resize(width, 24); await app.render();
    const expectErrorGap = () => {
      const lines = app.captureCharFrame().split("\n").map((line) => line.slice(app.card.x, app.card.x + app.card.width));
      const error = lines.findIndex((line) => line.includes("Command exited with code 1"));
      expect(error).toBeGreaterThan(1);
      expect(lines[error - 1]!.trim()).toBe("");
      expect(lines[error - 2]!.trim()).not.toBe("");
      const result = lines.findIndex((line) => line.includes("RAW_TOOL_RESULT"));
      if (result >= 0) {
        expect(result - error).toBe(2);
        expect(lines[result - 1]!.trim()).toBe("");
      }
    };

    // Folding, expansion and repainting must use the same one-row error separation.
    expectErrorGap(); expect(app.captureCharFrame()).not.toContain("RAW_TOOL_RESULT");
    pressLeader(app, "["); app.mockInput.pressKey("HOME");
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();
    expectErrorGap(); expect(app.captureCharFrame()).toContain("RAW_TOOL_RESULT");
    app.mockInput.pressKey("o", { ctrl: true }); await app.render();

    expectErrorGap(); expectVerticalInsets(app.card);
    expect(app.prompts).toEqual([]); expect(app.view.promptDrafts.a1).toBe("Keep my draft");
  } finally { await app.close(); }
});

test("Legacy plain output without sections displays unchanged without extra card margins", async () => {
  // Legacy output is one text surface rather than a structured transcript card.
  const app = await mount(undefined);
  try {
    await app.render();

    const body = app.card.getChildren().find((child) => child.visible)!;
    expect(body.y).toBe(app.card.y);
    expect(app.card.height).toBe(body.height);
    expect(app.card.y).toBe(app.scroll.content.y);
    expect(app.captureCharFrame()).toContain("LEGACY_OUTPUT");
  } finally { await app.close(); }
});
