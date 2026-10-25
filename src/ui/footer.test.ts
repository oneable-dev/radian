import { expect, test } from "bun:test";
import { BoxRenderable, InputRenderable, type TerminalColors, type TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Footer } from "./footer.ts";
import { uiTheme } from "./theme.ts";
import { icons } from "../icons.ts";

async function mount(width = 100, height = 8) {
  const app = await createTestRenderer({ width, height, kittyKeyboard: true });
  const screen = new BoxRenderable(app.renderer, { width: "100%", height: "100%", flexDirection: "column" });
  const body = new BoxRenderable(app.renderer, { flexGrow: 1, minHeight: 0 });
  const input = new InputRenderable(app.renderer, { width: "100%", value: "draft" });
  const footer = new Footer(app.renderer);
  body.add(input); screen.add(body); screen.add(footer.root); app.renderer.root.add(screen);
  footer.setShortcuts([{ key: "<CR>", label: "Run" }, { key: "<leader>b", label: "Workspace" }]);
  input.focus(); await app.renderOnce();
  return { ...app, footer, body, input, line: () => app.captureCharFrame().split("\n")[footer.bar.y]! };
}

test("View blocks replace branding without reserving a second footer row", async () => {
  // Passive identity must stay readable without reducing the input's height.
  const app = await mount(120, 24);
  try {
    app.footer.setView("TERMINAL"); app.footer.setContext("Paused"); await app.renderOnce();

    expect(app.line().trimStart()).toStartWith("TERMINAL"); expect(app.line()).not.toContain("Radian");
    expect(app.line()).toContain("Paused"); expect(app.line()).toContain("<CR> Run");
    expect(app.footer.root.height).toBe(1); expect(app.body.height).toBe(23);
    expect(app.renderer.root.findDescendantById("footer-notice-row")).toBeUndefined();
    for (const width of [60, 30, 12, 120]) {
      app.resize(width, 12); await app.renderOnce();
      expect(app.line()).toContain("TERMINAL"); expect(Bun.stringWidth(app.line())).toBeLessThanOrEqual(width);
      expect(app.footer.bar.y).toBe(11); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    }
  } finally { await app.dispose(); }
});

test("Workspace context uses existing icons and a middle dot without separate backgrounds", async () => {
  // Scope belongs to the selected worktree, independently of the active screen.
  const app = await mount(120);
  try {
    app.footer.setWorkspace({ name: "auth-checkout", branch: "feature/auth" }); await app.renderOnce();

    expect(app.line().trimStart()).toStartWith(`AGENT  ${icons.folder} auth-checkout · ${icons.branch} feature/auth`);
    const identity = app.renderer.root.findDescendantById("footer-identity")!, workspace = app.renderer.root.findDescendantById("footer-workspace")!;
    const styles = uiTheme(app.renderer).styles;
    expect(styles["footer.worktree"].bg).toBeUndefined(); expect(styles["footer.branch"].bg).toBeUndefined();
    let column = 0;
    for (const span of app.captureSpans().lines[workspace.y]!.spans) {
      const end = column + span.width;
      if (column < workspace.x + workspace.width && end > workspace.x) expect(span.bg.toInts()).toEqual(styles["footer.identity"].bg!.toInts());
      column = end;
    }
    expect(workspace.x).toBe(identity.x + identity.width);
    expect(app.line().trimEnd()).toEndWith("<leader>b Workspace");
    for (const view of ["AGENT", "EDITOR", "GIT", "TERMINAL"]) {
      app.footer.setView(view); await app.renderOnce();
      expect(app.line()).toContain(view); expect(app.line()).toContain("auth-checkout"); expect(app.line()).toContain("feature/auth");
      expect(workspace.x).toBe(identity.x + identity.width);
    }
    app.footer.setWorkspace({ name: "auth-checkout", branch: null }); await app.renderOnce();
    expect(app.line()).toContain("detached HEAD");
  } finally { await app.dispose(); }
});

