import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { EditBufferRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ClipboardError } from "../../errors.ts";
import { err, ok } from "../../result.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import type { WorkViewPreferences } from "../../runtime/protocol.ts";

const sections = (): TranscriptSection[] => [
  {
    id: "user",
    kind: "user",
    title: "You",
    text: "한글 👨‍👩‍👧‍👦 é words\nsecond user line",
    status: "complete",
  },
  {
    id: "thinking",
    kind: "thinking",
    title: "Thinking",
    text: "Private display reasoning\nsecond thinking line",
    status: "complete",
  },
  {
    id: "tool",
    kind: "tool",
    title: "unknown_mcp_bridge",
    summary: '{"anything":"generic"}',
    text: 'Arguments:\n{"anything":"generic"}\n\nResult:\nfull tool output',
    status: "error",
    error: "Permission denied",
  },
  {
    id: "assistant",
    kind: "assistant",
    title: "Agent",
    text: "First answer line\nsecond answer line",
    status: "streaming",
  },
];

async function mount(initial = sections(), actions: Partial<WorkbenchActions> = {}) {
  const app = await createTestRenderer({
    width: 120,
    height: 30,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const selection = new WorkspaceSelection(demoWorkspace());
  let current = initial;
  const copied: string[] = [];
  const sent: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    initialDrafts: { a1: "retained draft" },
    onPrompt: (_id, text) => {
      sent.push(text);

      return ok(undefined);
    },
    onCopyTranscript: async (text) => {
      copied.push(text);

      return ok("Copied to clipboard");
    },
    getSessionDetails: () => ({
      status: "working",
      output: "legacy preview",
      error: null,
      sections: current,
    }),
    ...actions,
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };

  await render();

  return {
    ...app,
    view,
    selection,
    copied,
    sent,
    render,
    async transcript() {
      pressLeader(app, "[");
      app.mockInput.pressKey("HOME");
      await render();
    },
    async update(next: TranscriptSection[]) {
      current = next;
      selection.replaceSnapshot(demoWorkspace());
      await render();
    },
    state() {
      return view.workViewPreferences.agentViews?.[selection.sessionId ?? ""];
    },
    async copy() {
      app.mockInput.pressKey("y");
      await Promise.resolve();
      await render();
    },
    async copyLine() {
      app.mockInput.pressKey("y");
      app.mockInput.pressKey("y");
      await Promise.resolve();
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Keyboard section/body/selection/copy navigation never submits drafts or modifies conversations", async () => {
  // Only the clipboard boundary is replaced; the key router and native Unicode buffer are real.
  const app = await mount();
  try {
    await app.transcript();
    app.mockInput.pressEnter();
    await app.render();
    expect(app.captureCharFrame()).toContain("TEXT");
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    await app.copy();

    // Inclusive selection contains two whole Korean graphemes, never partial UTF-8/cells.
    expect(app.copied).toEqual(["한글"]);
    expect(app.captureCharFrame()).toContain("TEXT");
    await app.mockInput.pasteBracketedText("must not edit");
    app.mockInput.pressKey("x");
    app.mockInput.pressBackspace();
    app.mockInput.pressKey("y", { shift: true });
    await Promise.resolve();
    app.mockInput.pressEscape();
    app.mockInput.pressEscape();
    await app.render();

    expect(app.copied.at(-1)).toBe(sections()[0]!.text);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.view.promptDrafts.a1).toBe("retained draft");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Always-visible Thinking and folded tools copy full source without inline error summaries", async () => {
  // Thinking remains prose; only the generic tool details start folded.
  const app = await mount();
  try {
    await app.transcript();
    app.mockInput.pressKey("j");
    await app.copy();
    expect(app.copied.at(-1)).toBe(sections()[1]!.text);
    expect(app.captureCharFrame()).toContain("Private display reasoning");
    app.mockInput.pressKey("z");
    app.mockInput.pressKey("a");
    await app.render();
    expect(app.captureCharFrame()).toContain("Private display reasoning");

    app.mockInput.pressKey("j");
    await app.copy();

    expect(app.copied.at(-1)).toBe(sections()[2]!.text);
    expect(app.captureCharFrame()).not.toContain("Permission denied");
    expect(app.captureCharFrame()).not.toContain("full tool output");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([0, 1, 2, 3])(
  "Body cursors and line copying work for every text kind: %i",
  async (index) => {
    // Ctrl+O expands details; Enter only reads already expanded text, with logical-line copying.
    const app = await mount();
    try {
      await app.transcript();
      for (let i = 0; i < index; i++) {
        app.mockInput.pressKey("j");
      }
      if (sections()[index]!.kind === "tool") {
        app.mockInput.pressKey("o", { ctrl: true });
      }

      app.mockInput.pressEnter();
      app.mockInput.pressKey("HOME");
      await app.copyLine();

      expect(app.copied).toEqual([sections()[index]!.text.split("\n")[0]! + "\n"]);
      expect(app.captureCharFrame()).toContain("TEXT");
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Emoji/combining-character selections copy identical source after resize", async () => {
  // A ZWJ family emoji and combining accent exercise cell offsets rather than JS string indices.
  const text = "👨‍👩‍👧‍👦é 한글 " + "wrapped ".repeat(20);
  const app = await mount([
    { id: "unicode", kind: "assistant", title: "Agent", text, status: "complete" },
  ]);
  try {
    await app.transcript();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    app.resize(60, 12);
    await app.render();
    await app.copy();

    expect(app.copied).toEqual(["👨‍👩‍👧‍👦é"]);
    app.mockInput.pressKey("y", { shift: true });
    await Promise.resolve();
    expect(app.copied.at(-1)).toBe(text);
    expect(app.captureCharFrame()).toContain("TEXT");
  } finally {
    await app.close();
  }
});

test("Streaming preserves selection, cursors, and folding while only latest-navigation resumes following", async () => {
  const initial = [
    ...sections(),
    ...Array.from({ length: 20 }, (_, index): TranscriptSection => ({
      id: `later-${index}`,
      kind: "assistant",
      title: "Agent",
      text: `later ${index}\nmore output`,
      status: "complete",
    })),
  ];
  const app = await mount(initial);
  try {
    // The reader deliberately pauses on old content and leaves an active selection there.
    await app.transcript();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    await app.render();

    const before = app.state();
    const next = [
      ...initial,
      {
        id: "newest",
        kind: "assistant" as const,
        title: "Agent",
        text: "LATEST OUTPUT",
        status: "streaming" as const,
      },
    ];

    await app.update(next);

    expect(app.state()?.selectedId).toBe("user");
    expect(app.state()?.mode).toBe("visual");
    expect(app.state()?.cursors.user).toBe(before?.cursors.user);
    expect(app.captureCharFrame()).not.toContain("LATEST OUTPUT");
    await app.copy();
    expect(app.copied).toEqual(["한글"]);

    // Latest is an explicit action, not a side effect of streaming.
    app.mockInput.pressKey("g");
    app.mockInput.pressKey("e");
    await app.render();
    expect(app.captureCharFrame()).toContain("LATEST OUTPUT");
    expect(app.state()?.follow).toBe(true);
  } finally {
    await app.close();
  }
});

test("Replacing streaming bodies within sections preserves selected source ranges", async () => {
  const app = await mount([
    { id: "stream", kind: "assistant", title: "Agent", text: "old text", status: "streaming" },
  ]);
  try {
    await app.transcript();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    await app.update([
      {
        id: "stream",
        kind: "assistant",
        title: "Agent",
        text: "old text plus more",
        status: "complete",
      },
    ]);
    await app.copy();

    expect(app.copied).toEqual(["ol"]);
    expect(app.state()?.selectedId).toBe("stream");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Copy failures preserve selection and report stable error codes", async () => {
  const app = await mount(undefined, {
    onCopyTranscript: async () => err(new ClipboardError("Unavailable in test")),
  });
  try {
    await app.transcript();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("v");
    await app.copy();

    expect(app.captureCharFrame()).toContain("CLIPBOARD_UNAVAILABLE");
    expect(app.state()?.mode).toBe("visual");
    expect((app.renderer.currentFocusedRenderable as EditBufferRenderable).getSelectedText()).toBe(
      "한",
    );
  } finally {
    await app.close();
  }
});

test("Serialized navigation restores folding, selections, and cursors in new UIs", async () => {
  let preferences: WorkViewPreferences | undefined;
  const app = await mount(undefined, {
    onWorkViewsChange: (next) => {
      preferences = next;
    },
  });
  try {
    await app.transcript();
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("o", { ctrl: true });
    app.mockInput.pressEnter();
    app.mockInput.pressKey("l");
    await app.render();
    expect(preferences?.agentViews?.a1?.selectedId).toBe("tool");
    expect(preferences?.agentViews?.a1?.folded.tool).toBe(false);
  } finally {
    await app.close();
  }

  const next = await mount(undefined, { initialWorkViews: preferences! });
  try {
    pressLeader(next, "[");
    await next.render();

    expect(next.state()?.selectedId).toBe("tool");
    expect(next.state()?.mode).toBe("text");
    expect((next.renderer.currentFocusedRenderable as EditBufferRenderable).cursorOffset).toBe(1);
    expect(next.captureCharFrame()).toContain("Arguments:");
    expect((next.renderer.currentFocusedRenderable as EditBufferRenderable).plainText).toBe(
      sections()[2]!.text,
    );
  } finally {
    await next.close();
  }
});

test("Body commands respect user keymaps while pending prefixes and pastes never edit", async () => {
  // Remapped text motion must use the same routing and help metadata as the defaults.
  const keymap = expectOk(
    parseKeymap({
      timeoutMs: 100,
      bindings: {
        "transcript.right": [{ keys: "s", scope: "transcript-text" }],
      },
    }),
  );
  const app = await mount(undefined, { keymap });
  try {
    await app.transcript();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("s");

    const body = app.renderer.currentFocusedRenderable as EditBufferRenderable;
    expect(body.cursorOffset).toBe(2);
    app.mockInput.pressKey("l");
    expect(body.cursorOffset).toBe(2);
    app.mockInput.pressKey("z");
    await app.mockInput.pasteBracketedText("a replace");
    app.mockInput.pressKey("y", { shift: true });
    await Promise.resolve();

    expect(app.copied.at(-1)).toBe(sections()[0]!.text);
    expect(app.view.promptDrafts.a1).toBe("retained draft");
  } finally {
    await app.close();
  }
});

test("Earlier section growth preserves reading-body screen positions and selections", async () => {
  const initial: TranscriptSection[] = [
    {
      id: "before",
      kind: "assistant",
      title: "Agent",
      text: "previous output",
      status: "streaming",
    },
    { id: "target", kind: "user", title: "You", text: "TARGET word", status: "complete" },
    // Trailing content permits preserving this anchor without clamping at the end of the transcript.
    {
      id: "tail",
      kind: "assistant",
      title: "Agent",
      text: "tail\n".repeat(30),
      status: "complete",
    },
  ];
  const app = await mount(initial);
  try {
    // Keep a visible selection below the streaming section; absolute scroll offsets alone are insufficient.
    await app.transcript();
    app.mockInput.pressKey("j");
    app.mockInput.pressEnter();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    await app.render();

    const y = app
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("TARGET"));

    await app.update([
      { ...initial[0]!, text: "previous output\n".repeat(35) },
      ...initial.slice(1),
    ]);
    await app.copy();

    expect(
      app
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("TARGET")),
    ).toBe(y);
    expect(app.copied).toEqual(["TA"]);
    expect(app.state()?.selectedId).toBe("target");
  } finally {
    await app.close();
  }
});

test("Session round-trips keep body cursors and selection modes isolated", async () => {
  const app = await mount();
  try {
    await app.transcript();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("l");
    app.mockInput.pressKey("v");
    await app.render();
    app.selection.selectSession("demo:feature", "b1");
    await app.render();
    await app.transcript();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("l");
    app.mockInput.pressKey("l");
    await app.render();

    app.selection.selectSession("demo:main", "a1");
    await app.render();

    expect(app.state()?.mode).toBe("visual");
    expect((app.renderer.currentFocusedRenderable as EditBufferRenderable).cursorOffset).toBe(2);
    expect((app.renderer.currentFocusedRenderable as EditBufferRenderable).getSelectedText()).toBe(
      "글",
    );
    expect(app.view.workViewPreferences.agentViews?.b1?.cursors.user).toBe(4);
    expect(app.view.promptDrafts.a1).toBe("retained draft");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Late copy acceptance never clears subsequently changed selection ranges", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof ok<string>>>();
  const app = await mount(undefined, { onCopyTranscript: () => pending.promise });
  try {
    await app.transcript();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("y");
    await Promise.resolve();
    app.mockInput.pressKey("l");

    pending.resolve(ok("Copied to clipboard"));
    await app.render();

    expect(app.state()?.mode).toBe("visual");
    expect((app.renderer.currentFocusedRenderable as EditBufferRenderable).getSelectedText()).toBe(
      "한글",
    );
  } finally {
    pending.resolve(ok("Copied to clipboard"));
    await app.close();
  }
});

test("Compact help scrolls and returns to existing body navigation on close", async () => {
  const app = await mount();
  try {
    await app.transcript();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("l");
    app.resize(60, 12);
    await app.render();
    app.mockInput.pressKey("F1");
    await app.render();
    expect(app.captureCharFrame()).toContain("Sections:");
    expect(app.captureCharFrame().split("\n")[11]).toContain("AGENT");
    app.mockInput.pressKey("END");
    await app.render();

    const area = app.renderer.root.findDescendantById("session-transcript")! as ScrollBoxRenderable;
    const helpText = () =>
      app
        .captureCharFrame()
        .split("\n")
        .slice(area.viewport.y, area.viewport.y + area.viewport.height)
        .map((line) => line.slice(area.viewport.x, area.viewport.x + area.viewport.width).trim())
        .join(" ");
    // All guidance remains readable despite width-dependent wrapping after hiding bars.
    let tail = helpText();
    do {
      const previous = area.scrollTop;
      app.mockInput.pressArrow("up");
      await app.render();
      expect(area.scrollTop).toBe(Math.max(0, previous - 1));
      tail = `${helpText()} ${tail}`;
    } while (!tail.includes("close help") && area.scrollTop > 0);

    expect(tail).toContain("close help");

    app.mockInput.pressEscape();
    await app.render();

    expect(app.captureCharFrame()).toContain("TEXT");
    expect((app.renderer.currentFocusedRenderable as EditBufferRenderable).cursorOffset).toBe(2);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Fold-all preferences survive streaming and empty conversations restore logos", async () => {
  const app = await mount();
  try {
    await app.transcript();
    app.mockInput.pressKey("z");
    app.mockInput.pressKey("m");
    await app.render();
    await app.update(
      sections().map((section) => ({ ...section, text: section.text + "\nmore streamed content" })),
    );
    expect(app.captureCharFrame()).not.toContain("second answer line");
    expect(app.state()?.folded.assistant).toBe(true);
    app.mockInput.pressKey("z");
    app.mockInput.pressKey("r");
    app.mockInput.pressEnter();
    await app.render();

    await app.update([]);

    expect(app.renderer.root.findDescendantById("radian-logo")?.visible).toBe(true);
    expect(app.captureCharFrame()).not.toContain("No messages yet");
    expect(app.state()?.selectedId).toBeNull();
    expect(app.state()?.mode).toBe("sections");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Word, line, and section motions select full source and dollar keys follow real input", async () => {
  const text = "alpha beta\nlast";
  const app = await mount([
    { id: "words", kind: "assistant", title: "Agent", text, status: "complete" },
  ]);
  try {
    await app.transcript();
    app.mockInput.pressEnter();

    const body = app.renderer.currentFocusedRenderable as EditBufferRenderable;
    app.mockInput.pressKey("w");
    expect(body.cursorOffset).toBe(6);
    app.mockInput.pressKey("b");
    expect(body.cursorOffset).toBe(0);
    app.mockInput.pressKey("$");
    expect(body.logicalCursor.col).toBe(9);
    app.mockInput.pressKey("g", { shift: true });
    await app.copyLine();
    expect(app.copied.at(-1)).toBe("last");

    app.mockInput.pressKey("g");
    app.mockInput.pressKey("g");
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("g", { shift: true });
    await app.copy();

    expect(app.copied.at(-1)).toBe(text);
    // Moving back inside an active selection must shrink it by one character, not collapse to its anchor.
    app.mockInput.pressKey("g");
    app.mockInput.pressKey("g");
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("w");
    app.mockInput.pressKey("h");
    await app.copy();
    expect(app.copied.at(-1)).toBe("alpha ");
    expect(app.view.promptDrafts.a1).toBe("retained draft");
  } finally {
    await app.close();
  }
});

test("Following selects new sections while actual upward scrolling fixes selection", async () => {
  const app = await mount();
  try {
    await app.update([
      ...sections(),
      {
        id: "latest",
        kind: "assistant",
        title: "Agent",
        text: "LATEST SECTION\n\n".repeat(20),
        status: "streaming",
      },
    ]);
    expect(app.state()?.selectedId).toBe("latest");
    expect(app.state()?.follow).toBe(true);

    pressLeader(app, "[");
    await app.render();

    const area = app.renderer.root.findDescendantById("session-transcript")! as ScrollBoxRenderable;
    const previous = area.scrollTop;

    expect(previous).toBeGreaterThan(0);
    await app.mockMouse.scroll(area.x + 2, area.y + 2, "up");
    await app.render();
    expect(area.scrollTop).toBeLessThan(previous);
    await app.update([
      ...sections(),
      {
        id: "latest",
        kind: "assistant",
        title: "Agent",
        text: "LATEST SECTION\n\n".repeat(20) + "more",
        status: "complete",
      },
      {
        id: "newer",
        kind: "assistant",
        title: "Agent",
        text: "newer section",
        status: "streaming",
      },
    ]);

    expect(app.state()?.selectedId).toBe("latest");
    expect(app.state()?.follow).toBe(false);
  } finally {
    await app.close();
  }
});

test("Legacy runtime previews remain identifiable after folding and support source copying", async () => {
  const text = "legacy first\nlegacy second";
  const app = await mount(undefined, {
    getSessionDetails: () => ({ status: null, error: null, output: text }),
  });
  try {
    await app.transcript();
    app.mockInput.pressKey("z");
    app.mockInput.pressKey("a");
    await app.copy();

    expect(app.captureCharFrame()).toContain("[Transcript] (<C-o> to expand)");
    expect(app.captureCharFrame()).toContain("legacy preview");
    expect(app.captureCharFrame()).not.toContain("legacy first");
    expect(app.copied).toEqual([text]);
  } finally {
    await app.close();
  }
});
