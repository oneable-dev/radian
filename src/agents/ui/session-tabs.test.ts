import { expect, test } from "bun:test";
import { TextAttributes, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Button } from "../../ui/button.ts";
import { uiTheme } from "../../ui/theme.ts";
import type { OpenSession } from "../model.ts";
import { SessionTabs } from "./session-tabs.ts";

const firstId = "01a156a2-ba64-707c-bd92-fc877962e972";
const secondId = "23ec1867-d98a-4d41-b656-d2c13806b5de";
const session = (id = firstId, name = "A conversation title, not the session ID"): OpenSession => ({ id, name, status: "complete", subagents: [] });

async function mount(initial: readonly OpenSession[] = [session()]) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 100, height: 6, kittyKeyboard: true, clock });
  const selected: string[] = [], closed: string[] = [];
  const tabs = new SessionTabs(app.renderer, { select: (id) => selected.push(id), close: (id) => closed.push(id),
    create() {}, changed() {}, keyHint: () => "", button: (label, activate) => new Button(app.renderer, label, activate) });
  app.renderer.root.add(tabs.root);
  tabs.update("tree", initial, initial[0]?.id ?? null, true);
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  const get = (id: string) => {
    const tab = app.renderer.root.findDescendantById(`session:tree:${id}`);
    if (!tab) throw new Error(`Missing tab ${id}`);
    const title = tab.getChildren().find((node): node is TextRenderable => node instanceof TextRenderable);
    if (!title) throw new Error(`Missing tab title ${id}`);
    return { tab, title };
  };
  return { ...app, tabs, selected, closed, get, render,
    clock,
    async close() { tabs.dispose(); await app.dispose(); },
  };
}

test("상태 아이콘이 없는 탭은 왼쪽 상태 칸과 간격을 빼고 확보한 너비를 ID에 사용한다", async () => {
  const unknown = { ...session(), status: null }, app = await mount([unknown]);
  try {
    // A UUID fits in 40 columns only when the unused two-cell badge and its gap are reclaimed.
    app.resize(40, 6); await app.render();
    const { tab, title } = app.get(firstId), close = app.renderer.root.findDescendantById(`close-session:${firstId}`)!;
    expect(title.x).toBe(tab.x + 1); expect(title.plainText).toBe(firstId);
    expect(tab.width).toBe(Bun.stringWidth(firstId) + 4);
    expect(close.x).toBe(title.x + title.width + 1); expect(close.x + close.width).toBe(tab.x + tab.width - 1);

    // An unread result, not successful completion alone, restores the notification badge.
    app.tabs.update("tree", [{ ...session(), attention: { id: "unread", outcome: "complete", completedAt: 1000 } }], firstId, true); await app.render();
    expect(title.x).toBe(tab.x + 4); expect(title.plainText).toEndWith("…");
    expect(close.x + close.width).toBeLessThanOrEqual(app.tabs.list.viewport.x + app.tabs.list.viewport.width);
    app.tabs.update("tree", [unknown], firstId, true); await app.render();
    expect(title.x).toBe(tab.x + 1); expect(title.plainText).toBe(firstId);
  } finally { await app.close(); }
});

