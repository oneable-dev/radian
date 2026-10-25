import { expect, test } from "bun:test";
import { BoxRenderable, InputRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import type { SessionNotification } from "../session-notification.ts";
import type { SessionResult } from "../session-attention.ts";
import { SessionNotificationStack } from "./session-notifications.ts";
import { uiTheme } from "../../ui/theme.ts";
import { icons } from "../../icons.ts";
import type { Message } from "../../ui/messages.ts";

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

test.each(["complete", "error", "unfinished", "cancelled"] as const)("New %s notifications show status colors, summaries, and icon-labeled worktrees/branches without stealing focus", async outcome => {
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

test.each([false, true])("Light theme %s masks notification bodies without recoloring the border-cell underlay", async light => {
  // A colored code surface behind a card must not be replaced by a fringe outside its thin border.
  const app = await fixture(), theme = uiTheme(app.renderer);
  const palette = { palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
    highlightForeground: null, highlightBackground: null };
  const normal = light ? "#F1F2F3" : "#182028";
  const underlay = new BoxRenderable(app.renderer, { position: "absolute", top: 1, width: 100, height: 23, backgroundColor: "#456789" });
  underlay.add(new TextRenderable(app.renderer, { content: Array.from({ length: 23 }, () => "UNDERLAY".repeat(14)).join("\n"), width: 100 }));
  app.renderer.root.add(underlay, 0);
  const background = (x: number, y: number) => {
    let column = 0;
    return app.captureSpans().lines[y]!.spans.find(span => { column += span.width; return column > x; })!.bg;
  };
  try {
    theme.configure(palette, { styles: { "ui.text": { bg: normal } } });

    // The existing fade and line glyphs still replace covered text instead of overlapping it.
    app.stack.show(notification("edge"));
    const borderColors: number[][] = [];
    for (const advance of [80, 80]) {
      app.clock.advance(advance); await app.render();
      const card = app.get("session-toast:edge"), lines = app.captureCharFrame().split("\n");
      expect(lines[card.y]!.slice(card.x, card.x + card.width)).toBe("┌" + "─".repeat(card.width - 2) + "┐");
      for (let y = card.y; y < card.y + card.height; y++) expect(lines[y]!.slice(card.x, card.x + card.width)).not.toContain("UNDERLAY");
      let column = 0;
      borderColors.push(app.captureSpans().lines[card.y]!.spans.find(span => { column += span.width; return column > card.x; })!.fg.toInts());
    }
    expect(borderColors[0]).not.toEqual(borderColors[1]);
    expect(borderColors[1]).toEqual(theme.styles["status.success"].fg.toInts());

    // The body masks covered text, while edge cells preserve the surrounding code background.
    const card = app.get("session-toast:edge"), geometry = [card.x, card.y, card.width, card.height];
    for (const y of [card.y, card.y + 2, card.y + card.height - 1]) {
      expect(background(card.x, y).toInts()).toEqual(background(card.x - 1, y).toInts());
      expect(background(card.x + card.width - 1, y).toInts()).toEqual(background(card.x + card.width, y).toInts());
    }
    expect(background(card.x + 1, card.y + 1).toInts()).toEqual(theme.styles["ui.text"].bg!.toInts());
    const outside = background(card.x - 1, card.y).toInts();

    // Explicit body overrides keep the same thin border and do not change its underlay or focus.
    theme.configure(palette, { styles: { "ui.text": { bg: normal }, "ui.popup": { bg: light ? "#DDEEFF" : "#112233" } } }); await app.render();
    expect(background(card.x, card.y).toInts()).toEqual(outside);
    expect(background(card.x + 1, card.y + 1).toInts()).toEqual(theme.styles["ui.popup"].bg!.toInts());
    expect(background(card.x - 1, card.y).toInts()).toEqual(outside);
    expect([card.x, card.y, card.width, card.height]).toEqual(geometry);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.opened).toEqual([]);
  } finally { await app.close(); }
});

test.each([
  ["success", "Completed", 5000], ["warning", "Warning", 8000], ["error", "Failed", 8000],
] as const)("General %s notifications share the result card's status, summary, and context rows", async (level, label, lifetime) => {
  // Both kinds of notification arrive while the same input retains keyboard ownership.
  const app = await fixture();
  const message: Message = { id: "message", timestamp: 0, level, source: "Clipboard", text: "Operation summary" };
  try {
    // Mixing a general notice with a result must not change their visual hierarchy.
    app.stack.show(message); app.stack.show(notification("result")); app.clock.advance(160); await app.render();

    // General notices reserve their last row for source, just as results do for checkout context.
    const card = app.get("session-toast:message"), resultCard = app.get("session-toast:result"), lines = app.captureCharFrame().split("\n");
    const rows = lines.slice(card.y + 1, card.y + 4).map(line => line.slice(card.x + 2, card.x + card.width - 2).trim());
    expect(rows).toEqual([label, "Operation summary", "Clipboard"]);
    expect(card.height).toBe(resultCard.height); expect(card.width).toBe(resultCard.width);
    let x = 0; const border = app.captureSpans().lines[card.y]!.spans.find(span => { x += span.width; return x > card.x; })!;
    expect(border.fg.toInts()).toEqual(uiTheme(app.renderer).styles[`status.${level}`].fg.toInts());
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.opened).toEqual([]);
    app.clock.advance(lifetime - 161); await app.render(); expect(app.renderer.root.findDescendantById("session-toast:message")).toBeDefined();
    app.clock.advance(1); await app.render(); expect(app.renderer.root.findDescendantById("session-toast:message")).toBeUndefined();
  } finally { await app.close(); }
});

test("General notification rows safely truncate Unicode previews and sources through resize", async () => {
  // Long diagnostics must leave the source visible without expanding the compact card.
  const app = await fixture();
  const message: Message = { id: "long", timestamp: 0, level: "warning", title: "Custom warning",
    source: "\x1b[36mEditor\x1b[0m\n" + "checkout-".repeat(20), text: "\x1b[31m한글 👩🏽‍💻\x1b[0m\n\x07 " + "긴요약".repeat(100) };
  try {
    // Shrinking and restoring the terminal must keep all three rows in the same order.
    app.stack.show(message); app.clock.advance(160);
    for (const width of [100, 30, 100]) {
      app.resize(width, 24); await app.render();

      // Only the summary and context are shortened; the source never moves into the heading or body.
      const card = app.get("session-toast:long"), frame = app.captureCharFrame(), lines = frame.split("\n");
      expect(lines[card.y + 1]).toContain("Custom warning"); expect(lines[card.y + 1]).not.toContain("Editor");
      expect(lines[card.y + 2]).toContain("한글 👩🏽‍💻"); expect(lines[card.y + 2]).toContain("…");
      expect(lines[card.y + 3]).toContain("Editor checkout-"); expect(lines[card.y + 3]).toContain("…");
      expect(frame).not.toContain("\x1b"); expect(frame).not.toContain("\x07");
      expect(card.height).toBe(5); expect(card.x + card.width).toBeLessThanOrEqual(width);
    }
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally { await app.close(); }
});

test("Branchless notifications distinguish worktrees from detached HEAD through icons", async () => {
  // A detached checkout has no branch name to display.
  const app = await fixture();
  try {
    // The same card presentation must handle detached HEAD without inventing a branch.
    app.stack.show({ ...notification("detached"), branch: null }); app.clock.advance(160); await app.render();

    // The checkout remains identifiable and the missing branch is explicit.
    expect(app.captureCharFrame()).toContain(`${icons.folder} auth-checkout / ${icons.branch} detached HEAD`);
  } finally { await app.close(); }
});

test("At most three notifications stack and queued failures receive eight seconds after display", async () => {
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

test("Notifications expire without close buttons and never intercept input outside cards", async () => {
  // Automatic expiry preserves focus without manual dismissal controls.
  const app = await fixture();
  try {
    app.stack.show(notification("one")); await app.render();
    expect(app.renderer.root.findDescendantById("dismiss-toast:one")).toBeUndefined();
    expect(app.captureCharFrame()).not.toContain("×");
    app.clock.advance(5000); await app.render();
    expect(app.stack.root.visible).toBe(false); expect(app.opened).toEqual([]); expect(app.renderer.currentFocusedRenderable).toBe(app.input);

    app.stack.show(notification("two")); await app.render();
    await app.mockMouse.click(2, 0); await app.mockInput.typeText("keep typing"); await app.render();
    expect(app.input.value).toBe("keep typing");
    const card = app.get("session-toast:two"); await app.mockMouse.click(card.x + 2, card.y + 2); await app.render();

    expect(app.opened).toEqual(["two"]); expect(app.stack.root.visible).toBe(false);
  } finally { await app.close(); }
});

test("Compact screens reduce stack count and width while safely truncating summaries with control characters", async () => {
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

test("Closed sessions lose queued and visible notifications and disposal clears timers", async () => {
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
