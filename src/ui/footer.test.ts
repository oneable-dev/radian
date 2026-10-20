import { expect, test } from "bun:test";
import { BoxRenderable, InputRenderable, type TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Footer } from "./footer.ts";
import { blendColors, uiTheme } from "./theme.ts";

async function mount(width = 100, height = 8) {
  const app = await createTestRenderer({ width, height, kittyKeyboard: true });
  const screen = new BoxRenderable(app.renderer, { width: "100%", height: "100%", flexDirection: "column" });
  const body = new BoxRenderable(app.renderer, { flexGrow: 1, minHeight: 0 });
  const input = new InputRenderable(app.renderer, { width: "100%", value: "draft" });
  const footer = new Footer(app.renderer, "Radian 0.0.0");
  body.add(input); screen.add(body); screen.add(footer.root); app.renderer.root.add(screen);
  footer.setShortcuts([{ key: "Enter", label: "Run" }, { key: "Esc", label: "Workspace" }]);
  input.focus(); await app.renderOnce();
  return { ...app, footer, body, input,
    footerLine: () => app.captureCharFrame().split("\n")[footer.bar.y]!,
  };
}

test("공통 푸터는 화면 마지막 한 줄에 있고 별도 알림은 바로 위에서 단축키를 가리지 않는다", async () => {
  // A host supplies identity and context-specific shortcuts; the footer owns no actions.
  const app = await mount();
  try {
    const before = app.footerLine();

    app.footer.setNotice("Runtime disconnected · reconnecting"); await app.renderOnce();

    expect(app.footer.bar.height).toBe(1);
    expect(app.footer.bar.y).toBe(7);
    expect(app.footer.notice.y).toBe(6);
    expect(app.body.y + app.body.height).toBeLessThanOrEqual(app.footer.notice.y);
    expect(app.footerLine()).toBe(before);
    expect(before.trimStart()).toStartWith("Radian 0.0.0");
    expect(before.trimEnd()).toEndWith("Enter Run  Esc Workspace");
    expect(app.captureCharFrame().split("\n")[6]).toContain("reconnecting");
    expect(app.captureCharFrame().split("\n")[6]!.indexOf("Runtime")).toBe(2);
    const spans = app.captureSpans().lines[7]!.spans;
    const key = spans.find((span) => span.text.includes("Enter"));
    const label = spans.find((span) => span.text.includes("Run"));
    expect(key).toBeDefined(); expect(label).toBeDefined();
    expect(key?.fg.equals(label?.fg)).toBe(false);
  } finally { await app.dispose(); }
});

test("일반 화면도 푸터는 마지막 한 줄만 사용하고 나머지 행을 본문에 돌려준다", async () => {
  // Branding must not reserve an additional terminal row above the shortcut text.
  const app = await mount(100, 24);
  try {
    await app.renderOnce();
    const lines = app.captureCharFrame().split("\n");

    expect(app.footer.root.height).toBe(1); expect(app.footer.bar.height).toBe(1);
    expect(app.footer.bar.y).toBe(23); expect(app.body.height).toBe(23);
    expect(app.captureCharFrame()).not.toContain("▂");
    expect(lines[23]).toContain("Radian 0.0.0"); expect(lines[23]).toContain("Enter Run  Esc Workspace");
    expect(app.body.y + app.body.height).toBe(app.footer.bar.y);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.input.value).toBe("draft");
  } finally { await app.dispose(); }
});

test("세로 리사이즈 후에도 푸터는 한 줄이며 실제 알림만 바로 위 한 줄을 사용한다", async () => {
  // Width stays fixed so height-only changes cannot rely on a bar-width resize callback.
  const app = await mount(100, 24);
  try {
    app.footer.setNotice("Runtime reconnecting");
    for (const height of [24, 17, 18, 12, 24]) {
      app.resize(100, height); await app.renderOnce();
      const lines = app.captureCharFrame().split("\n");

      // Real notices retain their own row at every height without adding decorative padding.
      expect(app.footer.bar.height).toBe(1); expect(app.footer.root.height).toBe(2);
      expect(lines[height - 1]).toContain("Radian 0.0.0"); expect(lines[height - 1]).toContain("Esc Workspace");
      expect(app.footer.bar.y + app.footer.bar.height).toBe(height);
      expect(lines[height - 2]).toContain("Runtime reconnecting");
      expect(app.body.y + app.body.height).toBe(app.footer.notice.y);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.input.value).toBe("draft");
    }
    app.footer.setNotice(""); await app.renderOnce();
    expect(app.footer.root.height).toBe(1); expect(app.footerLine()).toContain("Esc Workspace");
  } finally { await app.dispose(); }
});

