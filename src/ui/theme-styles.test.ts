import { expect, test } from "bun:test";
import { InputRenderable, TextRenderable, TextAttributes, type TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { expectError, expectOk } from "../testing/results.ts";
import { parseTheme } from "./theme-config.ts";
import { uiTheme } from "./theme.ts";
import { paintText } from "./theme-styles.ts";

const rgb = (color: { toInts(): number[] }) => color.toInts().slice(0, 3);
const defaultPalette = (): TerminalColors => ({ palette: [], defaultForeground: null, defaultBackground: null,
  cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
  highlightForeground: null, highlightBackground: null });

test("기존 색상 설정과 용도별 스타일을 함께 읽고 배경 해제·false 속성을 보존한다", () => {
  // 기존 파일을 마이그레이션하지 않아도 세부 스타일을 덧붙일 수 있어야 한다.
  const input = { success: "#123456", styles: { "syntax.string": { fg: "#ABCDEF", bg: null, bold: false, italic: true, underline: false } } };

  const result = expectOk(parseTheme(input));

  // false와 null을 누락으로 취급하면 이전 강조나 배경을 제거할 수 없다.
  expect(result).toEqual(input);
  expect(expectOk(parseTheme({ success: "#123456" }))).toEqual({ success: "#123456" });
});

test.each([
  { styles: null }, { styles: [] }, { styles: { unknown: {} } }, { styles: { "syntax.string": "green" } },
  { styles: { "syntax.string": { fg: null } } }, { styles: { "syntax.string": { fg: "green" } } },
  { styles: { "syntax.string": { bg: "#123" } } }, { styles: { "syntax.string": { bold: "false" } } },
  { styles: { "syntax.string": { underline: 1 } } }, { styles: { "syntax.string": { link: "status.success" } } },
])("알 수 없는 스타일·속성과 잘못된 값은 입력 오류로 반환한다: %j", (input) => {
  // 설정 오타를 조용히 무시하거나 의미가 불명확한 링크를 허용하지 않는다.
  const result = parseTheme(input);

  expect(expectError(result).code).toBe("INVALID_INPUT");
});

test("성공 스타일만 재정의하면 문자열·추가 표시·Git 그래프의 초록은 바뀌지 않는다", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    // 기본값이 같은 색이어도 그룹 간 종속 관계는 없어야 한다.
    const theme = uiTheme(app.renderer), before = theme.styles;
    theme.configure(defaultPalette(),
      { styles: { "status.success": { fg: "#AA00FF", bold: true } } });

    expect(rgb(theme.styles["status.success"].fg)).toEqual([170, 0, 255]);
    for (const group of ["syntax.string", "git.added", "diff.added", "git.graph.1"] as const) {
      expect(theme.styles[group].fg.equals(before[group].fg)).toBe(true);
    }
    expect(theme.styles["syntax.string"].fg.intent).toBe("indexed");
    expect(theme.styles["syntax.string"].fg.slot).toBe(2);
    expect(theme.styles["ui.text"].fg.intent).toBe("default");
  } finally { await app.dispose(); }
});

test("기존 공통 색은 기본값으로 유지하고 개별 스타일 재정의가 마지막에 적용된다", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    const theme = uiTheme(app.renderer);
    theme.configure(defaultPalette(),
      { success: "#112233", styles: { "syntax.string": { fg: "#445566" } } });

    // 기존 success 설정은 공유 기본색이고 새 스타일은 해당 용도만 바꾼다.
    expect(rgb(theme.styles["status.success"].fg)).toEqual([17, 34, 51]);
    expect(rgb(theme.styles["git.graph.1"].fg)).toEqual([17, 34, 51]);
    expect(rgb(theme.styles["syntax.string"].fg)).toEqual([68, 85, 102]);
  } finally { await app.dispose(); }
});

test("색이 같아도 강조 속성만 바뀌면 기존 화면을 갱신하고 false로 강조를 제거한다", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    const theme = uiTheme(app.renderer), node = new TextRenderable(app.renderer, { content: "STYLE_PROBE", height: 1 });
    app.renderer.root.add(node); let paints = 0;
    theme.bindStyles(node, styles => { paintText(node, styles["footer.key"]); paints++; });
    const palette = defaultPalette();
    const before = theme.styles["footer.key"].fg;

    // 같은 팔레트에서 속성만 변경하는 경로도 재렌더링되어야 한다.
    theme.configure(palette, { styles: { "footer.key": { bold: true, italic: true, underline: true, bg: "#223344" } } });
    await app.renderOnce(); await app.renderOnce();
    let span = app.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes("STYLE_PROBE"))!;
    expect(span.attributes & TextAttributes.BOLD).not.toBe(0); expect(span.attributes & TextAttributes.ITALIC).not.toBe(0);
    expect(span.attributes & TextAttributes.UNDERLINE).not.toBe(0); expect(rgb(span.bg)).toEqual([34, 51, 68]);
    expect(theme.styles["footer.key"].fg.equals(before)).toBe(true);

    theme.configure(palette, { styles: { "footer.key": { bold: false, italic: false, underline: false, bg: null } } });
    await app.renderOnce(); await app.renderOnce();
    span = app.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes("STYLE_PROBE"))!;
    expect(span.attributes & (TextAttributes.BOLD | TextAttributes.ITALIC | TextAttributes.UNDERLINE)).toBe(0);
    expect(theme.styles["footer.key"].bg).toBeUndefined();
    expect(rgb(span.bg)).not.toEqual([34, 51, 68]);
    const count = paints; node.destroyRecursively(); theme.configure(palette, { styles: { "footer.key": { bold: true } } });
    expect(paints).toBe(count);
  } finally { await app.dispose(); }
});

test("입력 포커스 이동은 전용 스타일의 강조를 적용하고 이전 속성을 남기지 않는다", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    const theme = uiTheme(app.renderer), input = new InputRenderable(app.renderer, { value: "FOCUS_STYLE", width: 20 });
    app.renderer.root.add(input); theme.input(input);
    theme.configure(defaultPalette(), { styles: { "ui.input": { italic: true }, "ui.inputFocused": { bold: true, underline: true } } });

    // 포커스 여부는 컴포넌트가 결정하고 표현은 각 스타일에서 가져온다.
    input.focus(); await app.renderOnce(); await app.renderOnce();
    expect(input.attributes & TextAttributes.BOLD).not.toBe(0); expect(input.attributes & TextAttributes.UNDERLINE).not.toBe(0);
    expect(input.attributes & TextAttributes.ITALIC).toBe(0);
    input.blur(); await app.renderOnce(); await app.renderOnce();
    expect(input.attributes & TextAttributes.ITALIC).not.toBe(0);
    expect(input.attributes & (TextAttributes.BOLD | TextAttributes.UNDERLINE)).toBe(0);
    expect(input.value).toBe("FOCUS_STYLE");
  } finally { await app.dispose(); }
});

test("공통 제목 스타일은 단계별 기본값에 반영하고 특정 단계의 재정의는 독립적이다", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    const theme = uiTheme(app.renderer);
    theme.configure(defaultPalette(),
      { styles: { "markup.heading": { fg: "#112233", bold: false }, "markup.heading.2": { fg: "#445566" } } });

    expect(rgb(theme.styles["markup.heading.1"].fg)).toEqual([17, 34, 51]);
    expect(rgb(theme.styles["markup.heading.2"].fg)).toEqual([68, 85, 102]);
    expect(theme.styles["markup.heading.2"].attributes & TextAttributes.BOLD).toBe(0);
  } finally { await app.dispose(); }
});
