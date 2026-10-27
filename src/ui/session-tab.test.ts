import { expect, test } from "bun:test";
import { BoxRenderable, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Button } from "./button.ts";
import { SessionTab, SESSION_TAB_WIDTH } from "./session-tab.ts";
import { uiTheme } from "./theme.ts";

test("Shared tab widths and close positions stay fixed across short/Unicode names and status changes", async () => {
  // AI tabs with status and terminal tabs without status share frames.
  const app = await createTestRenderer({ width: 80, height: 4 });
  const row = new BoxRenderable(app.renderer, { height: 1, flexDirection: "row", gap: 1 });
  const leading = new BoxRenderable(app.renderer, { width: 1, height: 1, visible: false });
  const button = (label: string, activate: () => void) => new Button(app.renderer, label, activate);
  const first = new SessionTab(app.renderer, {
    id: "first",
    closeId: "close-first",
    closeLabel: "Close",
    leading,
    select() {},
    close() {},
    button,
  });
  const second = new SessionTab(app.renderer, {
    id: "second",
    closeId: "close-second",
    closeLabel: "Close",
    select() {},
    close() {},
    button,
  });
  row.add(first.root);
  row.add(second.root);
  app.renderer.root.add(row);
  first.setPosition(1);
  second.setPosition(2);
  first.setLabel("01a156a2");
  second.setLabel("zsh");
  try {
    await app.renderOnce();
    const positions = [first.closeButton.x, second.root.x, second.closeButton.x];

    // Status and growing process names truncate only within label areas.
    leading.visible = true;
    first.setLabel("01a156a2");
    second.setLabel("프로세스👩‍💻e\u0301-very-long-name");
    await app.renderOnce();

    // Preserve fixed geometry without damaging characters or combined glyphs.
    expect(first.root.width).toBe(18);
    expect(second.root.width).toBe(18);
    expect(SESSION_TAB_WIDTH).toBe(18);
    expect([first.closeButton.x, second.root.x, second.closeButton.x]).toEqual(positions);
    expect(second.title.plainText).toEndWith("…");
    expect(second.title.plainText).not.toContain("\uFFFD");
    expect(Bun.stringWidth(second.title.plainText)).toBeLessThanOrEqual(second.title.width);
    expect(second.closeButton.x + second.closeButton.width).toBe(second.root.x + 17);
  } finally {
    await app.dispose();
  }
});

test("Widths smaller than tabs shrink labels while keeping close buttons inside", async () => {
  // Extremely narrow views prioritize close controls over long names.
  const app = await createTestRenderer({ width: 30, height: 4 });
  const tab = new SessionTab(app.renderer, {
    id: "tab",
    closeId: "close",
    closeLabel: "Close",
    select() {},
    close() {},
    button: (label, activate) => new Button(app.renderer, label, activate),
  });
  app.renderer.root.add(tab.root);
  tab.setLabel("very-long-process-name");
  try {
    // Compact-to-wide round-trips reuse identical tab instances.
    for (const width of [18, 10, 4, 2, 30]) {
      tab.resize(width);
      await app.renderOnce();

      // Tabs cap at 18 cells and close controls never leave frames.
      expect(tab.root.width).toBe(Math.min(18, width));
      expect(tab.closeButton.width).toBe(1);
      expect(tab.closeButton.x).toBeGreaterThanOrEqual(tab.root.x);
      expect(tab.closeButton.x + tab.closeButton.width).toBeLessThanOrEqual(
        tab.root.x + tab.root.width,
      );
      expect(Bun.stringWidth(tab.title.plainText)).toBeLessThanOrEqual(tab.title.width);
    }
  } finally {
    await app.dispose();
  }
});

test("Tab padding selects while close buttons affect only their tabs without selection/focus changes", async () => {
  // Closing inactive tabs preserves current input owners.
  const app = await createTestRenderer({ width: 50, height: 4 });
  const calls: string[] = [];
  const tab = new SessionTab(app.renderer, {
    id: "tab",
    closeId: "close",
    closeLabel: "Close",
    select: () => calls.push("select"),
    close: () => calls.push("close"),
    button: (label, activate) => new Button(app.renderer, label, activate),
  });
  const outside = new Button(app.renderer, "Input", () => {});
  app.renderer.root.add(tab.root);
  app.renderer.root.add(outside);
  tab.setLabel("zsh");
  try {
    await app.renderOnce();
    outside.focus();

    // Ignore secondary close clicks and handle only primary clicks.
    await app.mockMouse.click(tab.closeButton.x, tab.closeButton.y, 2);
    await app.mockMouse.click(tab.closeButton.x, tab.closeButton.y);

    // Closure never propagates parent selection and retains input focus.
    expect(calls).toEqual(["close"]);
    expect(app.renderer.currentFocusedRenderable).toBe(outside);
    await app.mockMouse.click(tab.root.x, tab.root.y);
    expect(calls).toEqual(["close", "select"]);
    expect(app.renderer.currentFocusedRenderable).toBe(outside);
    expect(tab.root.focusable).toBe(false);
    expect(tab.closeButton.focusable).toBe(false);
  } finally {
    await app.dispose();
  }
});

