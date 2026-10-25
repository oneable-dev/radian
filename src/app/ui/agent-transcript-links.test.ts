import { expect, test } from "bun:test";
import { CodeRenderable, EditBufferRenderable, parseKeypress, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { pressLeader, pressTranscriptRead } from "../../testing/transcript-keys.ts";
import { expectOk } from "../../testing/results.ts";
import { BrowserError } from "../../errors.ts";
import { err, ok } from "../../result.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";

function descendants(root: Renderable): Renderable[] { return root.getChildren().flatMap(child => [child, ...descendants(child)]); }
async function mount(text: string, actions: Partial<WorkbenchActions> = {}, kind: TranscriptSection["kind"] = "assistant") {
  const app = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const opened: string[] = [], sent: string[] = [];
  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), {
    onNewSession: () => {}, onCloseSession: () => {}, initialDrafts: { a1: "Keep this draft" },
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); },
    onOpenTranscriptUrl: async url => { opened.push(url); return ok(undefined); },
    getSessionDetails: () => ({ status: "complete", output: "", error: null, sections: [{ id: "answer", kind, title: "Agent", text, status: "complete" }] }),
    ...actions,
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  await render();
  return { ...app, view, opened, sent, render,
    async settled() {
      for (let i = 0; i < 3; i++) {
        await Promise.all(descendants(app.renderer.root).filter((node): node is CodeRenderable => node instanceof CodeRenderable).map(node => node.highlightingDone));
        await render();
      }
    },
    async source(at: string) {
      pressTranscriptRead(app, actions.keymap); app.mockInput.pressKey("HOME"); app.mockInput.pressEnter(); await render();
      const body = app.renderer.currentFocusedRenderable;
      if (!(body instanceof EditBufferRenderable)) throw new Error("Missing source cursor");
      const offset = body.plainText.indexOf(at);
      if (offset < 0) throw new Error(`Missing source text ${at}`);
      body.cursorOffset = body.editBuffer.measureText(body.plainText.slice(0, offset));
      return body;
    },
    position(label: string) {
      const lines = app.captureCharFrame().split("\n"), y = lines.findIndex(line => line.includes(label));
      if (y < 0) throw new Error(`Missing ${label}`);
      return { x: Bun.stringWidth(lines[y]!.slice(0, lines[y]!.indexOf(label))), y };
    },
    async gx() { app.mockInput.pressKey("g"); app.mockInput.pressKey("x"); await render(); },
    async close() { view.dispose(); await app.dispose(); },
  };
}