test("View labels keep exactly one space on both sides at every width", async () => {
  // The screen badge must stay symmetric instead of inheriting the work pane's responsive inset.
  const app = await mount();
  try {
    for (const width of [120, 80, 60, 120]) {
      app.resize(width, 8);
      for (const view of ["AGENT", "EDITOR", "GIT", "TERMINAL"]) {
        app.footer.setView(view); await app.renderOnce();

        const identity = app.renderer.root.findDescendantById("footer-identity") as TextRenderable;
        expect(identity.plainText).toBe(` ${view} `); expect(identity.width).toBe(view.length + 2);
      }
    }
    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.input.value).toBe("draft");
  } finally { await app.dispose(); }
});

test("Narrow Unicode workspaces truncate safely and restore after resize", async () => {
  // A wide checkout name must never push the active view outside the footer.
  const app = await mount(120);
  try {
    app.footer.setView("TERMINAL"); app.footer.setWorkspace({ name: "작업공간".repeat(10), branch: "feature/".repeat(10) });
    for (const width of [120, 40, 20, 8, 120]) {
      app.resize(width, 8); await app.renderOnce();
      expect(Bun.stringWidth(app.line())).toBeLessThanOrEqual(width); expect(app.footer.root.height).toBe(1);
      expect(app.input.value).toBe("draft"); expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      if (width >= 20) expect(app.line()).toContain("TERMINAL");
      if (width >= 40) expect(app.line()).toContain("…");
    }
  } finally { await app.dispose(); }
});

test("Footer mode background is uniform and follows terminal palettes", async () => {
  // Theme changes must recolor the block, not recreate the old per-cell gradient.
  const app = await mount();
  const palette = (light: boolean): TerminalColors => ({ palette: ["#000000", "#CC2222", "#228822", "#998800", "#2255AA", "#AA22AA", light ? "#996633" : "#117799", "#DDDDDD"],
    defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null, highlightForeground: null, highlightBackground: null });
  try {
    for (const light of [false, true]) {
      app.renderer.emit("palette", palette(light)); await app.renderOnce();

      const identity = app.renderer.root.findDescendantById("footer-identity")!, styles = uiTheme(app.renderer).styles;
      expect(styles["footer.mode"].fg.intent).toBe("rgb");
      let x = 0;
      for (const span of app.captureSpans().lines[app.footer.bar.y]!.spans) {
        if (x < identity.width) expect(span.bg.toInts()).toEqual(styles["footer.mode"].bg!.toInts());
        x += span.width;
      }
      expect(identity.x).toBe(0); expect(app.line().indexOf("AGENT")).toBe(1);
    }
  } finally { await app.dispose(); }
});

test("Active shortcut labels use normal text contrast while disabled keys stay muted", async () => {
  // Unavailable actions dim their keys without shifting their positions.
  const app = await mount();
  try {
    const before = app.line();
    const label = app.captureSpans().lines[app.footer.bar.y]!.spans.find(span => span.text.includes("Run"))!;
    expect(label.fg.toInts()).toEqual(uiTheme(app.renderer).colors.text.toInts());
    app.footer.setShortcuts([{ key: "<CR>", label: "Run", disabled: true }, { key: "<leader>b", label: "Workspace" }]); await app.renderOnce();

    expect(app.line()).toBe(before);
    expect(app.captureSpans().lines[app.footer.bar.y]!.spans.find(span => span.text.includes("<CR>"))?.fg.equals(uiTheme(app.renderer).colors.muted)).toBe(true);
    app.resize(25, 8); await app.renderOnce();
    expect(app.line()).toContain("<CR> Run"); expect(app.line()).not.toContain("<leader>b"); expect(app.line()).toContain("…");
    app.resize(100, 8); await app.renderOnce(); expect(app.line()).toContain("<leader>b Workspace");
  } finally { await app.dispose(); }
});

test("Passive footer clicks and height changes preserve drafts and focus", async () => {
  // The footer is presentation only except for its separately owned Help entry.
  const app = await mount();
  try {
    await app.mockMouse.click(2, app.footer.bar.y); app.resize(100, 24); await app.renderOnce();

    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.input.value).toBe("draft");
    expect(app.body.y + app.body.height).toBe(app.footer.bar.y); expect(app.footer.root.height).toBe(1);
    const before = app.renderer.listenerCount("resize"); app.footer.root.destroyRecursively();
    expect(app.renderer.listenerCount("resize")).toBe(before - 1);
  } finally { await app.dispose(); }
});
