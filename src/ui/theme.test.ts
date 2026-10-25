import { openWorkspaceSearch } from "../testing/keys.ts";
import { expect, spyOn, test } from "bun:test";
import { BoxRenderable, NativeSession, type RGBA, type TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "../app/ui/workbench.ts";
import { PromptInput } from "../agents/ui/prompt-input.ts";
import { uiTheme } from "./theme.ts";
import { WorkspaceSelection } from "../app/workspace-selection.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { ok } from "../result.ts";

function palette(light = false): TerminalColors {
  return { palette: ["#000000", "#CC2222", "#228822", "#998800", "#2255AA", "#AA22AA", "#117799", "#DDDDDD"],
    defaultForeground: light ? "#202020" : "#ECECEC", defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null, tekBackground: null,
    highlightForeground: null, highlightBackground: null };
}
const rgb = (color: RGBA) => color.toInts().slice(0, 3);

async function mount() {
  const app = await createTestRenderer({ width: 140, height: 28, kittyKeyboard: true });
  uiTheme(app.renderer).configure(palette());
  const selection = new WorkspaceSelection(demoWorkspace());
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, onPrompt: () => ok(undefined),
    getSessionDetails: () => ({ status: null, error: null, output: "Theme-sensitive transcript" }),
    initialDrafts: { a1: "unsent request" },
  });
  await app.renderOnce();
  const span = (text: string) => {
    const value = app.captureSpans().lines.flatMap((line) => line.spans).find((item) => item.text.includes(text));
    if (!value) throw new Error(`Missing colored text: ${text}`);
    return value;
  };
  const identitySpan = () => {
    const column = app.captureCharFrame().split("\n")[app.renderer.height - 1]!.indexOf("AGENT");
    let x = 0;
    const value = app.captureSpans().lines.at(-1)!.spans.find((item) => { x += item.width; return x > column; });
    if (!value) throw new Error("Missing footer identity");
    return value;
  };
  return { ...app, view, selection, span, identitySpan, async close() { view.dispose(); await app.dispose(); } };
}

test("Full screens use terminal defaults/ANSI and immediately switch to light themes", async () => {
  // Distinct host colors expose old hardcoded panel, text and footer colors.
  const app = await mount();
  try {
    expect(rgb(app.span("Theme-sensitive transcript").fg)).toEqual([236, 236, 236]);
    expect(rgb(app.span("Theme-sensitive transcript").bg)).toEqual([20, 20, 20]);
    expect(rgb(app.span("×").fg)).toEqual([17, 119, 153]);
    expect(rgb(app.identitySpan().fg)).toEqual([255, 255, 255]);
    expect(app.identitySpan().fg.intent).toBe("rgb");
    expect(rgb(app.identitySpan().bg)).toEqual([17, 119, 153]);
    const prompt = app.renderer.root.findDescendantById("session-prompt");
    if (!(prompt instanceof PromptInput)) throw new Error("Missing Agent input");
    prompt.focus(); await app.mockInput.typeText(" draft"); await app.renderOnce();
    const before = app.captureCharFrame(), selected = app.selection.sessionId;

    // A palette change must repaint existing controls without remounting the screen.
    app.renderer.emit("palette", palette(true)); await app.renderOnce();

    expect(app.captureCharFrame()).toBe(before);
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.selection.sessionId).toBe(selected);
    expect(app.view.promptDrafts.a1).toBe("unsent request draft");
    expect(rgb(app.span("Theme-sensitive transcript").fg)).toEqual([32, 32, 32]);
    expect(rgb(app.span("Theme-sensitive transcript").bg)).toEqual([250, 250, 246]);
    expect(rgb(app.span("unsent request draft").fg)).toEqual([32, 32, 32]);
    expect(rgb(app.identitySpan().fg)).toEqual([250, 250, 246]);
    expect(app.identitySpan().fg.intent).toBe("rgb");
    expect(rgb(app.identitySpan().bg)).toEqual([17, 119, 153]);
  } finally { await app.close(); }
});

test("Sidebar-to-borderless-input focus preserves selection and drafts", async () => {
  // Both a selected session and an existing draft remain owned by the same Agent view.
  const app = await mount();
  const sidebar = app.renderer.root.findDescendantById("workspace-sidebar")!;
  const composer = app.renderer.root.findDescendantById("agent-composer")!;
  const border = (box: typeof sidebar) => {
    let x = 0;
    const column = box.x + box.width - 1;
    return app.captureSpans().lines[box.y]!.spans.find((span) => { x += span.width; return x > column; })!.fg;
  };
  try {
    const colors = uiTheme(app.renderer).colors;
    openWorkspaceSearch(app); await app.renderOnce();
    expect(border(sidebar).equals(colors.accent)).toBe(true);

    // Focusing an input must not activate another tab, select a session or send its draft.
    app.mockInput.pressEscape(); await app.renderOnce();

    const frame = app.captureCharFrame().split("\n");
    for (const y of [composer.y, composer.y + composer.height - 1]) expect(frame[y]!.slice(composer.x, composer.x + composer.width).trim()).toBe("");
    expect(app.renderer.root.findDescendantById("workspace-picker")!.visible).toBe(false);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.view.promptDrafts.a1).toBe("unsent request");
    expect(app.captureCharFrame()).toContain("Theme-sensitive transcript");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
  } finally { await app.close(); }
});

