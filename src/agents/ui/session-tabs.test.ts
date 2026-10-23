import { expect, test } from "bun:test";
import { TextAttributes, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Button } from "../../ui/button.ts";
import { uiTheme, type UiColors } from "../../ui/theme.ts";
import { SESSION_TAB_WIDTH } from "../../ui/session-tab.ts";
import type { OpenSession } from "../model.ts";
import type { SessionResult } from "../session-attention.ts";
import { icons, spinnerFrames } from "../../icons.ts";
import { SessionTabs } from "./session-tabs.ts";

const firstId = "01a156a2-ba64-707c-bd92-fc877962e972";
const secondId = "23ec1867-d98a-4d41-b656-d2c13806b5de";
const firstLabel = "01a156a2-…";
const secondLabel = "23ec1867-…";
const collisionId = "01a156a2-ba65-4d41-b656-d2c13806b5de";
const session = (id = firstId, name = "A conversation title, not the session ID"): OpenSession => ({ id, name, status: "complete", subagents: [] });

async function mount(initial: readonly OpenSession[] = [session()], fast: (id: string) => boolean = () => false) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 100, height: 6, kittyKeyboard: true, clock });
  const selected: string[] = [], closed: string[] = [];
  const tabs = new SessionTabs(app.renderer, { select: (id) => selected.push(id), close: (id) => closed.push(id),
    fast, create() {}, changed() {}, keyHint: () => "", button: (label, activate) => new Button(app.renderer, label, activate) });
  app.renderer.root.add(tabs.root);
  tabs.update("tree", initial, initial[0]?.id ?? null, true);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  const get = (id: string, worktreeId = "tree") => {
    const tab = app.renderer.root.findDescendantById(`session:${worktreeId}:${id}`);
    if (!tab) throw new Error(`Missing tab ${id}`);
    const title = app.renderer.root.findDescendantById(`${tab.id}:title`);
    const number = app.renderer.root.findDescendantById(`${tab.id}:number`);
    if (!(title instanceof TextRenderable) || !(number instanceof TextRenderable)) throw new Error(`Missing tab label ${id}`);
    return { tab, title, number };
  };
  const status = (id = firstId) => {
    const { tab, title, number } = get(id);
    return app.captureCharFrame().split("\n")[tab.y]!.slice(number.x + number.width, title.x).trim();
  };
  return { ...app, tabs, selected, closed, get, status, render,
    clock,
    async close() { tabs.dispose(); await app.dispose(); },
  };
}

const completed: SessionResult = { id: "completed", outcome: "complete", completedAt: 1000 };
const failed: SessionResult = { id: "failed", outcome: "error", completedAt: 1000 };
const stopped: SessionResult = { id: "stopped", outcome: "unfinished", completedAt: 1000 };
const cancelled: SessionResult = { id: "cancelled", outcome: "cancelled", completedAt: 1000 };
const priorities = [
  { name: "active-run spinners over earlier unread bells", entry: { ...session(), status: "working", attention: completed }, glyph: "working", color: "accent" },
  { name: "active-child spinners over failures, interruptions, and bells", entry: { ...session(), status: "failure", result: stopped, attention: stopped,
    subagents: [{ id: "busy", name: "Busy", status: "working" }, { id: "failed", name: "Failed", status: "failure" }] }, glyph: "working", color: "accent" },
  { name: "failure exclamation circles over unread bells", entry: { ...session(), status: "failure", result: failed, attention: failed }, glyph: "\uF06A", color: "error" },
  { name: "failure exclamation circles despite unknown status", entry: { ...session(), status: null, result: failed }, glyph: "\uF06A", color: "error" },
  { name: "child-failure exclamation circles over interruptions and bells", entry: { ...session(), status: null, result: stopped, attention: stopped,
    subagents: [{ id: "failed", name: "Failed", status: "failure" }] }, glyph: "\uF06A", color: "error" },
  { name: "interruption question marks over unread bells", entry: { ...session(), status: null, result: stopped, attention: stopped }, glyph: "?", color: "error" },
  { name: "unread completion bells without checks", entry: { ...session(), result: completed, attention: completed }, glyph: "\uF0F3", color: "attention" },
  { name: "unread unknown-cause cancellation bells", entry: { ...session(), status: null, result: cancelled, attention: cancelled }, glyph: "\uF0F3", color: "attention" },
  { name: "acknowledged completion checks", entry: { ...session(), result: completed }, glyph: icons.pass, color: "success" },
  { name: "acknowledged cancellation dots", entry: { ...session(), status: null, result: cancelled }, glyph: "●", color: "muted" },
  { name: "direct cancellation dots", entry: { ...session(), status: null, result: { ...cancelled, cancellation: "user" } }, glyph: "●", color: "muted" },
  { name: "lifecycle cancellation dots", entry: { ...session(), status: null, result: { ...cancelled, cancellation: "lifecycle" } }, glyph: "●", color: "muted" },
  { name: "no icon for complete status without outcomes", entry: session(), glyph: "", color: "muted" },
  { name: "no icon without status or outcomes", entry: { ...session(), status: null }, glyph: "", color: "muted" },
] satisfies { name: string; entry: OpenSession; glyph: string; color: keyof UiColors }[];

