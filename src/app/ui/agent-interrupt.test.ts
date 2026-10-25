import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { summarizeRequest } from "../../agents/request-summary.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { ok } from "../../result.ts";

async function mount(width = 150) {
  const clock = new ManualClock(), app = await createTestRenderer({ width, height: 30, kittyKeyboard: true, exitOnCtrlC: false, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), interrupted: string[] = [], sent: string[] = [];
  let state: ExecutionState = { conversationId: "conversation", status: "working", output: "", error: null,
    runTiming: { startedAt: 1000, elapsedMs: 12000 },
    sections: [{ id: "request", kind: "user", title: "You", text: "Current request", status: "complete" }],
    pendingMessages: [summarizeRequest("Add tests", 0), summarizeRequest("Do not edit README", 0)] };
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {},
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); },
    onInterrupt: async (id) => { interrupted.push(id); return ok(undefined); }, getSessionDetails: () => state,
    onComplete: async () => ok({ items: [{ kind: "command", value: "compact", description: "Compact context" }], truncated: false }),
  });
  const get = (id: string) => app.renderer.root.findDescendantById(id)!;
  const prompt = get("session-prompt") as PromptInput;
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render(); prompt.focus(); await render();
  return { ...app, clock, view, selection, interrupted, sent, prompt, get, render,
    update(next: ExecutionState) { state = next; selection.replaceSnapshot(selection.snapshot); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("Queued hints and shortcuts share one row while indented messages remain separate from input", async () => {
  // Distinguish runtime-owned queues from unsubmitted drafts on the same screen.
  const app = await mount(190);
  try {
    await app.mockInput.typeText("Unsent draft"); await app.render();

    // Keep hints on one row, messages immediately below, and one blank row before input.
    const frame = app.captureCharFrame(), lines = frame.split("\n");
    const pending = app.get("agent-pending-messages"), status = app.get("agent-run-status"), composer = app.get("agent-composer");
    const row = (y: number) => lines[y]!.slice(pending.x, pending.x + pending.width).trimEnd();
    expect(row(status.y)).toContain("Working (12s · <Esc> to interrupt)");
    expect(row(status.y + 1)).toBe("“Current request”"); expect(status.height).toBe(2);
    expect(row(pending.y)).toBe("• Messages will be sent after the current response and tools finish (press <Esc> to interrupt and send immediately)");
    expect(row(pending.y + 1)).toBe("  ↳ Add tests"); expect(row(pending.y + 2)).toBe("  ↳ Do not edit README");
    expect(row(pending.y + 3)).toBe(""); expect(frame).not.toContain("Queued");
    const statusGroup = app.get("transcript-status-row");
    expect(pending.y).toBe(statusGroup.y + statusGroup.height + 1);
    expect(composer.y).toBe(pending.y + 4);
    const hints = app.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text === "<Esc>");
    expect(hints).toHaveLength(2); for (const span of hints) expect(span.attributes & TextAttributes.BOLD).not.toBe(0);
    expect(app.sent).toEqual([]);

    // Esc interrupts only selected runs without arbitrarily clearing drafts or runtime queues.
    app.mockInput.pressEscape(); await app.render();
    expect(app.interrupted).toEqual(["a1"]); expect(app.prompt.value).toBe("Unsent draft"); expect(app.sent).toEqual([]);
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
  } finally { await app.close(); }
});

test("Ctrl+C clears only attachment drafts without changing execution or queued input", async () => {
  // An attached file is part of the draft and must not survive as hidden metadata.
  const app = await mount();
  try {
    await app.mockInput.typeText("draft "); app.prompt.attachFile("./package.json"); await app.render();

    app.mockInput.pressCtrlC(); await app.render();

    expect(app.prompt.value).toBe(""); expect(app.prompt.draft.tokens).toEqual([]);
    expect(app.view.promptDrafts.a1).toBeUndefined(); expect(app.view.promptInputDrafts.a1).toBeUndefined();
    expect(app.captureCharFrame()).toContain("Add tests"); expect(app.interrupted).toEqual([]); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("The first completion Esc closes candidates and the next interrupts execution", async () => {
  // Completion dismissal has priority over agent interruption.
  const app = await mount();
  try {
    await app.mockInput.typeText("/"); await app.render();
    expect(app.get("prompt-completions").visible).toBe(true);

    app.mockInput.pressEscape(); await app.render();
    expect(app.interrupted).toEqual([]); expect(app.prompt.value).toBe("/");
    app.mockInput.pressEscape(); await app.render();

    expect(app.interrupted).toEqual(["a1"]); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.prompt.value).toBe("/");
  } finally { await app.close(); }
});

test("Long queues in compact layouts never overlap input, status, or footer", async () => {
  const app = await mount();
  try {
    // Queue display is bounded, while every pending item remains runtime-owned.
    app.update({ status: "working", output: "", error: null, pendingMessages: Array.from({ length: 20 }, (_, index) => summarizeRequest(`Pending ${index}`, 0)) });
    app.resize(70, 11); await app.render();

    const composer = app.get("agent-composer"), pending = app.get("agent-pending-messages"), telemetry = app.get("session-status"), footer = app.get("app-footer");
    if (pending.visible) expect(pending.y + pending.height).toBeLessThanOrEqual(composer.y);
    expect(composer.y + composer.height).toBeLessThanOrEqual(telemetry.y);
    expect(telemetry.y + telemetry.height).toBeLessThanOrEqual(footer.y);
    expect(app.prompt.height).toBeGreaterThan(0); expect(app.interrupted).toEqual([]);

    app.resize(150, 30); await app.render();
    expect(app.captureCharFrame()).toContain("• Messages will be sent after the current response and tools finish (press <Esc> to interrupt and send immediately)");
    expect(app.captureCharFrame()).toContain("↳ Pending 0");
  } finally { await app.close(); }
});

test("Idle Esc stays out of the sidebar and queued indicators disappear after delivery", async () => {
  const app = await mount();
  try {
    // A runtime update proves delivery; merely pressing a key must not clear the queue locally.
    app.update({ status: "complete", output: "Done", error: null, pendingMessages: [] }); await app.render();
    expect(app.get("agent-pending-messages").visible).toBe(false);

    app.mockInput.pressEscape(); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt); expect(app.interrupted).toEqual([]);
  } finally { await app.close(); }
});
