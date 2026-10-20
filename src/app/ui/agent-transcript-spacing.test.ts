import { expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { ok } from "../../result.ts";

async function mount(section: TranscriptSection | undefined) {
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace()), copies: string[] = [], prompts: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, initialDrafts: { a1: "Keep my draft" },
    onPrompt: (_id, text) => { prompts.push(text); return ok(undefined); },
    onCopyTranscript: async (text) => { copies.push(text); return ok("Copied"); },
    getSessionDetails: () => ({ status: "complete", output: section ? "" : "LEGACY_OUTPUT", error: null, ...(section ? { sections: [section] } : {}) }),
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  const scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript viewport");
  const card = scroll.content.getChildren().find((child): child is BoxRenderable => child instanceof BoxRenderable);
  if (!card) throw new Error("Missing transcript section");
  return { ...app, view, scroll, card, copies, prompts, render,
    async close() { view.dispose(); await app.dispose(); },
  };
}

function expectVerticalInsets(card: BoxRenderable): void {
  const children = card.getChildren().filter((child) => child.visible);
  const first = children[0]!, last = children.at(-1)!;
  expect(first.y - card.y).toBe(1);
  expect(card.y + card.height - last.y - last.height).toBe(1);
}

const sections: TranscriptSection[] = [
  { id: "user", kind: "user", title: "You", text: "USER_CONTENT", status: "complete" },
  { id: "assistant", kind: "assistant", title: "Agent", text: "AGENT_CONTENT", status: "complete" },
  { id: "thinking", kind: "thinking", title: "Thinking", text: "THINKING_CONTENT", status: "complete" },
  { id: "tool", kind: "tool", title: "read", text: "HIDDEN_TOOL_CONTENT", status: "complete" },
  { id: "notice", kind: "notice", title: "Notice", text: "NOTICE_CONTENT", status: "complete" },
  { id: "skill", kind: "notice", title: "Skill", text: "review-code", skillName: "review-code", status: "complete" },
];

test.each(sections)("$kind 섹션은 작은 화면에서도 위아래 한 줄 내부 여백을 동일하게 유지한다: $id", async (section) => {
  // Every section type, including compact tool/skill rows, uses the same vertical card rhythm.
  const app = await mount(section);
  try {
    for (const [width, height] of [[120, 30], [60, 12], [120, 30]] as const) {
      app.resize(width, height); await app.render();

      // Resize may scroll the card, but must not remove either internal gutter or overlap the footer.
      expectVerticalInsets(app.card);
      expect(app.card.height).toBe(section.id === "notice" ? 5 : 3);
      expect(app.captureCharFrame().split("\n")[height - 1]).toContain("Radian");
      expect(app.view.promptDrafts.a1).toBe("Keep my draft");
    }
    const frame = app.captureCharFrame().split("\n");
    for (const y of [app.card.y, app.card.y + app.card.height - 1]) {
      expect(frame[y]!.slice(app.card.x, app.card.x + app.card.width).trim()).toBe("");
    }
    expect(app.prompts).toEqual([]);
  } finally { await app.close(); }
});

test("도구를 펼치거나 접고 요약 원문에 진입해도 대칭 여백과 정확한 복사를 유지한다", async () => {
  const source = "Arguments:\n{}\n\nResult:\nTOOL_RESULT";
  const app = await mount({ id: "tool", kind: "tool", title: "read", text: source, status: "error", error: "Permission denied" });
  try {
    // Keyboard readers switch between the summary and full source, not decorative padding.
    app.mockInput.pressKey("t", { ctrl: true }); app.mockInput.pressKey("HOME");
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

test("섹션이 없는 기존 평문 출력은 추가 카드 여백 없이 그대로 표시한다", async () => {
  // Legacy output is one text surface rather than a structured transcript card.
  const app = await mount(undefined);
  try {
    await app.render();

    const body = app.card.getChildren().find((child) => child.visible)!;
    expect(body.y).toBe(app.card.y);
    expect(app.card.height).toBe(body.height);
    expect(app.captureCharFrame()).toContain("LEGACY_OUTPUT");
  } finally { await app.close(); }
});