test.each(priorities)("Show only $name in one cell", async ({ entry, glyph, color }) => {
  // Multiple execution and unread conditions must compete for one status cell, not add badges.
  const app = await mount([entry]);
  try {
    // Public snapshots determine the badge without selecting or acknowledging the session.
    const { tab, title } = app.get(firstId);
    const prefix = app.status();

    // Glyph, semantic color and reserved width must agree, including the genuinely empty state.
    if (glyph === "working") expect(spinnerFrames.some(frame => frame === prefix)).toBe(true);
    else expect(prefix).toBe(glyph);
    if (glyph) {
      const span = app.captureSpans().lines[tab.y]!.spans.find(span => span.text.includes(prefix))!;
      expect(span.fg.toInts()).toEqual(uiTheme(app.renderer).colors[color].toInts());
    }
    expect(Bun.stringWidth(prefix)).toBe(glyph ? 1 : 0);
    expect(title.x - tab.x).toBe(glyph ? 7 : 5);
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("Only Fast tabs use yellow three-cell arrows and retain tab/close positions across frames and modes", async () => {
  // The two running tabs observe independent session-local Fast settings.
  const entries = [{ ...session(), status: "working" as const }, { ...session(secondId), status: "working" as const }];
  let fast = true;
  const app = await mount(entries, id => id === firstId && fast);
  const prefix = app.status;
  try {
    const { tab, title } = app.get(firstId), other = app.get(secondId).tab;
    const close = app.renderer.root.findDescendantById(`close-session:${firstId}`)!;
    const geometry = [tab.x, tab.width, title.x, close.x, other.x];
    expect(prefix(firstId)).toBe("▶▷▷"); expect(title.x).toBe(tab.x + 9);
    expect(prefix(secondId)).toBe("⠋"); expect(tab.width).toBe(SESSION_TAB_WIDTH);
    const spans = app.captureSpans().lines[tab.y]!.spans;
    expect(spans.find(span => span.text.includes("▶"))!.fg.toInts()).toEqual(uiTheme(app.renderer).colors.number.toInts());

    // Arrow movement never changes the reserved three cells or shifts the close button and next tab.
    app.clock.advance(80); await app.render();

    expect(prefix(firstId)).toBe("▷▶▷"); expect([tab.x, tab.width, title.x, close.x, other.x]).toEqual(geometry);
    expect(prefix(secondId)).toBe("⠙");
    fast = false; app.tabs.update("tree", entries, firstId, true); await app.render();
    expect(prefix(firstId)).toBe("⠋"); expect(title.x).toBe(tab.x + 7);
    expect([tab.width, close.x, other.x]).toEqual([geometry[1]!, geometry[3]!, geometry[4]!]);
    fast = true; app.tabs.update("tree", entries, firstId, true); app.resize(12, 6); await app.render();
    expect(Bun.stringWidth(title.plainText)).toBeLessThanOrEqual(title.width);
    expect(close.x + close.width).toBeLessThanOrEqual(app.tabs.list.viewport.x + app.tabs.list.viewport.width);
    app.tabs.update("tree", entries, firstId, false); await app.render(); expect(app.clock.pendingTimerCount).toBe(0);
  } finally { await app.close(); }
});

test.each([completed, failed, stopped, cancelled])("Fast $outcome results never overlap spinners or reappear after acknowledgement", async result => {
  // Settling before 500 ms must neither show two icons nor revive loading after acknowledgement.
  const app = await mount([{ ...session(), status: "working", attention: completed }]);
  const glyph = result.outcome === "error" ? "\uF06A" : result.outcome === "unfinished" ? "?" : icons.bell;
  const readGlyph = result.outcome === "complete" ? icons.pass : result.outcome === "cancelled" ? "●" : glyph;
  const finished: OpenSession = { ...session(), status: result.outcome === "error" ? "failure" : result.outcome === "complete" ? "complete" : null, result, attention: result };
  const prefix = app.status;
  try {
    app.clock.advance(120); app.tabs.update("tree", [finished], firstId, true); await app.render();
    expect(prefix()).toBe(glyph);

    // Acknowledgement reveals success/cancellation while failure and stopped badges stay visible.
    const { attention: _attention, ...read } = finished;
    app.tabs.update("tree", [read], firstId, true); await app.render();
    expect(prefix()).toBe(readGlyph);
    app.clock.advance(380); await app.render();

    expect(prefix()).toBe(readGlyph);
    expect(read.result).toBe(result); expect(finished.attention).toBe(result);
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test.each([false, true])("Direct cancellation of Fast %s runs retains gray dots instead of spinners", async fast => {
  // A user cancellation has no new unread result, even if it settles before the spinner minimum.
  const app = await mount([{ ...session(), status: "working" }], () => fast);
  const interrupted: OpenSession = { ...session(), status: null, result: { ...cancelled, cancellation: "user" } };
  const prefix = app.status;
  try {
    // Normal and Fast loading both yield their entire animation slot immediately to the settled badge.
    app.clock.advance(120); app.tabs.update("tree", [interrupted], firstId, true); await app.render();

    expect(prefix()).toBe("●");
    const { tab, title } = app.get(firstId);
    expect(title.x).toBe(tab.x + 7);
    const dot = app.captureSpans().lines[tab.y]!.spans.find(span => span.text.includes("●"))!;
    expect(dot.fg.toInts()).toEqual(uiTheme(app.renderer).colors.muted.toInts());
    expect(app.clock.pendingTimerCount).toBe(0);

    // Late timer ticks and hiding the screen cannot erase the dot or restore the old spinner.
    app.clock.advance(380); await app.render(); expect(prefix()).toBe("●");
    app.tabs.update("tree", [interrupted], firstId, false); await app.render();
    app.tabs.update("tree", [interrupted], firstId, true); await app.render();
    expect(prefix()).toBe("●"); expect(app.clock.pendingTimerCount).toBe(0);
  } finally { await app.close(); }
});

test("Unread bells hidden during execution survive return and direct cancellation", async () => {
  // Priority changes presentation only; restarting and hiding a busy tab must retain its unread result.
  const pending: OpenSession = { ...session(), result: completed, attention: completed };
  const working: OpenSession = { ...session(), status: "working", attention: completed };
  const app = await mount([pending]);
  const prefix = app.status;
  try {
    expect(prefix()).toBe(icons.bell);
    app.tabs.update("tree", [working], firstId, true); await app.render();
    expect(spinnerFrames.some(frame => frame === prefix())).toBe(true);
    app.tabs.update("tree", [working], firstId, false); app.clock.advance(500);
    app.tabs.update("tree", [working], firstId, true); await app.render();
    expect(spinnerFrames.some(frame => frame === prefix())).toBe(true);

    // Intentional cancellation adds no unread result, so the previously hidden bell must reappear alone.
    const interrupted: OpenSession = { ...working, status: null, result: { ...cancelled, cancellation: "user" } };
    app.tabs.update("tree", [interrupted], firstId, true); await app.render();

    expect(prefix()).toBe(icons.bell); expect(interrupted.attention).toBe(completed);
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("Tabs without status icons reclaim status slots and spacing for IDs", async () => {
  const unknown = { ...session(), status: null }, app = await mount([unknown]);
  try {
    // Missing status frees two more cells for UUIDs even in narrow tabs.
    app.resize(12, 6); await app.render();
    const { tab, title } = app.get(firstId), close = app.renderer.root.findDescendantById(`close-session:${firstId}`)!;
    expect(title.x).toBe(tab.x + 5); expect(title.plainText).toBe("01a…");
    expect(tab.width).toBe(12);
    expect(close.x).toBe(title.x + title.width + 1); expect(close.x + close.width).toBe(tab.x + tab.width - 1);

    // An unread completion reserves a badge; acknowledging it replaces the bell with a success check.
    app.tabs.update("tree", [{ ...session(), result: completed, attention: completed }], firstId, true); await app.render();
    expect(title.x).toBe(tab.x + 7); expect(title.plainText).toEndWith("…");
    expect(close.x + close.width).toBeLessThanOrEqual(app.tabs.list.viewport.x + app.tabs.list.viewport.width);
    app.tabs.update("tree", [{ ...session(), result: completed }], firstId, true); await app.render();
    expect(app.captureCharFrame()).toContain(icons.pass); expect(title.x).toBe(tab.x + 7);

    // Only a snapshot with no result removes the badge and restores the extra UUID space.
    app.tabs.update("tree", [unknown], firstId, true); await app.render();
    expect(title.x).toBe(tab.x + 5); expect(title.plainText).toBe("01a…");
  } finally { await app.close(); }
});

test("Unknown tabs remove status slots after spinner minimums and restore UUID space", async () => {
  const working = { ...session(), status: "working" as const }, app = await mount([working]);
  try {
    app.resize(12, 6); await app.render(); const { tab, title } = app.get(firstId);
    app.clock.advance(120); app.tabs.update("tree", [{ ...working, status: null }], firstId, true); await app.render();
    const width = tab.width, titleX = title.x;
    app.clock.advance(379); await app.render(); expect(title.x).toBe(titleX); expect(title.plainText).toEndWith("…");
    // Spinner completion reveals two more UUID prefix cells without another snapshot.
    app.clock.advance(1); await app.render();
    expect(title.x).toBe(tab.x + 5); expect(title.plainText).toBe("01a…");
    expect(tab.width).toBe(width); expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("Returning to unknown tabs never reserves space for cancelled spinners", async () => {
  const working = { ...session(), status: "working" as const }, unknown = { ...working, status: null }, app = await mount([working]);
  try {
    app.clock.advance(120); app.tabs.update("tree", [unknown], firstId, true); await app.render();
    app.tabs.update("tree", [unknown], firstId, false); app.clock.advance(500);
    app.tabs.update("tree", [unknown], firstId, true); await app.render();
    const { tab, title } = app.get(firstId);
    expect(title.x).toBe(tab.x + 5); expect(title.plainText).toBe(firstLabel);
    expect(tab.width).toBe(SESSION_TAB_WIDTH);
  } finally { await app.close(); }
});

test("Earlier tabs gaining status slots keep selected IDs and close buttons visible", async () => {
  const entries = [{ ...session("short"), status: null }, session(secondId)], app = await mount(entries);
  try {
    app.resize(20, 6); app.tabs.update("tree", entries, secondId, true); await app.render();
    app.tabs.update("tree", [{ ...entries[0]!, status: "working" }, entries[1]!], secondId, true); await app.render();
    const { tab } = app.get(secondId), close = app.renderer.root.findDescendantById(`close-session:${secondId}`)!;
    expect(tab.x).toBeGreaterThanOrEqual(app.tabs.list.viewport.x);
    expect(close.x + close.width).toBeLessThanOrEqual(app.tabs.list.viewport.x + app.tabs.list.viewport.width);
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("Agent tabs distinguish focus and selection using backgrounds, never underlines", async () => {
  // Prepare two sessions using real strip focus and selection metadata.
  const entries = [session(), session(secondId)], app = await mount(entries);
  const cell = (id: string) => {
    const title = app.get(id).title; let x = 0;
    return app.captureSpans().lines[title.y]!.spans.find((span) => { x += span.width; return x > title.x; })!;
  };
  try {
    app.tabs.list.focus(); await app.render();

    const colors = uiTheme(app.renderer).colors;
    expect(cell(firstId).bg.toInts()).toEqual(colors.selected.toInts());
    expect(cell(firstId).attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(cell(firstId).attributes & TextAttributes.BOLD).not.toBe(0);
    expect(cell(secondId).bg.toInts()).toEqual(colors.panel.toInts());

    // Navigation moves only backgrounds and still emits existing selection events.
    app.tabs.command("session.next"); app.tabs.update("tree", entries, secondId, true); await app.render();
    expect(app.selected).toEqual([secondId]); expect(cell(firstId).bg.toInts()).toEqual(colors.panel.toInts());
    expect(cell(secondId).bg.toInts()).toEqual(colors.selected.toInts());
    expect(cell(firstId).attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(cell(secondId).attributes & TextAttributes.UNDERLINE).toBe(0);

    // Leaving strip focus must not restore underlines on selected sessions.
    const outside = new Button(app.renderer, "Outside", () => {}); app.renderer.root.add(outside);
    outside.focus(); await app.render();
    expect(cell(secondId).bg.toInts()).toEqual(colors.surface.toInts());
    expect(cell(secondId).attributes & TextAttributes.UNDERLINE).toBe(0); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("AI tabs use full UUID labels with only fixed-width tail truncation", async () => {
  // Full UUIDs are label sources, not names or arbitrary eight-character prefixes.
  const entry = session(), app = await mount([entry]);
  try {
    // Preserve the shared 18-cell frame even on large screens.
    await app.render();

    // Append one ellipsis after the visible prefix and preserve source metadata.
    expect(app.get(firstId).title.plainText).toBe(firstLabel);
    expect(app.get(firstId).tab.width).toBe(18);
    expect(app.captureCharFrame()).toContain(firstLabel);
    expect(app.captureCharFrame()).not.toContain(firstId);
    expect(app.captureCharFrame()).not.toContain(entry.name);
    expect(entry.id).toBe(firstId);
    expect(entry.name).toBe("A conversation title, not the session ID");
  } finally { await app.close(); }
});

test("UUID labels truncate at available width and restore visible prefixes when expanded", async () => {
  const app = await mount();
  try {
    // Compact layouts retain original UUIDs and use only available frame width.
    for (const [width, expected] of [[12, "01a…"], [10, "0…"], [100, firstLabel]] as const) {
      app.resize(width, 6); await app.render();
      const { tab, title } = app.get(firstId), text = title.plainText;

      // Show continuous UUID prefixes without synthesizing middle or trailing identifiers.
      expect(text).toBe(expected); expect(text.match(/…/g)).toHaveLength(1);
      expect(firstId.startsWith(text.slice(0, -1))).toBe(true);
      expect(Bun.stringWidth(text)).toBeLessThanOrEqual(title.width);

      // Status and close controls stay inside the viewport instead of forcing the label to hide them.
      const close = app.renderer.root.findDescendantById(`close-session:${firstId}`)!;
      expect(tab.width).toBeLessThanOrEqual(app.tabs.list.width);
      expect(close.x + close.width).toBeLessThanOrEqual(app.tabs.list.x + app.tabs.list.width);
    }
  } finally { await app.close(); }
});

test.each([
  { id: "01a156a2-ca64-707c-bd92-fc877962e972", first: firstLabel, other: firstLabel },
  { id: collisionId, first: firstLabel, other: firstLabel },
  { id: "01a156a2-ba64-707c-bd92-fc877962e973", first: firstLabel, other: firstLabel },
])("Overlapping-prefix $id tabs use identical UUID tail-truncation rules", async ({ id, first, other }) => {
  // Prepare pairs diverging anywhere from just after eight characters to the final character.
  const app = await mount([session(), session(id)]);
  try {
    // Display both sessions in the same worktree.
    await app.render();

    // Neighboring sessions must not alter prefixes or append UUID suffixes after ellipses.
    expect(app.get(firstId).title.plainText).toBe(first);
    expect(app.get(id).title.plainText).toBe(other);
    expect(app.captureCharFrame()).toContain(first);
    expect(app.captureCharFrame()).toContain(other);
  } finally { await app.close(); }
});

test("Adding and removing similar UUID tabs preserves labels, widths, and selected-tab visibility", async () => {
  // UUID display length follows shared frame width, not neighboring tabs.
  const entries = [session(), session(secondId)], app = await mount(entries);
  try {
    app.resize(28, 6); app.tabs.update("tree", entries, secondId, true); await app.render();
    const firstTab = app.get(firstId).tab;

    // Add an overlapping-prefix tab while preserving another session's selection.
    app.tabs.update("tree", [...entries, session(collisionId)], secondId, true); await app.render();

    // Retain instances and UUID labels while revealing the selected tab again.
    expect(app.get(firstId).tab).toBe(firstTab);
    expect(app.get(firstId).title.plainText).toBe(firstLabel);
    expect(app.get(collisionId).title.plainText).toBe(firstLabel);
    expect(app.get(secondId).title.plainText).toBe(secondLabel);
    const selectedTab = app.get(secondId).tab, viewport = app.tabs.list.viewport;
    expect(selectedTab.x).toBeGreaterThanOrEqual(viewport.x);
    expect(selectedTab.x + selectedTab.width).toBeLessThanOrEqual(viewport.x + viewport.width);

    // Closing another tab never changes the displayed UUID length.
    app.tabs.update("tree", entries, secondId, true); await app.render();
    expect(app.get(firstId).title.plainText).toBe(firstLabel);
    expect(app.get(secondId).title.plainText).toBe(secondLabel);
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("Worktree switching shows identical UUID labels at identical frame widths", async () => {
  // Showing a session alone in another worktree must not shorten its label.
  const app = await mount([session(), session(collisionId)]);
  try {
    // Display only one of the sessions in the other worktree.
    app.tabs.update("other-tree", [session(collisionId)], collisionId, true); await app.render();

    // Show the same full-UUID prefix regardless of session count.
    expect(app.get(collisionId, "other-tree").title.plainText).toBe(firstLabel);
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test.each(["a1", "12345678", "1234567890"])("%s session IDs fitting available width display fully without ellipses", async id => {
  // Existing short IDs need neither padding nor renaming.
  const app = await mount([session(id)]);
  try {
    // Exact-width IDs must not receive unnecessary ellipses.
    await app.render();

    // The original ID remains visible unchanged.
    expect(app.get(id).title.plainText).toBe(id);
  } finally { await app.close(); }
});

test("Tabs after the ninth show numbers and renumber by current order after close, reorder, or worktree changes", async () => {
  // Numbers reflect current worktree display order, not digits in IDs.
  const entries = Array.from({ length: 11 }, (_, index) => session(`session-${index + 20}`));
  const app = await mount(entries);
  try {
    // Horizontally scrolled final tabs show two-digit numbers separately from titles.
    app.resize(30, 6); app.tabs.update("tree", entries, entries[10]!.id, true); await app.render();

    const last = app.get(entries[10]!.id);
    expect(last.number.plainText).toBe("11."); expect(last.title.plainText).toBe("session-…");
    expect(last.tab.x).toBeGreaterThanOrEqual(app.tabs.list.viewport.x);
    expect(last.tab.x + last.tab.width).toBeLessThanOrEqual(app.tabs.list.viewport.x + app.tabs.list.viewport.width);

    // Closing earlier tabs and reordering preserve IDs and instances.
    const reordered = [entries[10]!, ...entries.slice(1, 10)];
    app.tabs.update("tree", reordered, entries[10]!.id, true); await app.render();

    expect(app.get(entries[10]!.id).tab).toBe(last.tab);
    expect(app.get(entries[10]!.id).number.plainText).toBe("1.");
    expect(app.get(entries[1]!.id).number.plainText).toBe("2.");
    expect(app.get(entries[9]!.id).number.plainText).toBe("10.");
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);

    // The first tab in another worktree does not inherit previous numbering.
    app.tabs.update("other-tree", [entries[9]!], entries[9]!.id, true); await app.render();
    expect(app.get(entries[9]!.id, "other-tree").number.plainText).toBe("1.");
  } finally { await app.close(); }
});

test("Identically truncated UUID tabs select and close using their full unique IDs", async () => {
  // Prepare UUIDs with identical visible prefixes and different final characters.
  const otherId = "01a156a2-ba64-707c-bd92-fc877962e973";
  const entries = [session(), session(otherId, "Other conversation")], app = await mount(entries);
  try {
    // Renaming and keyboard selection preserve identical tail-truncation rules.
    const renamed = entries.map((entry) => ({ ...entry, name: "Renamed conversation" }));
    app.tabs.update("tree", renamed, firstId, true);
    app.tabs.command("session.next");
    app.tabs.update("tree", renamed, otherId, true);
    app.resize(32, 6); await app.render();
    expect(app.get(firstId).title.plainText).toBe(firstLabel);
    expect(app.get(otherId).title.plainText).toBe(firstLabel);
    const close = app.renderer.root.findDescendantById(`close-session:${otherId}`)!;
    expect(close.x).toBeGreaterThanOrEqual(app.tabs.list.viewport.x);
    expect(close.x + close.width).toBeLessThanOrEqual(app.tabs.list.viewport.x + app.tabs.list.viewport.width);
    await app.mockMouse.click(close.x, close.y); await app.render();

    // Close by unique UUID, not identical display strings, preserving original metadata.
    expect(app.selected).toEqual([otherId]); expect(app.closed).toEqual([otherId]);
    expect(app.captureCharFrame()).not.toContain("Renamed conversation");
    expect(renamed.map((entry) => entry.id)).toEqual([firstId, otherId]);

    // Clicking the first title never confuses the other UUID.
    app.tabs.update("tree", renamed, firstId, true); await app.render();
    const { tab, title } = app.get(firstId);
    expect(tab.x).toBe(app.tabs.list.viewport.x);
    await app.mockMouse.click(title.x, title.y); await app.render();
    expect(app.selected).toEqual([otherId, firstId]);
  } finally { await app.close(); }
});