test("gx on Markdown labels after Unicode opens targets while preserving source and drafts", async () => {
  // Labels differ from URLs; prefix cell widths differ from JS string lengths.
  const app = await mount("한글 👨‍👩‍👧‍👦 é [문서 보기](https://example.invalid/docs?q=one&next=two)");
  try {
    const body = await app.source("문서 보기"), cursor = body.cursorOffset;

    // Send only the link under the reading cursor to the external browser.
    await app.gx(); await app.waitFor(() => app.opened.length === 1);

    // Opening links neither moves cursors nor submits prompts.
    expect(app.opened).toEqual(["https://example.invalid/docs?q=one&next=two"]);
    expect(body.cursorOffset).toBe(cursor); expect(app.renderer.currentFocusedRenderable).toBe(body);
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Plain-URL gx and Visual selection preserve selected text while opening browsers", async () => {
  // Literal bodies such as code output also support localhost links.
  const app = await mount("Visit http://localhost:3000/path_(part).", {}, "user");
  try {
    const body = await app.source("http://"); app.mockInput.pressKey("v"); app.mockInput.pressKey("l");
    const selection = body.getSelectedText();

    await app.gx(); await app.waitFor(() => app.opened.length === 1);

    // Exclude sentence punctuation while retaining existing selection.
    expect(app.opened).toEqual(["http://localhost:3000/path_(part)"]);
    expect(body.getSelectedText()).toBe(selection);
  } finally { await app.close(); }
});

test("Clicking rendered Markdown links opens actual targets exactly once", async () => {
  // App clicks must work even when the test terminal lacks OSC 8.
  const app = await mount("[Open documentation](https://example.invalid/docs)");
  try {
    await app.settled(); const { x, y } = app.position("Open documentation");

    await app.mockMouse.click(x + 2, y); await app.waitFor(() => app.opened.length === 1);

    expect(app.opened).toEqual(["https://example.invalid/docs"]);
    expect(app.view.promptDrafts.a1).toBe("Keep this draft"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Dragging links to select or right-clicking never opens browsers", async () => {
  // Distinguish mouse text selection from link activation.
  const app = await mount("[Selectable documentation](https://example.invalid/docs)");
  try {
    await app.settled(); const { x, y } = app.position("Selectable documentation");

    await app.mockMouse.drag(x + 1, y, x + 8, y); await app.render();
    await app.mockMouse.click(x + 2, y, 2); await app.render();

    expect(app.opened).toEqual([]); expect(app.renderer.getSelection()?.getSelectedText()).toContain("elect");
  } finally { await app.close(); }
});

test("Plain-body URL clicks resolve correctly across wrapping and Korean prefixes", async () => {
  // Non-Markdown bodies open the same links through mouse and keyboard.
  const app = await mount("안내\n한글 http://localhost:3000/preview", {}, "user");
  try {
    const { x, y } = app.position("http://localhost:3000/preview");

    await app.mockMouse.click(x + 3, y); await app.waitFor(() => app.opened.length === 1);

    expect(app.opened).toEqual(["http://localhost:3000/preview"]);
  } finally { await app.close(); }
});

test.each(["javascript:alert(1)", "file:///tmp/private", "data:text/html,unsafe", "command:run"])("Markdown target %s never reaches browsers", async url => {
  // Even AI-provided links cannot use executable non-web schemes.
  const app = await mount(`[Unsafe target](${url})`);
  try {
    await app.source("Unsafe target");

    await app.gx(); await app.waitForFrame(frame => frame.includes("Only HTTP(S)"));

    expect(app.opened).toEqual([]); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Browser failures show notifications without automatic retries", async () => {
  // GUI-free failures must not become success or cancellation.
  let attempts = 0;
  const app = await mount("https://example.invalid", { onOpenTranscriptUrl: async () => { attempts++; return err(new BrowserError("No browser handler")); } });
  try {
    await app.source("https://");

    await app.gx(); await app.waitForFrame(frame => frame.includes("No browser handler"));

    expect(attempts).toBe(1); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

test("Remapping link opening to o keeps prompt gx literal and updates help", async () => {
  // Overrides replacing gx apply only to bodies.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.open-link": [{ keys: "o", scope: "transcript-text" }] } }));
  const app = await mount("https://example.invalid", { keymap });
  try {
    pressLeader(app, "a"); await app.mockInput.typeText("gx");
    const body = await app.source("https://");

    await app.gx(); expect(app.opened).toEqual([]);
    app.mockInput.pressKey("o"); await app.waitFor(() => app.opened.length === 1);
    app.mockInput.pressKey("F1"); await app.render();

    // Disabled defaults disappear from hints and never submit input.
    expect(app.captureCharFrame()).toContain("o open HTTP(S) link");
    expect(app.view.promptDrafts.a1).toContain("gx"); expect(body.plainText).toBe("https://example.invalid"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Clicking continuation rows opens complete wrapped URLs", async () => {
  // Long addresses remain one source URL despite wrapping across screen rows.
  const url = "http://localhost:3000/" + "segment/".repeat(12) + "wrapped-target";
  const app = await mount("한글 " + url, {}, "user");
  try {
    app.resize(55, 30); await app.render(); const { x, y } = app.position("wrapped-target");

    // Use the actual clicked reading cursor, not the first row.
    await app.mockMouse.click(x + 2, y); await app.waitFor(() => app.opened.length === 1);

    expect(app.opened).toEqual([url]);
  } finally { await app.close(); }
});

test("Non-link characters and blank URL-trailing space never open another address", async () => {
  // Native blank-space cursor correction must not imply activation of nearby URLs.
  const app = await mount("Before http://localhost:3000", {}, "user");
  try {
    await app.source("Before"); const { x, y } = app.position("http://localhost:3000");

    await app.gx();
    await app.mockMouse.click(x + "http://localhost:3000".length + 3, y); await app.render();

    // Navigation misses produce neither a notification nor a retained message.
    expect(app.renderer.root.findDescendantById("session-notifications")?.visible).toBe(false);
    pressLeader(app, "!"); await app.render(); expect(app.captureCharFrame()).toContain("No messages yet");
    expect(app.captureCharFrame()).not.toContain("No HTTP(S) link");
    expect(app.opened).toEqual([]); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
  } finally { await app.close(); }
});

test("Modified link clicks are not intercepted as app browser commands", async () => {
  // Distinguish terminal-owned modified clicks from app-owned plain clicks.
  const app = await mount("[Modified documentation](https://example.invalid/docs)");
  try {
    await app.settled(); const { x, y } = app.position("Modified documentation");

    for (const modifiers of [{ ctrl: true }, { shift: true }, { alt: true }]) {
      await app.mockMouse.click(x + 2, y, 0, { modifiers });
    }
    await app.render();

    expect(app.opened).toEqual([]);
  } finally { await app.close(); }
});

test("Holding remapped o opens once and consumes repeats across focus changes", async () => {
  // Single-key overrides must not spawn repeated browser tabs.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.open-link": [{ keys: "o", scope: "transcript-text" }] } }));
  const app = await mount("https://example.invalid", { keymap });
  const raw = (sequence: string) => {
    const key = parseKeypress(sequence, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid Kitty key");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    await app.source("https://");

    // Consume held repeats as the same action in both bodies and inputs until release.
    raw("\x1b[111u"); raw("\x1b[111;1:2u");
    pressLeader(app, "a"); raw("\x1b[111;1:2u");
    await app.waitFor(() => app.opened.length === 1);

    expect(app.opened).toEqual(["https://example.invalid"]); expect(app.view.promptDrafts.a1).toBe("Keep this draft");
    raw("\x1b[111;1:3u"); app.mockInput.pressKey("o");
    expect(app.view.promptDrafts.a1).toBe("Keep this drafto");
  } finally { await app.close(); }
});

test("Long offscreen Markdown retains the current link's actual target", async () => {
  // Link metadata must not depend on current viewport or a temporary raster.
  const text = "| Link |\n|---|\n| [First target](https://example.invalid/first) |\n\n" + Array.from({ length: 300 }, (_, index) => `row ${index}`).join("\n")
    + "\n\n[Final target](http://localhost:3000/final)";
  const app = await mount(text);
  try {
    await app.settled(); await app.source("Final target");

    // Open only the cursor target, not earlier links or matching screen coordinates.
    await app.gx(); await app.waitFor(() => app.opened.length === 1);

    expect(app.opened).toEqual(["http://localhost:3000/final"]); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Disabling link bindings prevents gx and removes default hints", async () => {
  // Explicit empty bindings must not silently restore defaults.
  const keymap = expectOk(parseKeymap({ bindings: { "transcript.open-link": [] } }));
  const app = await mount("https://example.invalid", { keymap });
  try {
    await app.source("https://");

    await app.gx(); app.mockInput.pressKey("F1"); await app.render();

    expect(app.opened).toEqual([]); expect(app.captureCharFrame()).not.toContain("gx open HTTP(S) link");
  } finally { await app.close(); }
});