test("미확정으로 바뀐 탭은 스피너 최소 시간 뒤 상태 칸을 제거하고 전체 ID를 복원한다", async () => {
  const working = { ...session(), status: "working" as const }, app = await mount([working]);
  try {
    app.resize(40, 6); await app.render(); const { tab, title } = app.get(firstId);
    app.clock.advance(120); app.tabs.update("tree", [{ ...working, status: null }], firstId, true); await app.render();
    const width = tab.width, titleX = title.x;
    app.clock.advance(379); await app.render(); expect(title.x).toBe(titleX); expect(title.plainText).toEndWith("…");
    // The spinner tail ending is enough to reclaim the slot; no snapshot or focus event is required.
    app.clock.advance(1); await app.render();
    expect(title.x).toBe(tab.x + 1); expect(title.plainText).toBe(firstId);
    expect(tab.width).toBeLessThanOrEqual(width); expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("숨겼다가 돌아온 미확정 탭은 취소된 스피너 공간을 다시 예약하지 않는다", async () => {
  const working = { ...session(), status: "working" as const }, unknown = { ...working, status: null }, app = await mount([working]);
  try {
    app.clock.advance(120); app.tabs.update("tree", [unknown], firstId, true); await app.render();
    app.tabs.update("tree", [unknown], firstId, false); app.clock.advance(500);
    app.tabs.update("tree", [unknown], firstId, true); await app.render();
    const { tab, title } = app.get(firstId);
    expect(title.x).toBe(tab.x + 1); expect(title.plainText).toBe(firstId);
    expect(tab.width).toBe(Bun.stringWidth(firstId) + 4);
  } finally { await app.close(); }
});

test("앞선 탭의 상태 칸이 나타나도 선택한 탭의 ID와 닫기 버튼을 화면 안에 유지한다", async () => {
  const entries = [{ ...session("short"), status: null }, session(secondId)], app = await mount(entries);
  try {
    app.resize(40, 6); app.tabs.update("tree", entries, secondId, true); await app.render();
    app.tabs.update("tree", [{ ...entries[0]!, status: "working" }, entries[1]!], secondId, true); await app.render();
    const { tab } = app.get(secondId), close = app.renderer.root.findDescendantById(`close-session:${secondId}`)!;
    expect(tab.x).toBeGreaterThanOrEqual(app.tabs.list.viewport.x);
    expect(close.x + close.width).toBeLessThanOrEqual(app.tabs.list.viewport.x + app.tabs.list.viewport.width);
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("Agent 세션은 포커스·선택이 바뀌어도 밑줄 없이 배경으로만 활성 항목을 구분한다", async () => {
  // 두 세션을 준비하고 실제 strip 포커스와 선택 메타데이터를 사용한다.
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

    // 다음 세션으로 이동하면 배경만 옮기고 세션 선택 이벤트도 기존대로 전달한다.
    app.tabs.command("session.next"); app.tabs.update("tree", entries, secondId, true); await app.render();
    expect(app.selected).toEqual([secondId]); expect(cell(firstId).bg.toInts()).toEqual(colors.panel.toInts());
    expect(cell(secondId).bg.toInts()).toEqual(colors.selected.toInts());
    expect(cell(firstId).attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(cell(secondId).attributes & TextAttributes.UNDERLINE).toBe(0);

    // 포커스가 세션 줄을 떠나도 선택된 세션을 밑줄로 되돌리지 않는다.
    const outside = new Button(app.renderer, "Outside", () => {}); app.renderer.root.add(outside);
    outside.focus(); await app.render();
    expect(cell(secondId).bg.toInts()).toEqual(colors.surface.toInts());
    expect(cell(secondId).attributes & TextAttributes.UNDERLINE).toBe(0); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("충분히 넓은 탭에는 이름이나 고정 축약 없이 세션 ID 전체를 표시한다", async () => {
  // A normal UUID exceeds the old 24-cell cap, but fits comfortably in this strip.
  const entry = session(), app = await mount([entry]);
  try {
    await app.render();

    expect(app.get(firstId).title.plainText).toBe(firstId);
    expect(app.captureCharFrame()).toContain(firstId);
    expect(app.captureCharFrame()).not.toContain(entry.name);
    expect(app.get(firstId).title.plainText).not.toContain("…");
    expect(entry.name).toBe("A conversation title, not the session ID");
  } finally { await app.close(); }
});

test("공간이 부족할 때만 ID 끝을 말줄임하고 다시 넓히면 전체를 복원한다", async () => {
  const app = await mount();
  try {
    // Truncation follows the actual strip width, while preserving the leading ID characters.
    for (const width of [40, 24, 100]) {
      app.resize(width, 6); await app.render();
      const { tab, title } = app.get(firstId), text = title.plainText;
      if (width >= 40) expect(text).toBe(firstId);
      else {
        expect(text.endsWith("…")).toBe(true);
        expect(text.match(/…/g)).toHaveLength(1);
        expect(firstId.startsWith(text.slice(0, -1))).toBe(true);
        expect(Bun.stringWidth(text)).toBeLessThanOrEqual(width - 4);
      }

      // Status and close controls stay inside the viewport instead of forcing the label to hide them.
      const close = app.renderer.root.findDescendantById(`close-session:${firstId}`)!;
      expect(tab.width).toBeLessThanOrEqual(app.tabs.list.width);
      expect(close.x + close.width).toBeLessThanOrEqual(app.tabs.list.x + app.tabs.list.width);
    }
  } finally { await app.close(); }
});

test("세션 이름을 갱신해도 탭 라벨과 실제 선택·닫기 대상 ID를 바꾸지 않는다", async () => {
  const entries = [session(), session(secondId, "Other conversation")], app = await mount(entries);
  try {
    // Display names remain available to History, but never replace the tab's stable identity.
    const renamed = entries.map((entry) => ({ ...entry, name: "Renamed conversation" }));
    app.tabs.update("tree", renamed, firstId, true);
    app.tabs.command("session.next");
    app.tabs.update("tree", renamed, secondId, true);
    app.resize(32, 6); await app.render();
    const close = app.renderer.root.findDescendantById(`close-session:${secondId}`)!;
    expect(close.x).toBeGreaterThanOrEqual(app.tabs.list.viewport.x);
    expect(close.x + close.width).toBeLessThanOrEqual(app.tabs.list.viewport.x + app.tabs.list.viewport.width);
    await app.mockMouse.click(close.x, close.y); await app.render();

    expect(app.selected).toEqual([secondId]);
    expect(app.closed).toEqual([secondId]);
    expect(app.get(secondId).title.plainText.endsWith("…")).toBe(true);
    expect(app.captureCharFrame()).not.toContain("Renamed conversation");
    expect(renamed.map((entry) => entry.id)).toEqual([firstId, secondId]);
    app.tabs.update("tree", renamed, firstId, true); await app.render();
    expect(app.get(firstId).tab.x).toBe(app.tabs.list.viewport.x);
  } finally { await app.close(); }
});
