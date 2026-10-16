import { expect, test } from "bun:test";
import { BoxRenderable, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Button } from "./button.ts";
import { uiTheme } from "./theme.ts";

test("활성 탭의 밑줄은 다른 탭에 포커스가 가도 유지되고 전환할 때만 이동한다", async () => {
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

test("버튼의 좌우 여백도 클릭 대상이며 오른쪽 마우스 버튼은 실행하지 않는다", async () => {
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
