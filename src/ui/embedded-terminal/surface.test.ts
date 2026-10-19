import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TerminalColors } from "@opentui/core";
import { TerminalSurface } from "./surface.ts";
import { TerminalTheme } from "./theme.ts";

function colors(background: string): TerminalColors {
  return { palette: ["#102030", "#abcdef"], defaultForeground: "#c0ffee", defaultBackground: background,
    cursorColor: "#f0f0f0", mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
    highlightForeground: null, highlightBackground: null };
}

test("도착한 VT 스냅샷은 다음 프레임의 표시 전에 반영하고 화면 전체 reset을 반복하지 않는다", async () => {
  // 첫 표시 프레임이 빈 VT이거나 직전 스냅샷이면 사용자에게 깜빡임이 노출된다.
  const app = await createTestRenderer({ width: 20, height: 2 });
  const surface = new TerminalSurface(app.renderer, "first-paint"); app.renderer.root.add(surface.root);
  try {
    surface.display({ id: "test", worktreeId: "tree", pid: 2, cols: 20, rows: 2, revision: 1,
      exited: false, exitCode: null, ansi: "\x1bcFIRST-SNAPSHOT" });
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("FIRST-SNAPSHOT");

    // 스냅샷이 없으면 같은 화면을 유지하고, 새 스냅샷도 한 프레임 뒤로 미루지 않는다.
    await app.renderOnce(); expect(app.captureCharFrame()).toContain("FIRST-SNAPSHOT");
    surface.display({ id: "test", worktreeId: "tree", pid: 2, cols: 20, rows: 2, revision: 2,
      exited: false, exitCode: null, ansi: "\x1bcSECOND-SNAPSHOT" });
    await app.renderOnce(); expect(app.captureCharFrame()).toContain("SECOND-SNAPSHOT");
  } finally { surface.dispose(); await app.dispose(); }
});

test("내장 터미널의 기본색과 ANSI 팔레트는 외부 테마를 따르고 명시적 RGB 배경은 보존한다", async () => {
  // 앱 패널과 다른 외부 배경색을 사용해 불투명 검정 기본값 회귀를 구분한다.
  const app = await createTestRenderer({ width: 20, height: 2 });
  const theme = new TerminalTheme(app.renderer, colors("#123456"));
  const surface = new TerminalSurface(app.renderer, "theme-terminal", theme);
  app.renderer.root.add(surface.root);
  try {
    // 전체 프레임 reset 뒤에도 기본색과 ANSI 빨강, 프로그램의 RGB 배경을 각각 적용한다.
    surface.display({ id: "test", worktreeId: "tree", pid: 2, cols: 20, rows: 2, revision: 1,
      exited: false, exitCode: null, ansi: "\x1bcA\x1b[31mB\x1b[48;2;70;80;90mC" });
    await app.renderOnce(); await app.renderOnce();

    const spans = app.captureSpans().lines[0]!.spans;
    expect(spans.find((span) => span.text === "A")!.fg.toInts().slice(0, 3)).toEqual([192, 255, 238]);
    expect(spans.find((span) => span.text === "A")!.bg.toInts().slice(0, 3)).toEqual([18, 52, 86]);
    expect(spans.find((span) => span.text === "B")!.fg.toInts().slice(0, 3)).toEqual([171, 205, 239]);
    expect(spans.find((span) => span.text === "C")!.bg.toInts().slice(0, 3)).toEqual([70, 80, 90]);

    // 호스트 테마 변경은 기존 화면과 이후에 생성한 surface 모두에 반영한다.
    app.renderer.emit("palette", colors("#654321"));
    await app.renderOnce(); await app.renderOnce();
    expect(app.captureSpans().lines[0]!.spans[0]!.bg.toInts().slice(0, 3)).toEqual([101, 67, 33]);
    surface.dispose();
    const next = new TerminalSurface(app.renderer, "next-terminal", theme); app.renderer.root.add(next.root);
    next.display({ id: "next", worktreeId: "tree", pid: 3, cols: 20, rows: 2, revision: 1,
      exited: false, exitCode: null, ansi: "\x1bcnew" });
    await app.renderOnce(); await app.renderOnce();
    expect(app.captureSpans().lines[0]!.spans[0]!.bg.toInts().slice(0, 3)).toEqual([101, 67, 33]);
    next.dispose();
  } finally { surface.dispose(); theme.dispose(); await app.dispose(); }
});

test("조회되지 않은 색상은 렌더러 기본값을 유지하고 theme 정리는 구독을 해제한다", async () => {
  // 응답하지 않는 외부 터미널은 지원되지 않는 색상을 null로 제공한다.
  const app = await createTestRenderer({ width: 20, height: 2 });
  const theme = new TerminalTheme(app.renderer, { ...colors("#123456"), defaultBackground: null, defaultForeground: null,
    palette: [], cursorColor: null });
  const surface = new TerminalSurface(app.renderer, "fallback-terminal", theme); app.renderer.root.add(surface.root);
  try {
    surface.display({ id: "test", worktreeId: "tree", pid: 2, cols: 20, rows: 2, revision: 1,
      exited: false, exitCode: null, ansi: "\x1bcfallback" });
    await app.renderOnce(); await app.renderOnce();

    expect(app.captureCharFrame()).toContain("fallback");
    expect(app.captureSpans().lines[0]!.spans[0]!.bg.toInts().slice(0, 3)).toEqual([0, 0, 0]);
    theme.dispose();
    expect(app.renderer.listenerCount("palette")).toBe(0);
  } finally { surface.dispose(); theme.dispose(); await app.dispose(); }
});
