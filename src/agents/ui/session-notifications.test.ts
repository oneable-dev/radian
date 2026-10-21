import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import type { SessionNotification } from "../session-notification.ts";
import type { SessionResult } from "../session-attention.ts";
import { SessionNotificationStack } from "./session-notifications.ts";
import { uiTheme } from "../../ui/theme.ts";
import { icons } from "../../icons.ts";

function notification(id: string, outcome: SessionResult["outcome"] = "complete"): SessionNotification {
  return { id, sessionId: id, worktreeId: "tree", conversationId: "conversation", repository: "server", worktree: "auth-checkout", branch: "feature/auth", durationMs: 42000,
    result: { id, outcome, completedAt: 43000, request: { text: `Task ${id}`, images: 0, files: 0 } } };
}
async function fixture() {
  const clock = new ManualClock(), app = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true, clock });
  const opened: string[] = [], stack = new SessionNotificationStack(app.renderer, item => opened.push(item.id));
  const input = new InputRenderable(app.renderer, { id: "input", width: 30 });
  app.renderer.root.add(input); app.renderer.root.add(stack.root); input.focus();
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node;
  };
  await render();
  return { ...app, clock, opened, stack, input, render, get,
    async close() { stack.dispose(); await app.dispose(); } };
}

test.each(["complete", "error", "unfinished", "cancelled"] as const)("새 %s 알림은 상태색·요약과 아이콘이 붙은 워크트리·브랜치를 표시하고 포커스를 보존한다", async outcome => {
  // The input owns focus, and the checkout name differs from both the repository and branch.
  const app = await fixture(), labels = { complete: "Completed", error: "Failed", unfinished: "Stopped", cancelled: "Cancelled" };
  try {
    // A passive notification identifies its checkout without taking over input.
    app.stack.show(notification("one", outcome)); app.clock.advance(160); await app.render();

    // Worktree and branch each keep their own icon; the repository no longer occupies this row.
    const card = app.get("session-toast:one"), frame = app.captureCharFrame();
    expect(frame).toContain(`${labels[outcome]} · 42s`); expect(frame).toContain("Task one");
    expect(frame).toContain(`${icons.folder} auth-checkout / ${icons.branch} feature/auth`); expect(frame).not.toContain("server");
    expect(card.x + card.width).toBe(98); expect(card.y).toBe(1); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    let x = 0; const border = app.captureSpans().lines[card.y]!.spans.find(span => { x += span.width; return x > card.x; })!;
    expect(border.fg.toInts()).toEqual(uiTheme(app.renderer).colors[outcome === "complete" ? "success" : outcome === "error" ? "error" : "warning"].toInts());
    expect(app.opened).toEqual([]);
  } finally { await app.close(); }
});

test("브랜치가 없는 알림은 워크트리와 detached HEAD를 아이콘으로 구분한다", async () => {
  // A detached checkout has no branch name to display.
  const app = await fixture();
  try {
    // The same card presentation must handle detached HEAD without inventing a branch.
    app.stack.show({ ...notification("detached"), branch: null }); app.clock.advance(160); await app.render();

    // The checkout remains identifiable and the missing branch is explicit.
    expect(app.captureCharFrame()).toContain(`${icons.folder} auth-checkout / ${icons.branch} detached HEAD`);
  } finally { await app.close(); }
});

test("최대 세 알림만 쌓고 대기 중인 실패 알림은 표시된 뒤부터 8초를 보장한다", async () => {
  // A queued notification's lifetime must not expire while hidden behind the visible three.
  const app = await fixture();
  try {
    for (const id of ["one", "two", "three"]) app.stack.show(notification(id));
    app.stack.show(notification("four", "error")); app.clock.advance(4999); await app.render();
    expect(app.captureCharFrame()).toContain("Task three"); expect(app.captureCharFrame()).not.toContain("Task four");

    app.clock.advance(1); await app.render();
    expect(app.captureCharFrame()).toContain("Task four"); expect(app.captureCharFrame()).not.toContain("Task one");
    app.clock.advance(7999); await app.render(); expect(app.stack.root.visible).toBe(true);
    app.clock.advance(1); await app.render();

    expect(app.stack.root.visible).toBe(false); expect(app.opened).toEqual([]); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally { await app.close(); }
});

test("닫기와 카드 클릭을 구분하고 카드 바깥의 입력을 가로채지 않는다", async () => {
  // The overlay has no full-screen backdrop and its close control is not a focus target.
  const app = await fixture();
  try {
    app.stack.show(notification("one")); await app.render();
    const close = app.get("dismiss-toast:one"); await app.mockMouse.click(close.x, close.y); await app.render();
    expect(app.stack.root.visible).toBe(false); expect(app.opened).toEqual([]); expect(app.renderer.currentFocusedRenderable).toBe(app.input);

    app.stack.show(notification("two")); await app.render();
    await app.mockMouse.click(2, 0); await app.mockInput.typeText("keep typing"); await app.render();
    expect(app.input.value).toBe("keep typing");
    const card = app.get("session-toast:two"); await app.mockMouse.click(card.x + 2, card.y + 2); await app.render();

    expect(app.opened).toEqual(["two"]); expect(app.stack.root.visible).toBe(false);
  } finally { await app.close(); }
});

test("작은 화면에 맞게 쌓임 수와 너비를 줄이고 제어문자가 포함된 긴 요약을 안전하게 줄인다", async () => {
  // Narrow terminals cannot fit three five-row cards; summaries can contain untrusted terminal controls.
  const app = await fixture(), item = notification("one");
  try {
    app.stack.show({ ...item, result: { ...item.result, request: { text: "\x1b[31m작업\x1b[0m\n\x07 " + "긴요약".repeat(100), images: 0, files: 0 } } });
    app.stack.show(notification("two")); app.stack.show(notification("three"));
    app.resize(30, 12); app.clock.advance(160); await app.render();

    const card = app.get("session-toast:one"), frame = app.captureCharFrame();
    expect(card.x).toBeGreaterThanOrEqual(0); expect(card.x + card.width).toBeLessThanOrEqual(30);
    expect(card.y + card.height).toBeLessThanOrEqual(12); expect(frame).toContain("작업"); expect(frame).toContain("…");
    expect(frame).not.toContain("Task two"); expect(frame).not.toContain("\x1b"); expect(frame).not.toContain("\x07");
    app.resize(100, 24); await app.render();
    expect(app.captureCharFrame()).toContain("Task two"); expect(app.captureCharFrame()).toContain("Task three");
  } finally { await app.close(); }
});

test("닫힌 세션의 대기·표시 알림을 제거하고 파괴 시 타이머를 해제한다", async () => {
  // Closing a session or destroying the owner must prevent delayed cards and animation callbacks.
  const app = await fixture();
  try {
    for (const id of ["one", "two", "three", "four"]) app.stack.show(notification(id));
    app.stack.retain(new Set(["two"])); await app.render();
    expect(app.captureCharFrame()).toContain("Task two"); expect(app.captureCharFrame()).not.toContain("Task one");

    app.stack.root.destroyRecursively(); app.stack.dispose(); app.clock.advance(30000); await app.render();

    expect(app.renderer.root.findDescendantById("session-notifications")).toBeUndefined(); expect(app.opened).toEqual([]);
  } finally { await app.close(); }
});