test.each([false, true])(
  "Light theme %s keeps tab left edges borderless and distinguishes active tabs",
  async (light) => {
    // Active and inactive tabs use their normal backgrounds all the way to the left edge.
    const app = await createTestRenderer({ width: 80, height: 4 }),
      theme = uiTheme(app.renderer);
    const row = new BoxRenderable(app.renderer, { height: 1, flexDirection: "row", gap: 1 });
    const tabs = [1, 2, 10].map((position) => {
      const tab = new SessionTab(app.renderer, {
        id: `tab-${position}`,
        closeId: `close-${position}`,
        closeLabel: "Close",
        select() {},
        close() {},
        button: (label, activate) => new Button(app.renderer, label, activate),
      });
      tab.setPosition(position);
      tab.setLabel("zsh");
      row.add(tab.root);
      return tab;
    });
    app.renderer.root.add(row);
    theme.configure({
      palette: [],
      defaultForeground: light ? "#202020" : "#ECECEC",
      defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null,
      mouseForeground: null,
      mouseBackground: null,
      tekForeground: null,
      tekBackground: null,
      highlightForeground: null,
      highlightBackground: null,
    });
    const cell = (tab: SessionTab, offset = 0) => {
      let column = 0;
      return app.captureSpans().lines[tab.root.y]!.spans.find((span) => {
        column += span.width;
        return column > tab.root.x + offset;
      })!;
    };
    try {
      // Colors depend on active selection, not focus or title content.
      tabs[0]!.update(true);
      await app.renderOnce();

      // Neither line glyphs nor accent-filled cells appear at the left edge.
      const line = app.captureCharFrame().split("\n")[row.y]!;
      for (const [index, position] of [1, 2, 10].entries()) {
        const tab = tabs[index]!;
        expect(
          line.slice(tab.root.x, tab.root.x + tab.root.width).startsWith(`  ${position}. zsh`),
        ).toBe(true);
        expect(tab.root.height).toBe(1);
        const background = (index === 0 ? theme.colors.surface : theme.colors.panel).toInts();
        expect(cell(tab).bg.toInts()).toEqual(background);
        expect(cell(tab, 1).bg.toInts()).toEqual(background);
      }
      expect(line).not.toContain("│");

      // Selection moves the background emphasis without adding an edge marker.
      tabs[0]!.update(false);
      tabs[1]!.update(true);
      await app.renderOnce();
      expect(cell(tabs[0]!).bg.toInts()).toEqual(theme.colors.panel.toInts());
      expect(cell(tabs[1]!).bg.toInts()).toEqual(theme.colors.surface.toInts());
      expect(cell(tabs[2]!).bg.toInts()).toEqual(theme.colors.panel.toInts());
    } finally {
      await app.dispose();
    }
  },
);

test("Two-digit numbers survive title truncation and expanding restores titles", async () => {
  // Tenth-tab numbers are separate from process names and must not truncate.
  const app = await createTestRenderer({ width: 30, height: 4 });
  const tab = new SessionTab(app.renderer, {
    id: "tenth",
    closeId: "close-tenth",
    closeLabel: "Close",
    select() {},
    close() {},
    button: (label, activate) => new Button(app.renderer, label, activate),
  });
  tab.setPosition(10);
  tab.setLabel("long-process-name");
  app.renderer.root.add(tab.root);
  try {
    // Repeated resize prioritizes numbers and close controls over titles.
    for (const width of [18, 10, 5, 2, 18]) {
      tab.resize(width);
      await app.renderOnce();

      // Widths fitting numbers retain full numbers and compact only titles.
      const line = app.captureCharFrame().split("\n")[tab.root.y]!;
      if (width >= 5)
        expect(line.slice(tab.root.x, tab.root.x + tab.root.width)).toMatch(/^ {1,2}10\./);
      expect(tab.closeButton.x + tab.closeButton.width).toBeLessThanOrEqual(
        tab.root.x + tab.root.width,
      );
      expect(Bun.stringWidth(tab.title.plainText)).toBeLessThanOrEqual(tab.title.width);
    }
    expect(tab.title.plainText).toBe("long-pro…");
  } finally {
    await app.dispose();
  }
});

test.each([false, true])(
  "Light theme %s distinguishes active tabs without tab focus or underlined titles",
  async (light) => {
    // Active selection is the only tab state, shared by Agent and Terminal.
    const app = await createTestRenderer({ width: 50, height: 4 }),
      theme = uiTheme(app.renderer);
    const row = new BoxRenderable(app.renderer, { height: 1, flexDirection: "row" });
    const tab = new SessionTab(app.renderer, {
      id: "tab",
      closeId: "close",
      closeLabel: "Close",
      select() {},
      close() {},
      button: (label, activate) => new Button(app.renderer, label, activate),
    });
    row.add(tab.root);
    app.renderer.root.add(row);
    tab.setLabel("zsh");
    theme.configure({
      palette: [],
      defaultForeground: light ? "#202020" : "#ECECEC",
      defaultBackground: light ? "#FAFAF6" : "#141414",
      cursorColor: null,
      mouseForeground: null,
      mouseBackground: null,
      tekForeground: null,
      tekBackground: null,
      highlightForeground: null,
      highlightBackground: null,
    });
    const span = () => app.captureSpans().lines[0]!.spans.find((item) => item.text === "zsh")!;
    try {
      // Attempting to focus a tab cannot add a second selection state.
      tab.update(true);
      tab.root.focus();
      await app.renderOnce();
      expect(span().bg.toInts()).toEqual(theme.colors.surface.toInts());
      expect(tab.root.focused).toBe(false);
      tab.update(false);
      await app.renderOnce();

      // Inactive tabs use the normal panel background without underlining titles.
      expect(span().bg.toInts()).toEqual(theme.colors.panel.toInts());
      expect(span().attributes & TextAttributes.UNDERLINE).toBe(0);
    } finally {
      await app.dispose();
    }
  },
);
