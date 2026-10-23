import { expect, test } from "bun:test";
import { BoxRenderable, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Button } from "./button.ts";
import { uiTheme } from "./theme.ts";

test("Active-tab underlines persist when other tabs gain focus and move only on activation", async () => {
  // Selection identifies the displayed view, not the next keyboard activation target.
  const app = await createTestRenderer({ width: 40, height: 4 });
  const row = new BoxRenderable(app.renderer, { height: 1, flexDirection: "row", backgroundColor: uiTheme(app.renderer).colors.panel });
  const agent = new Button(app.renderer, "Agent", () => {});
  const git = new Button(app.renderer, "Git", () => {});
  row.add(agent); row.add(git); app.renderer.root.add(row);
  agent.active = true; git.active = false;
  const span = (text: string) => app.captureSpans().lines[0]!.spans.find((item) => item.text === text)!;
  try {
    // Focus can visit an inactive tab without navigating to it.
    git.focus(); await app.renderOnce();

    expect(span("Agent").attributes & TextAttributes.UNDERLINE).not.toBe(0);
    expect(span("Agent").attributes & TextAttributes.BOLD).not.toBe(0);
    expect(span("Git").attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(span("Git").bg.equals(uiTheme(app.renderer).colors.selected)).toBe(true);
    expect(span("Agent").bg.equals(uiTheme(app.renderer).colors.panel)).toBe(true);

    // Explicit navigation changes selection without taking away the existing focus.
    agent.active = false; git.active = true; await app.renderOnce();

    expect(span("Agent").attributes & TextAttributes.UNDERLINE).toBe(0);
    expect(span("Git").attributes & TextAttributes.UNDERLINE).not.toBe(0);
    expect(app.renderer.currentFocusedRenderable).toBe(git);
  } finally { await app.dispose(); }
});

test.each(["work-tab", "session-tab"] as const)("%s separates underline/background emphasis according to focus and active selection", async (variant) => {
  // Shared buttons do not imply identical emphasis for work tabs and session subtabs.
  const app = await createTestRenderer({ width: 50, height: 4 }), theme = uiTheme(app.renderer);
  const row = new BoxRenderable(app.renderer, { height: 1, flexDirection: "row" });
  theme.bind(row, (colors) => { row.backgroundColor = colors.panel; });
  const calls: string[] = [];
  const first = new Button(app.renderer, "First", () => calls.push("first"), variant);
  const second = new Button(app.renderer, "Second", () => calls.push("second"), variant);
  const outside = new Button(app.renderer, "Action", () => calls.push("action"));
  row.add(first); row.add(second); row.add(outside); app.renderer.root.add(row);
  const cell = (button: Button) => {
    let x = 0; return app.captureSpans().lines[button.y]!.spans.find((span) => { x += span.width; return x > button.x + 1; })!;
  };
  try {
    for (const light of [false, true]) {
      theme.configure({ palette: [], defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
        cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
      first.active = true; second.active = false;

      // Keyboard focus on inactive tabs never changes actual active selection.
      second.focus(); await app.renderOnce();
      const colors = theme.colors;
      expect(cell(first).attributes & TextAttributes.BOLD).not.toBe(0);
      expect(cell(second).attributes & TextAttributes.BOLD).toBe(0);
      expect(cell(first).bg.toInts()).toEqual((variant === "work-tab" ? colors.panel : colors.surface).toInts());
      expect(cell(second).bg.toInts()).toEqual((variant === "work-tab" ? colors.panel : colors.selected).toInts());
      expect(Boolean(cell(first).attributes & TextAttributes.UNDERLINE)).toBe(variant === "work-tab");
      expect(Boolean(cell(second).attributes & TextAttributes.UNDERLINE)).toBe(variant === "work-tab");

      // After activation and focus departure, each tab hierarchy retains its own active styling.
      first.active = false; second.active = true; outside.focus(); await app.renderOnce();
      expect(cell(first).attributes & TextAttributes.UNDERLINE).toBe(0);
      expect(cell(first).bg.toInts()).toEqual(colors.panel.toInts());
      expect(Boolean(cell(second).attributes & TextAttributes.UNDERLINE)).toBe(variant === "work-tab");
      expect(cell(second).bg.toInts()).toEqual((variant === "work-tab" ? colors.panel : colors.surface).toInts());
      expect(cell(outside).bg.toInts()).toEqual(colors.selected.toInts());
    }
    expect(calls).toEqual([]);
  } finally { await app.dispose(); }
});

test("Button horizontal padding is clickable while right-click never activates", async () => {
  // Padding must not create dead zones or leak clicks to the containing workspace row.
  const app = await createTestRenderer({ width: 30, height: 4 });
  const calls: string[] = [];
  const button = new Button(app.renderer, "New", () => { calls.push("new"); });
  app.renderer.root.add(button); await app.renderOnce();
  try {
    // Both padded cells belong to the control, while secondary clicks remain inert.
    await app.mockMouse.click(button.x, button.y);
    await app.mockMouse.click(button.x + button.width - 1, button.y);
    await app.mockMouse.click(button.x, button.y, 2);

    expect(calls).toEqual(["new", "new"]);
    expect(app.renderer.currentFocusedRenderable).toBe(button);
  } finally { await app.dispose(); }
});
