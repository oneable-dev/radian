import { expect, test } from "bun:test";
import { BoxRenderable, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Button } from "./button.ts";
import { SessionTab, SESSION_TAB_WIDTH } from "./session-tab.ts";
import { uiTheme } from "./theme.ts";

test("짧은 이름·긴 Unicode 이름·상태 변화에도 공통 탭 폭과 닫기 위치를 고정한다", async () => {
  // 상태가 있는 AI 탭과 상태가 없는 터미널 탭에 같은 프레임을 사용한다.
  const app = await createTestRenderer({ width: 80, height: 4 });
  const row = new BoxRenderable(app.renderer, { height: 1, flexDirection: "row", gap: 1 });
  const leading = new BoxRenderable(app.renderer, { width: 1, height: 1, visible: false });
  const button = (label: string, activate: () => void) => new Button(app.renderer, label, activate);
  const first = new SessionTab(app.renderer, { id: "first", closeId: "close-first", closeLabel: "Close", leading, select() {}, close() {}, button });
  const second = new SessionTab(app.renderer, { id: "second", closeId: "close-second", closeLabel: "Close", select() {}, close() {}, button });
  row.add(first.root); row.add(second.root); app.renderer.root.add(row);
  first.setPosition(1); second.setPosition(2);
  first.setLabel("01a156a2"); second.setLabel("zsh");
  try {
    await app.renderOnce();
    const positions = [first.closeButton.x, second.root.x, second.closeButton.x];

    // 상태가 생기고 프로세스명이 늘어나도 라벨 영역 안에서만 말줄임한다.
    leading.visible = true; first.setLabel("01a156a2");
    second.setLabel("프로세스👩‍💻e\u0301-very-long-name"); await app.renderOnce();

    // 고정 폭과 오른쪽 닫기 위치를 유지하면서 문자나 조합형 글리프를 손상하지 않는다.
    expect(first.root.width).toBe(18); expect(second.root.width).toBe(18);
    expect(SESSION_TAB_WIDTH).toBe(18);
    expect([first.closeButton.x, second.root.x, second.closeButton.x]).toEqual(positions);
    expect(second.title.plainText).toEndWith("…"); expect(second.title.plainText).not.toContain("\uFFFD");
    expect(Bun.stringWidth(second.title.plainText)).toBeLessThanOrEqual(second.title.width);
    expect(second.closeButton.x + second.closeButton.width).toBe(second.root.x + 17);
  } finally { await app.dispose(); }
});

test("가용 폭이 탭보다 좁아지면 라벨을 줄이되 닫기 버튼은 안쪽에 유지한다", async () => {
  // 아주 좁은 창에서도 닫기 컨트롤을 긴 이름보다 우선한다.
  const app = await createTestRenderer({ width: 30, height: 4 });
  const tab = new SessionTab(app.renderer, { id: "tab", closeId: "close", closeLabel: "Close", select() {}, close() {},
    button: (label, activate) => new Button(app.renderer, label, activate) });
  app.renderer.root.add(tab.root); tab.setLabel("very-long-process-name");
  try {
    // 작은 화면을 거쳐 다시 넓혔을 때에도 같은 탭 인스턴스를 사용한다.
    for (const width of [18, 10, 4, 2, 30]) {
      tab.resize(width); await app.renderOnce();

      // 탭은 최대 18칸이며 닫기 버튼이 프레임 밖으로 밀려나지 않는다.
      expect(tab.root.width).toBe(Math.min(18, width));
      expect(tab.closeButton.width).toBe(1);
      expect(tab.closeButton.x).toBeGreaterThanOrEqual(tab.root.x);
      expect(tab.closeButton.x + tab.closeButton.width).toBeLessThanOrEqual(tab.root.x + tab.root.width);
      expect(Bun.stringWidth(tab.title.plainText)).toBeLessThanOrEqual(tab.title.width);
    }
  } finally { await app.dispose(); }
});

test("탭의 여백은 선택하고 닫기 버튼은 선택이나 포커스 이동 없이 해당 탭만 닫는다", async () => {
  // 비활성 탭을 닫을 때 현재 입력 소유자를 보존해야 한다.
  const app = await createTestRenderer({ width: 50, height: 4 });
  const calls: string[] = [];
  const tab = new SessionTab(app.renderer, { id: "tab", closeId: "close", closeLabel: "Close", focusable: true,
    select: () => calls.push("select"), close: () => calls.push("close"), button: (label, activate) => new Button(app.renderer, label, activate) });
  const outside = new Button(app.renderer, "Input", () => {});
  app.renderer.root.add(tab.root); app.renderer.root.add(outside); tab.setLabel("zsh");
  try {
    await app.renderOnce(); outside.focus();

    // 닫기의 보조 클릭은 무시하고 주 클릭만 처리한다.
    await app.mockMouse.click(tab.closeButton.x, tab.closeButton.y, 2);
    await app.mockMouse.click(tab.closeButton.x, tab.closeButton.y);

    // 닫기는 부모 선택으로 전파되지 않으며 기존 입력 포커스를 유지한다.
    expect(calls).toEqual(["close"]); expect(app.renderer.currentFocusedRenderable).toBe(outside);
    await app.mockMouse.click(tab.root.x, tab.root.y);
    expect(calls).toEqual(["close", "select"]); expect(app.renderer.currentFocusedRenderable).toBe(tab.root);
  } finally { await app.dispose(); }
});