test("Unqueryable terminals retain default and ANSI color intent", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  try {
    // Null responses must not force the old application-specific dark RGB palette.
    const theme = uiTheme(app.renderer);
    theme.configure({ ...palette(), defaultForeground: null, defaultBackground: null, palette: [] });

    expect(theme.colors.text.intent).toBe("default");
    expect(theme.colors.panel.intent).toBe("default");
    expect(theme.colors.accent.intent).toBe("indexed");
    expect(theme.colors.accent.slot).toBe(6);
    expect(theme.colors.selected.intent).toBe("rgb");
  } finally { await app.dispose(); }
});

test("Only explicit overrides stay fixed while other colors follow later terminal themes", async () => {
  const app = await mount();
  try {
    const theme = uiTheme(app.renderer);
    theme.configure(palette(), { accent: "#ABCDEF", added: "#224422", removed: "#442222" });

    app.renderer.emit("palette", palette(true)); await app.renderOnce();

    expect(rgb(app.span("×").fg)).toEqual([171, 205, 239]);
    expect(rgb(app.span("Theme-sensitive transcript").bg)).toEqual([250, 250, 246]);
    expect(theme.colors.accent.intent).toBe("rgb");
    expect(theme.colors.panel.intent).toBe("default");
    expect(rgb(theme.colors.added)).toEqual([34, 68, 34]);
    expect(rgb(theme.colors.removed)).toEqual([68, 34, 34]);
  } finally { await app.close(); }
});

test("Same-dark-mode theme changes requery palettes after notifications", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 });
  const foreground = "\x1b]10;rgb:eeee/eeee/eeee\x07", background = "\x1b]11;rgb:1212/1212/1212\x07";
  // Establish the renderer's existing dark mode through the actual input parser.
  app.mockInput.pressKey(foreground); app.mockInput.pressKey(background);
  const theme = uiTheme(app.renderer); theme.configure(palette());
  // The test renderer has no active OS terminal; only its outgoing query boundary is replaced.
  const nativeControl = NativeSession.prototype.control;
  const control = spyOn(NativeSession.prototype, "control").mockImplementation(function (this: NativeSession, command) {
    if (command.kind !== "query-theme-colors") nativeControl.call(this, command);
  });
  const query = spyOn(app.renderer, "getPalette").mockImplementation(async () => {
    const next = { ...palette(), defaultBackground: "#102030" };
    app.renderer.emit("palette", next); return next;
  });
  try {
    expect(app.renderer.themeMode).toBe("dark");

    app.mockInput.pressKey("\x1b[?997;2n");
    app.mockInput.pressKey(foreground); app.mockInput.pressKey(background);
    await Promise.resolve();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({ size: 256, timeout: 200 });
    expect(rgb(theme.colors.panel)).toEqual([16, 32, 48]);
    expect(app.renderer.themeMode).toBe("dark");
  } finally { query.mockRestore(); control.mockRestore(); await app.dispose(); }
});

test("Terminal themes stay isolated and destroyed screens unsubscribe", async () => {
  const first = await createTestRenderer({ width: 20, height: 3 });
  const second = await createTestRenderer({ width: 20, height: 3 });
  try {
    // Both renderers may attach to one runtime but must not share presentation state.
    const a = uiTheme(first.renderer), b = uiTheme(second.renderer);
    a.configure(palette()); b.configure(palette(true));
    const owner = new BoxRenderable(first.renderer, { width: 1, height: 1 }); first.renderer.root.add(owner);
    let paints = 0; a.bind(owner, () => { paints++; }); owner.destroyRecursively();

    first.renderer.emit("palette", { ...palette(), defaultBackground: "#102030" });

    expect(rgb(a.colors.panel)).toEqual([16, 32, 48]);
    expect(rgb(b.colors.panel)).toEqual([250, 250, 246]);
    expect(paints).toBe(1);
    await first.dispose();
    expect(first.renderer.listenerCount("palette")).toBe(0);
    expect(first.renderer.listenerCount("theme_mode")).toBe(0);
  } finally { await first.dispose(); await second.dispose(); }
});