test("푸터를 제거하면 세로 리사이즈 구독을 정리한다", async () => {
  const app = await mount(100, 24);
  try {
    const before = app.renderer.listenerCount("resize");

    app.footer.root.destroyRecursively();

    expect(app.renderer.listenerCount("resize")).toBe(before - 1);
  } finally { await app.dispose(); }
});

test("일시적으로 사용할 수 없는 단축키는 위치를 유지하고 키 색상만 비활성화한다", async () => {
  const app = await mount();
  try {
    const before = app.footerLine();
    app.footer.setShortcuts([{ key: "Enter", label: "Run", disabled: true }, { key: "Esc", label: "Workspace" }]); await app.renderOnce();
    expect(app.footerLine()).toBe(before);
    const spans = app.captureSpans().lines[app.footer.bar.y]!.spans;
    expect(spans.find((span) => span.text.includes("Enter"))?.fg.equals(uiTheme(app.renderer).colors.muted)).toBe(true);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.input.value).toBe("draft");
  } finally { await app.dispose(); }
});

test("좁은 폭에서는 단축키와 설명을 통째로 생략하고 resize 후 다시 표시한다", async () => {
  // Width fitting must not advertise a cut-off key/action pair or add another footer row.
  const app = await mount();
  try {
    app.resize(30, 8); await app.renderOnce();

    expect(app.footer.bar.height).toBe(1);
    expect(app.footerLine()).toContain("Enter Run");
    expect(app.footerLine()).toContain("…");
    expect(app.footerLine()).not.toContain("Esc");
    expect(Bun.stringWidth(app.footerLine())).toBeLessThanOrEqual(30);
    app.resize(10, 8); await app.renderOnce();
    expect(app.footer.bar.height).toBe(1);
    expect(Bun.stringWidth(app.footerLine())).toBeLessThanOrEqual(10);
    app.resize(100, 8); await app.renderOnce();

    expect(app.footerLine()).toContain("Esc Workspace");
    expect(app.footerLine()).not.toContain("…");
  } finally { await app.dispose(); }
});

test("한글 설명도 문자 수가 아닌 터미널 셀 너비로 배치한다", async () => {
  // Wide characters occupy two cells and must not overlap the app identity or edge.
  const app = await mount(34);
  try {
    app.footer.setShortcuts([{ key: "↑/↓", label: "선택" }, { key: "Enter", label: "열기" }]);

    await app.renderOnce();

    expect(app.footerLine()).toContain("↑/↓ 선택");
    expect(app.footerLine()).toContain("…");
    expect(app.footerLine()).not.toContain("Enter");
    expect(Bun.stringWidth(app.footerLine())).toBeLessThanOrEqual(34);
  } finally { await app.dispose(); }
});

test("푸터를 클릭해도 입력 포커스와 초안을 변경하거나 액션을 실행하지 않는다", async () => {
  // The notice and shortcut bar are deliberately not interactive or focusable.
  const app = await mount();
  try {
    const x = app.footerLine().indexOf("Enter");

    await app.mockMouse.click(x, app.footer.bar.y); await app.renderOnce();

    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.input.value).toBe("draft");
    expect(app.footer.bar.focusable).toBe(false);
  } finally { await app.dispose(); }
});