test.each([false, true])("밝은 테마 %s에서도 같은 계열의 왼쪽 보더만 칠하고 활성 탭을 선명하게 구분한다", async light => {
  // 상태와 제목이 달라도 모든 탭은 같은 포인트 색상을 사용한다.
  const app = await createTestRenderer({ width: 80, height: 4 }), theme = uiTheme(app.renderer);
  const row = new BoxRenderable(app.renderer, { height: 1, flexDirection: "row", gap: 1 });
  const tabs = [1, 2, 10].map(position => {
    const tab = new SessionTab(app.renderer, { id: `tab-${position}`, closeId: `close-${position}`, closeLabel: "Close", select() {}, close() {},
      button: (label, activate) => new Button(app.renderer, label, activate) });
    tab.setPosition(position); tab.setLabel("zsh"); row.add(tab.root); return tab;
  });
  app.renderer.root.add(row);
  theme.configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
  const border = (tab: SessionTab) => {
    let column = 0;
    return app.captureSpans().lines[tab.root.y]!.spans.find(span => { column += span.width; return column > tab.root.x; })!;
  };
  try {
    // 활성 탭만 바꾸고 포커스나 제목 내용으로 색을 결정하지 않는다.
    tabs[0]!.update(true); await app.renderOnce();

    // 실제 보더는 세로선 한 칸이며 배경을 포인트 색으로 채우지 않는다.
    const line = app.captureCharFrame().split("\n")[row.y]!;
    for (const [index, position] of [1, 2, 10].entries()) {
      const tab = tabs[index]!;
      expect(line.slice(tab.root.x, tab.root.x + tab.root.width).startsWith(`│ ${position}. zsh`)).toBe(true);
      expect(tab.root.height).toBe(1);
    }
    expect(border(tabs[0]!).fg.toInts()).toEqual(theme.styles["ui.focusBorder"].fg.toInts());
    expect(border(tabs[0]!).bg.toInts()).toEqual(theme.colors.surface.toInts());
    expect(border(tabs[1]!).fg.toInts()).toEqual(border(tabs[2]!).fg.toInts());
    expect(border(tabs[1]!).fg.toInts()).not.toEqual(border(tabs[0]!).fg.toInts());
    expect(border(tabs[1]!).bg.toInts()).toEqual(theme.colors.panel.toInts());

    // 선택을 옮기면 같은 색의 강조만 새 탭으로 이동한다.
    tabs[0]!.update(false); tabs[1]!.update(true); await app.renderOnce();
    expect(border(tabs[1]!).fg.toInts()).toEqual(theme.styles["ui.focusBorder"].fg.toInts());
    expect(border(tabs[0]!).fg.toInts()).toEqual(border(tabs[2]!).fg.toInts());
  } finally { await app.dispose(); }
});

test("두 자리 번호는 제목이 말줄임돼도 유지하고 다시 넓히면 제목을 복원한다", async () => {
  // 열 번째 탭의 번호는 프로세스명의 일부가 아니므로 잘려서는 안 된다.
  const app = await createTestRenderer({ width: 30, height: 4 });
  const tab = new SessionTab(app.renderer, { id: "tenth", closeId: "close-tenth", closeLabel: "Close", select() {}, close() {},
    button: (label, activate) => new Button(app.renderer, label, activate) });
  tab.setPosition(10); tab.setLabel("long-process-name"); app.renderer.root.add(tab.root);
  try {
    // 리사이즈를 반복해도 번호와 닫기 컨트롤을 제목보다 우선한다.
    for (const width of [18, 10, 5, 2, 18]) {
      tab.resize(width); await app.renderOnce();

      // 번호가 들어갈 수 있는 폭에서는 전체 번호가 남고 제목만 축약된다.
      const line = app.captureCharFrame().split("\n")[tab.root.y]!;
      if (width >= 5) expect(line.slice(tab.root.x, tab.root.x + tab.root.width)).toMatch(/^│\s?10\./);
      expect(tab.closeButton.x + tab.closeButton.width).toBeLessThanOrEqual(tab.root.x + tab.root.width);
      expect(Bun.stringWidth(tab.title.plainText)).toBeLessThanOrEqual(tab.title.width);
    }
    expect(tab.title.plainText).toBe("long-pro…");
  } finally { await app.dispose(); }
});

test.each([false, true])("밝은 테마 %s에서도 AI 방식의 선택·포커스 배경과 밑줄 없는 제목을 공유한다", async light => {
  // 목록이 포커스를 소유하는 AI와 탭 자체가 소유하는 터미널을 같은 테마로 그린다.
  const app = await createTestRenderer({ width: 50, height: 4 }), theme = uiTheme(app.renderer);
  const row = new BoxRenderable(app.renderer, { height: 1, flexDirection: "row" });
  const tab = new SessionTab(app.renderer, { id: "tab", closeId: "close", closeLabel: "Close", focusable: true,
    select() {}, close() {}, button: (label, activate) => new Button(app.renderer, label, activate) });
  row.add(tab.root); app.renderer.root.add(row); tab.setLabel("zsh");
  theme.configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
  const span = () => app.captureSpans().lines[0]!.spans.find(item => item.text === "zsh")!;
  try {
    // 선택만 된 탭에서 목록 포커스, 직접 포커스 순으로 전환한다.
    tab.update(true); await app.renderOnce();
    expect(span().bg.toInts()).toEqual(theme.colors.surface.toInts());
    tab.update(true, true); await app.renderOnce();
    expect(span().bg.toInts()).toEqual(theme.colors.selected.toInts());
    tab.update(false); tab.root.focus(); await app.renderOnce();

    // 두 소유 방식 모두 배경으로 구분하고 제목에 밑줄은 추가하지 않는다.
    expect(span().bg.toInts()).toEqual(theme.colors.selected.toInts());
    expect(span().attributes & TextAttributes.UNDERLINE).toBe(0);
  } finally { await app.dispose(); }
});
