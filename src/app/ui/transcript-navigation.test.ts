import { expect, test } from "bun:test";
import { EditBufferRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { ok } from "../../result.ts";
import { pressLeader } from "../../testing/keys.ts";
import type { WorkViewPreferences } from "../../runtime/protocol.ts";

const toolText = Array.from({ length: 80 }, (_, index) => `tool line ${index}`).join("\n");
const toolSections = (): TranscriptSection[] => [
  { id: "before", kind: "user", title: "You", text: "BEFORE", status: "complete" },
  { id: "tool", kind: "tool", title: "read", text: toolText, status: "complete" },
  { id: "after", kind: "assistant", title: "Agent", text: "AFTER", status: "complete" },
];

async function mount(sections = toolSections(), actions: Partial<WorkbenchActions> = {}) {
  const app = await createTestRenderer({
    width: 110,
    height: 30,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const copied: string[] = [];
  const sent: string[] = [];
  const selection = new WorkspaceSelection(demoWorkspace());
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    initialDrafts: { a1: "retained draft" },
    onPrompt: (_id, text) => {
      sent.push(text);

      return ok(undefined);
    },
    onCopyTranscript: async (text) => {
      copied.push(text);

      return ok("Copied");
    },
    getSessionDetails: () => ({ status: "complete", output: "", error: null, sections }),
    ...actions,
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };

  await render();

  const scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(scroll instanceof ScrollBoxRenderable)) {
    throw new Error("Missing transcript");
  }

  const reader = () => {
    const focused = app.renderer.currentFocusedRenderable;
    if (!(focused instanceof EditBufferRenderable)) {
      throw new Error("Missing reader");
    }

    return focused;
  };

  return {
    ...app,
    selection,
    view,
    scroll,
    copied,
    sent,
    render,
    reader,
    state: () => view.workViewPreferences.agentViews?.a1,
    async sections() {
      pressLeader(app, "[");
      app.mockInput.pressKey("HOME");
      await render();
    },
    async tool() {
      pressLeader(app, "[");
      app.mockInput.pressKey("HOME");
      app.mockInput.pressKey("j");
      app.mockInput.pressKey("o", { ctrl: true });
      app.mockInput.pressEnter();
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Half/full-page section jumps select by rendered distance without opening workspace search", async () => {
  // Single-line cards have a two-row stride; no fixed item count is baked into navigation.
  const sections: TranscriptSection[] = Array.from({ length: 40 }, (_, index) => ({
    id: `s${index}`,
    kind: "assistant",
    title: "Agent",
    text: `body ${index}`,
    status: "complete",
  }));
  const app = await mount(sections);
  try {
    await app.sections();

    const half = Math.floor(app.scroll.viewport.height / 4);
    const full = Math.floor((app.scroll.viewport.height - 1) / 2);

    app.mockInput.pressKey("d", { ctrl: true });
    await app.render();
    expect(app.state()?.selectedId).toBe(`s${half}`);
    app.mockInput.pressKey("u", { ctrl: true });
    await app.render();
    expect(app.state()?.selectedId).toBe("s0");
    app.mockInput.pressKey("f", { ctrl: true });
    await app.render();
    expect(app.state()?.selectedId).toBe(`s${full}`);
    app.mockInput.pressKey("b", { ctrl: true });
    await app.render();

    expect(app.state()?.selectedId).toBe("s0");
    expect(app.renderer.root.findDescendantById("workspace-sidebar")?.visible).toBe(false);
    app.mockInput.pressKey("j");
    expect(app.state()?.selectedId).toBe("s1");
    app.mockInput.pressKey("k");
    expect(app.state()?.selectedId).toBe("s0");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Folding keeps Text mode and restores the body cursor when reopened", async () => {
  // Header and body offsets are separate coordinate spaces, not a reason to leave reading mode.
  const app = await mount();
  try {
    await app.tool();
    app.reader().setCursor(25, 3);

    const offset = app.reader().cursorOffset;
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();
    expect(app.state()?.mode).toBe("text");
    expect(app.state()?.folded.tool).toBe(true);
    expect(app.reader().plainText).toContain("read");
    expect(app.reader().plainText).not.toContain("tool line 25");
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();

    expect(app.state()?.mode).toBe("text");
    expect(app.state()?.folded.tool).toBe(false);
    expect(app.reader().plainText).toBe(toolText);
    expect(app.reader().cursorOffset).toBe(offset);
    expect(app.view.promptDrafts.a1).toBe("retained draft");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Text up/down traverses the expanded header and adjacent visible sections", async () => {
  // The tool's first body line must not trap the cursor below its visible heading.
  const app = await mount();
  try {
    await app.tool();
    app.reader().gotoBufferHome();
    app.mockInput.pressKey("k");
    await app.render();
    expect(app.state()?.selectedId).toBe("tool");
    expect(app.state()?.readingHeading).toBe(true);
    expect(app.reader().plainText).toContain("read");
    app.mockInput.pressKey("k");
    await app.render();
    expect(app.state()?.selectedId).toBe("before");
    expect(app.reader().plainText).toBe("BEFORE");
    app.mockInput.pressKey("j");
    await app.render();
    expect(app.state()?.selectedId).toBe("tool");
    expect(app.state()?.readingHeading).toBe(true);
    app.mockInput.pressKey("j");
    await app.render();

    expect(app.reader().plainText).toBe(toolText);
    expect(app.reader().logicalCursor.row).toBe(0);
    expect(app.state()?.mode).toBe("text");
    expect(app.state()?.readingHeading).toBeUndefined();
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Counted vertical motions continue across heading/body boundaries", async () => {
  // Native movement effects must refresh their active reader after each crossed surface.
  const app = await mount();
  try {
    await app.sections();
    app.mockInput.pressEnter();
    await app.render();
    app.mockInput.pressKey("j");
    await app.render();
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();
    app.mockInput.pressKey("k");
    app.mockInput.pressKey("k");
    await app.render();
    expect(app.state()?.selectedId).toBe("before");
    app.mockInput.pressKey("4");
    app.mockInput.pressKey("j");
    await app.render();

    expect(app.state()?.selectedId).toBe("tool");
    expect(app.reader().logicalCursor.row).toBe(2);
    expect(app.state()?.mode).toBe("text");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Full-page Text movement reads expanded output rather than skipping its section", async () => {
  // Pages move the active body cursor, so the viewport follows the text being read.
  const app = await mount();
  try {
    await app.tool();
    app.reader().gotoBufferHome();

    const page = app.scroll.viewport.height - 1;
    app.mockInput.pressKey("f", { ctrl: true });
    await app.render();

    expect(app.state()?.selectedId).toBe("tool");
    expect(app.reader().logicalCursor.row).toBe(page);
    expect(app.scroll.scrollTop).toBeGreaterThan(0);
    expect(app.state()?.mode).toBe("text");
    app.mockInput.pressKey("b", { ctrl: true });
    await app.render();
    expect(app.reader().logicalCursor.row).toBe(0);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Folding a Visual selection cancels hidden ranges but stays in Text mode", async () => {
  // A selection must not be reapplied to unrelated heading coordinates after folding.
  const app = await mount();
  try {
    await app.tool();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();

    expect(app.state()?.mode).toBe("text");
    expect(app.state()?.anchor).toBeNull();
    expect(app.reader().hasSelection()).toBe(false);
    app.mockInput.pressKey("y", { shift: true });
    await app.render();
    expect(app.copied).toEqual([toolText]);
  } finally {
    await app.close();
  }
});

test("An expanded heading reader survives warm restoration with its own cursor", async () => {
  // Restoring a header offset must not reinterpret it as an offset into the tool body.
  const app = await mount();
  let preferences: WorkViewPreferences | undefined;
  try {
    await app.tool();
    app.mockInput.pressKey("k");
    await app.render();
    app.reader().cursorOffset = 2;
    pressLeader(app, "b");
    app.mockInput.pressEscape();
    await app.render();
    preferences = app.view.workViewPreferences;
    expect(preferences.agentViews?.a1?.readingHeading).toBe(true);
  } finally {
    await app.close();
  }

  const next = await mount(toolSections(), { initialWorkViews: preferences });
  try {
    pressLeader(next, "[");
    await next.render();

    expect(next.state()?.mode).toBe("text");
    expect(next.state()?.readingHeading).toBe(true);
    expect(next.reader().plainText).toContain("read");
    expect(next.reader().cursorOffset).toBe(2);
    expect(next.sent).toEqual([]);
  } finally {
    await next.close();
  }
});
