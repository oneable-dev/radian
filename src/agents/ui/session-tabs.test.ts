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
  { name: "실행 중에는 이전 미확인 벨보다 스피너", entry: { ...session(), status: "working", attention: completed }, glyph: "working", color: "accent" },
  { name: "자식이 실행 중이면 실패·중단·벨보다 스피너", entry: { ...session(), status: "failure", result: stopped, attention: stopped,
    subagents: [{ id: "busy", name: "Busy", status: "working" }, { id: "failed", name: "Failed", status: "failure" }] }, glyph: "working", color: "accent" },
  { name: "실패는 미확인 벨보다 원 안 느낌표", entry: { ...session(), status: "failure", result: failed, attention: failed }, glyph: "\uF06A", color: "error" },
  { name: "실패 결과는 상태가 미확정이어도 원 안 느낌표", entry: { ...session(), status: null, result: failed }, glyph: "\uF06A", color: "error" },
  { name: "자식 실패는 중단·미확인 벨보다 원 안 느낌표", entry: { ...session(), status: null, result: stopped, attention: stopped,
    subagents: [{ id: "failed", name: "Failed", status: "failure" }] }, glyph: "\uF06A", color: "error" },
  { name: "중단은 미확인 벨보다 빨간 물음표", entry: { ...session(), status: null, result: stopped, attention: stopped }, glyph: "?", color: "error" },
  { name: "완료 미확인은 체크 없이 채워진 벨", entry: { ...session(), result: completed, attention: completed }, glyph: "\uF0F3", color: "attention" },
  { name: "원인 불명 취소 미확인은 채워진 벨", entry: { ...session(), status: null, result: cancelled, attention: cancelled }, glyph: "\uF0F3", color: "attention" },
  { name: "읽은 정상 완료는 초록 체크", entry: { ...session(), result: completed }, glyph: icons.pass, color: "success" },
  { name: "읽은 취소는 회색 점", entry: { ...session(), status: null, result: cancelled }, glyph: "●", color: "muted" },
  { name: "직접 취소는 회색 점", entry: { ...session(), status: null, result: { ...cancelled, cancellation: "user" } }, glyph: "●", color: "muted" },
  { name: "세션 종료에 의한 취소도 회색 점", entry: { ...session(), status: null, result: { ...cancelled, cancellation: "lifecycle" } }, glyph: "●", color: "muted" },
  { name: "완료 상태여도 결과가 없으면 아이콘 없음", entry: session(), glyph: "", color: "muted" },
  { name: "상태와 결과가 모두 없으면 아이콘 없음", entry: { ...session(), status: null }, glyph: "", color: "muted" },
] satisfies { name: string; entry: OpenSession; glyph: string; color: keyof UiColors }[];

