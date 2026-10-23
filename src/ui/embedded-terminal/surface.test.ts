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

test("Incoming VT snapshots apply before the next visible frame without repeated full resets", async () => {
  // Blank or previous-snapshot first frames expose flicker to users.
  const app = await createTestRenderer({ width: 20, height: 2 });
  const surface = new TerminalSurface(app.renderer, "first-paint"); app.renderer.root.add(surface.root);
  try {
    surface.display({ id: "test", worktreeId: "tree", pid: 2, cols: 20, rows: 2, revision: 1,
      exited: false, exitCode: null, ansi: "\x1bcFIRST-SNAPSHOT" });
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("FIRST-SNAPSHOT");

    // Missing snapshots retain current screens and fresh snapshots never wait an extra frame.
    await app.renderOnce(); expect(app.captureCharFrame()).toContain("FIRST-SNAPSHOT");
    surface.display({ id: "test", worktreeId: "tree", pid: 2, cols: 20, rows: 2, revision: 2,
      exited: false, exitCode: null, ansi: "\x1bcSECOND-SNAPSHOT" });
    await app.renderOnce(); expect(app.captureCharFrame()).toContain("SECOND-SNAPSHOT");
  } finally { surface.dispose(); await app.dispose(); }
});

test("Embedded terminal defaults/ANSI follow outer themes while explicit RGB backgrounds persist", async () => {
  // Distinct outer/panel colors reveal opaque-black default regressions.
  const app = await createTestRenderer({ width: 20, height: 2 });
  const theme = new TerminalTheme(app.renderer, colors("#123456"));
  const surface = new TerminalSurface(app.renderer, "theme-terminal", theme);
  app.renderer.root.add(surface.root);
  try {
    // After full reset, apply defaults, ANSI red, and program RGB backgrounds independently.
    surface.display({ id: "test", worktreeId: "tree", pid: 2, cols: 20, rows: 2, revision: 1,
      exited: false, exitCode: null, ansi: "\x1bcA\x1b[31mB\x1b[48;2;70;80;90mC" });
    await app.renderOnce(); await app.renderOnce();

    const spans = app.captureSpans().lines[0]!.spans;
    expect(spans.find((span) => span.text === "A")!.fg.toInts().slice(0, 3)).toEqual([192, 255, 238]);
    expect(spans.find((span) => span.text === "A")!.bg.toInts().slice(0, 3)).toEqual([18, 52, 86]);
    expect(spans.find((span) => span.text === "B")!.fg.toInts().slice(0, 3)).toEqual([171, 205, 239]);
    expect(spans.find((span) => span.text === "C")!.bg.toInts().slice(0, 3)).toEqual([70, 80, 90]);

    // Host theme changes affect existing and subsequently created surfaces.
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

test("Unknown colors retain renderer defaults and theme cleanup unsubscribes", async () => {
  // Nonresponding outer terminals report unsupported colors as null.
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
