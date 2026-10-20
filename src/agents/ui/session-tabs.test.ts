import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Button } from "../../ui/button.ts";
import type { OpenSession } from "../model.ts";
import { SessionTabs } from "./session-tabs.ts";

const firstId = "01a156a2-ba64-707c-bd92-fc877962e972";
const secondId = "23ec1867-d98a-4d41-b656-d2c13806b5de";
const session = (id = firstId, name = "A conversation title, not the session ID"): OpenSession => ({ id, name, status: "complete", subagents: [] });

async function mount(initial: readonly OpenSession[] = [session()]) {
  const app = await createTestRenderer({ width: 100, height: 6, kittyKeyboard: true, clock: new ManualClock() });
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
    async close() { tabs.dispose(); await app.dispose(); },
  };
}

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
      if (width === 100) expect(text).toBe(firstId);
      else {
        expect(text.endsWith("…")).toBe(true);
        expect(text.match(/…/g)).toHaveLength(1);
        expect(firstId.startsWith(text.slice(0, -1))).toBe(true);
        expect(Bun.stringWidth(text)).toBeLessThanOrEqual(width - 7);
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