test("좌측 Radian 제품명에서 오른쪽으로 흐려지는 그라데이션은 터미널 테마와 리사이즈를 따른다", async () => {
  // A known palette distinguishes accent-derived branding from a hardcoded product color.
  const app = await mount(100, 24);
  const palette = (light: boolean): TerminalColors => ({ palette: ["#000000", "#CC2222", "#228822", "#998800", "#2255AA", "#AA22AA", light ? "#996633" : "#117799", "#DDDDDD"],
    defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
    highlightForeground: null, highlightBackground: null });
  const spanAt = (column: number, row = app.footer.bar.y) => {
    let x = 0;
    return app.captureSpans().lines[row]!.spans.find((span) => { x += span.width; return x > column; })!;
  };
  const verifyBrand = (expectedInset = 2) => {
    const colors = uiTheme(app.renderer).colors;
    const identity = app.renderer.root.findDescendantById("footer-identity")!;
    const left = spanAt(identity.x);
    const right = spanAt(identity.x + identity.width - 1);
    expect(app.footerLine().trimStart()).toStartWith("Radian 0.0.0");
    // The gradient includes the leading blank cell; only the product text is inset.
    expect(identity.x).toBe(app.footer.bar.x);
    expect(app.footerLine().indexOf("Radian")).toBe(app.footer.bar.x + expectedInset);
    expect(spanAt(app.footer.bar.x).bg.toInts()).toEqual(blendColors(colors.surface, colors.accent, 0.28).toInts());
    expect(right.bg.equals(colors.surface)).toBe(true);
    expect(left.fg.equals(colors.text)).toBe(true);
    expect(spanAt(app.footerLine().indexOf("Enter")).bg.equals(colors.surface)).toBe(true);
    return left.bg.toInts();
  };
  try {
    // The gradient occupies only the identity; hints remain on a uniform background.
    app.renderer.emit("palette", palette(false)); await app.renderOnce();
    const dark = verifyBrand();

    // Repainting the existing footer must preserve its text and single-row layout.
    app.renderer.emit("palette", palette(true)); await app.renderOnce();
    expect(verifyBrand()).not.toEqual(dark);
    app.resize(30, 8); await app.renderOnce();
    verifyBrand(1);
    expect(app.footerLine()).toContain("Enter Run");
    expect(app.footer.bar.height).toBe(1);
  } finally { await app.dispose(); }
});

test("알림을 지우면 사용하던 행을 본문에 돌려주고 초안과 포커스를 유지한다", async () => {
  // Real warnings remain visible while routine empty notices consume no terminal space.
  const app = await mount();
  try {
    app.footer.setNotice("Runtime disconnected"); await app.renderOnce();
    const bodyHeight = app.body.height;
    expect(app.captureCharFrame()).toContain("Runtime disconnected");

    // Clearing a notice, including whitespace-only content, must reclaim its entire row.
    app.footer.setNotice(" \n "); await app.renderOnce();

    expect(app.footer.notice.visible).toBe(false);
    expect(app.footer.root.height).toBe(1);
    expect(app.body.height).toBe(bodyHeight + 1);
    expect(app.footer.bar.y).toBe(7);
    expect(app.captureCharFrame()).not.toContain("Runtime disconnected");
    expect(app.input.value).toBe("draft");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally { await app.dispose(); }
});

test("포커스 단축키가 없으면 앱 이름만 남기고 빈 알림 행을 접는다", async () => {
  // Empty context must not invent global shortcuts or reserve an unused notice row.
  const app = await mount();
  try {
    const y = app.footer.bar.y;

    app.footer.setShortcuts([]); app.footer.setNotice(""); await app.renderOnce();

    expect(app.footerLine().trim()).toBe("Radian 0.0.0");
    expect(app.footer.notice.visible).toBe(false);
    expect(app.footer.root.height).toBe(1);
    expect(app.body.y + app.body.height).toBe(app.footer.bar.y);
    expect(app.footer.bar.y).toBe(y);
    expect(app.captureCharFrame()).not.toContain("Ctrl+C");
  } finally { await app.dispose(); }
});

test("탐색·선택 상태는 단축키와 별개로 한 줄 푸터에 표시하고 실제 알림과 초안을 보존한다", async () => {
  const app = await mount(100, 24);
  try {
    app.footer.setContext("VISUAL LINE · Paused"); app.footer.setNotice("Runtime disconnected"); await app.renderOnce();
    expect(app.footerLine()).toContain("VISUAL LINE · Paused"); expect(app.footerLine()).toContain("Enter Run");
    expect(app.footer.noticeText).toBe("Runtime disconnected"); expect(app.footer.root.height).toBe(2);
    const context = app.renderer.root.findDescendantById("footer-context")!;
    await app.mockMouse.click(context.x, context.y); await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.input.value).toBe("draft");

    app.resize(30, 12); await app.renderOnce();
    expect(Bun.stringWidth(app.footerLine())).toBeLessThanOrEqual(30); expect(app.footer.bar.height).toBe(1);
    app.resize(100, 24); app.footer.setContext(""); await app.renderOnce();
    expect(app.footerLine()).not.toContain("VISUAL"); expect(app.footerLine()).not.toContain("Paused");
    expect(app.footerLine()).toContain("Esc Workspace"); expect(app.footer.noticeText).toBe("Runtime disconnected");
  } finally { await app.dispose(); }
});