test.each(priorities)("$name 하나만 한 칸에 표시한다", async ({ entry, glyph, color }) => {
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

test("Fast 세션 탭만 노란 세 칸 화살표를 쓰고 프레임·모드 전환에도 탭과 닫기 위치를 유지한다", async () => {
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

test.each([completed, failed, stopped, cancelled])("빠른 $outcome 결과는 스피너와 겹치지 않고 읽음 뒤 잔상이 돌아오지 않는다", async result => {
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

test.each([false, true])("Fast %s 실행을 직접 취소하면 스피너 대신 회색 점을 유지한다", async fast => {
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

test("실행 중 숨긴 미확인 벨은 화면 복귀와 직접 취소 뒤에도 지워지지 않는다", async () => {
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

test("상태 아이콘이 없는 탭은 왼쪽 상태 칸과 간격을 빼고 확보한 너비를 ID에 사용한다", async () => {
  const unknown = { ...session(), status: null }, app = await mount([unknown]);
  try {
    // 좁은 탭에서도 상태가 없으면 UUID를 표시할 공간을 두 칸 더 확보한다.
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

test("미확정으로 바뀐 탭은 스피너 최소 시간 뒤 상태 칸을 제거하고 UUID 표시 공간을 복원한다", async () => {
  const working = { ...session(), status: "working" as const }, app = await mount([working]);
  try {
    app.resize(12, 6); await app.render(); const { tab, title } = app.get(firstId);
    app.clock.advance(120); app.tabs.update("tree", [{ ...working, status: null }], firstId, true); await app.render();
    const width = tab.width, titleX = title.x;
    app.clock.advance(379); await app.render(); expect(title.x).toBe(titleX); expect(title.plainText).toEndWith("…");
    // 스피너가 끝나면 추가 snapshot 없이 원래 UUID의 앞부분을 두 칸 더 표시한다.
    app.clock.advance(1); await app.render();
    expect(title.x).toBe(tab.x + 5); expect(title.plainText).toBe("01a…");
    expect(tab.width).toBe(width); expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("숨겼다가 돌아온 미확정 탭은 취소된 스피너 공간을 다시 예약하지 않는다", async () => {
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

test("앞선 탭의 상태 칸이 나타나도 선택한 탭의 ID와 닫기 버튼을 화면 안에 유지한다", async () => {
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

test("AI 탭은 전체 UUID를 라벨로 사용하고 고정 폭을 넘는 끝부분만 말줄임한다", async () => {
  // 세션 이름이나 임의의 8자리 접두사 대신 전체 UUID가 라벨의 원본이다.
  const entry = session(), app = await mount([entry]);
  try {
    // 큰 화면에서도 기존 18칸 프레임을 유지한 채 UUID를 표시한다.
    await app.render();

    // 표시 가능한 앞부분 뒤에 말줄임표 하나만 붙이고 원본 메타데이터는 보존한다.
    expect(app.get(firstId).title.plainText).toBe(firstLabel);
    expect(app.get(firstId).tab.width).toBe(18);
    expect(app.captureCharFrame()).toContain(firstLabel);
    expect(app.captureCharFrame()).not.toContain(firstId);
    expect(app.captureCharFrame()).not.toContain(entry.name);
    expect(entry.id).toBe(firstId);
    expect(entry.name).toBe("A conversation title, not the session ID");
  } finally { await app.close(); }
});

test("UUID는 가용 폭에 맞춰 끝을 말줄임하고 다시 넓히면 표시 가능한 앞부분을 복원한다", async () => {
  const app = await mount();
  try {
    // 작은 창을 거쳐도 원본 UUID를 잃지 않고 프레임의 가용 폭만 반영한다.
    for (const [width, expected] of [[12, "01a…"], [10, "0…"], [100, firstLabel]] as const) {
      app.resize(width, 6); await app.render();
      const { tab, title } = app.get(firstId), text = title.plainText;

      // 중간이나 끝자리 식별자를 합성하지 않고 UUID의 연속된 앞부분만 표시한다.
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
])("접두사가 겹치는 $id 탭도 같은 UUID 끝 말줄임 규칙만 적용한다", async ({ id, first, other }) => {
  // 충돌 위치가 8자리 바로 뒤부터 마지막 자리까지인 세션 쌍을 준비한다.
  const app = await mount([session(), session(id)]);
  try {
    // 같은 워크트리의 두 세션을 함께 표시한다.
    await app.render();

    // 주변 세션에 따라 접두사를 바꾸거나 말줄임 뒤에 식별자 끝부분을 덧붙이지 않는다.
    expect(app.get(firstId).title.plainText).toBe(first);
    expect(app.get(id).title.plainText).toBe(other);
    expect(app.captureCharFrame()).toContain(first);
    expect(app.captureCharFrame()).toContain(other);
  } finally { await app.close(); }
});

test("비슷한 UUID 탭을 추가·제거해도 기존 라벨과 폭을 유지하고 선택한 탭을 화면에 표시한다", async () => {
  // 표시 가능한 UUID 길이는 다른 탭의 존재가 아니라 공통 프레임 폭으로 정한다.
  const entries = [session(), session(secondId)], app = await mount(entries);
  try {
    app.resize(28, 6); app.tabs.update("tree", entries, secondId, true); await app.render();
    const firstTab = app.get(firstId).tab;

    // 다른 세션의 선택은 유지한 채 접두사가 겹치는 새 탭이 생긴다.
    app.tabs.update("tree", [...entries, session(collisionId)], secondId, true); await app.render();

    // 기존 인스턴스와 UUID 라벨을 유지하면서 선택한 탭을 다시 드러낸다.
    expect(app.get(firstId).tab).toBe(firstTab);
    expect(app.get(firstId).title.plainText).toBe(firstLabel);
    expect(app.get(collisionId).title.plainText).toBe(firstLabel);
    expect(app.get(secondId).title.plainText).toBe(secondLabel);
    const selectedTab = app.get(secondId).tab, viewport = app.tabs.list.viewport;
    expect(selectedTab.x).toBeGreaterThanOrEqual(viewport.x);
    expect(selectedTab.x + selectedTab.width).toBeLessThanOrEqual(viewport.x + viewport.width);

    // 다른 탭이 닫혀도 이미 표시 중인 UUID 길이는 달라지지 않는다.
    app.tabs.update("tree", entries, secondId, true); await app.render();
    expect(app.get(firstId).title.plainText).toBe(firstLabel);
    expect(app.get(secondId).title.plainText).toBe(secondLabel);
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test("워크트리를 전환해도 같은 UUID와 프레임 폭에는 같은 라벨을 표시한다", async () => {
  // 같은 세션을 다른 워크트리에 하나만 표시해도 라벨을 줄이지 않는다.
  const app = await mount([session(), session(collisionId)]);
  try {
    // 다른 워크트리에는 그중 한 세션만 표시한다.
    app.tabs.update("other-tree", [session(collisionId)], collisionId, true); await app.render();

    // 세션 수와 무관하게 전체 UUID의 동일한 앞부분을 표시한다.
    expect(app.get(collisionId, "other-tree").title.plainText).toBe(firstLabel);
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);
  } finally { await app.close(); }
});

test.each(["a1", "12345678", "1234567890"])("가용 폭에 들어가는 %s 세션 ID는 말줄임 없이 전부 표시한다", async id => {
  // 기존 짧은 식별자는 패딩하거나 다른 이름으로 바꿀 필요가 없다.
  const app = await mount([session(id)]);
  try {
    // ID 길이가 가용 폭과 같을 때도 불필요한 말줄임표를 붙이지 않는다.
    await app.render();

    // 원래 ID가 그대로 사용자에게 보인다.
    expect(app.get(id).title.plainText).toBe(id);
  } finally { await app.close(); }
});

test("열 번째 이후 세션도 번호를 표시하고 닫기·재정렬·워크트리 변경 시 현재 순서로 다시 매긴다", async () => {
  // 세션 ID의 숫자가 아닌 현재 워크트리의 표시 순서를 번호로 사용한다.
  const entries = Array.from({ length: 11 }, (_, index) => session(`session-${index + 20}`));
  const app = await mount(entries);
  try {
    // 가로 스크롤된 마지막 탭에도 두 자리 번호를 제목과 별개로 표시한다.
    app.resize(30, 6); app.tabs.update("tree", entries, entries[10]!.id, true); await app.render();

    const last = app.get(entries[10]!.id);
    expect(last.number.plainText).toBe("11."); expect(last.title.plainText).toBe("session-…");
    expect(last.tab.x).toBeGreaterThanOrEqual(app.tabs.list.viewport.x);
    expect(last.tab.x + last.tab.width).toBeLessThanOrEqual(app.tabs.list.viewport.x + app.tabs.list.viewport.width);

    // 앞선 탭이 닫히고 기존 탭 순서가 바뀌어도 ID와 인스턴스는 보존한다.
    const reordered = [entries[10]!, ...entries.slice(1, 10)];
    app.tabs.update("tree", reordered, entries[10]!.id, true); await app.render();

    expect(app.get(entries[10]!.id).tab).toBe(last.tab);
    expect(app.get(entries[10]!.id).number.plainText).toBe("1.");
    expect(app.get(entries[1]!.id).number.plainText).toBe("2.");
    expect(app.get(entries[9]!.id).number.plainText).toBe("10.");
    expect(app.selected).toEqual([]); expect(app.closed).toEqual([]);

    // 다른 워크트리의 첫 탭은 이전 워크트리 번호를 이어받지 않는다.
    app.tabs.update("other-tree", [entries[9]!], entries[9]!.id, true); await app.render();
    expect(app.get(entries[9]!.id, "other-tree").number.plainText).toBe("1.");
  } finally { await app.close(); }
});

test("두 UUID가 같은 라벨로 말줄임돼도 선택·닫기는 각각의 전체 ID로 처리한다", async () => {
  // 화면에 보이는 앞부분은 같고 마지막 문자만 다른 UUID 두 개를 준비한다.
  const otherId = "01a156a2-ba64-707c-bd92-fc877962e973";
  const entries = [session(), session(otherId, "Other conversation")], app = await mount(entries);
  try {
    // 이름 변경과 키보드 선택 뒤에도 두 라벨은 같은 끝 말줄임 규칙을 따른다.
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

    // 동일한 표시 문자열이 아닌 고유 UUID로 닫고 원래 메타데이터를 보존한다.
    expect(app.selected).toEqual([otherId]); expect(app.closed).toEqual([otherId]);
    expect(app.captureCharFrame()).not.toContain("Renamed conversation");
    expect(renamed.map((entry) => entry.id)).toEqual([firstId, otherId]);

    // 첫 탭의 제목을 클릭해도 다른 UUID와 혼동하지 않는다.
    app.tabs.update("tree", renamed, firstId, true); await app.render();
    const { tab, title } = app.get(firstId);
    expect(tab.x).toBe(app.tabs.list.viewport.x);
    await app.mockMouse.click(title.x, title.y); await app.render();
    expect(app.selected).toEqual([otherId, firstId]);
  } finally { await app.close(); }
});
