import { pressLeader } from "../../testing/keys.ts";
import { expect, spyOn, test } from "bun:test";
import {
  BoxRenderable,
  CodeRenderable,
  EditBufferRenderable,
  InputRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  parseKeypress,
  type Renderable,
} from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import type { HistoryItem } from "../history.ts";
import type { HistoryPreview } from "../history-preview.ts";
import type { TranscriptSection } from "../transcript.ts";
import type { SessionRecord } from "../session-registry.ts";
import { Workbench } from "../../app/ui/workbench.ts";
import { capture, HistoryError, type ExpectedError } from "../../errors.ts";
import { ok, type Result } from "../../result.ts";
import { parseKeymap, type Keymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";

const saved = (id: string, title = id): HistoryItem => ({
  id,
  title,
  worktreeId: "demo:main",
  modified: "2026-10-14T12:34:00.000Z",
  messageCount: 4,
  openSessionId: null,
  unavailableReason: null,
});
type Options = {
  list?: (id: string, signal?: AbortSignal) => Promise<readonly HistoryItem[]>;
  preview?: (
    tree: string,
    id: string,
    signal?: AbortSignal,
  ) => Promise<Result<HistoryPreview, ExpectedError>>;
  resume?: (tree: string, id: string) => Promise<string>;
  keymap?: Keymap;
  liveSections?: readonly TranscriptSection[];
};
async function mount(options: Options = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, clock });
  const listenerLimit = app.renderer.getMaxListeners(),
    selection = new WorkspaceSelection(demoWorkspace());
  const resumed: string[] = [],
    previews: string[] = [],
    runs: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    ...(options.keymap ? { keymap: options.keymap } : {}),
    onNewSession: () => runs.push("create"),
    onCloseSession: () => runs.push("close"),
    onPrompt: (_id, text) => {
      runs.push(text);
      return ok(undefined);
    },
    initialDrafts: { a1: "untouched draft" },
    getSessionDetails: () => ({
      status: "complete",
      error: null,
      output: Array.from({ length: 80 }, (_, i) => `Transcript line ${i}`).join("\n"),
      ...(options.liveSections ? { sections: options.liveSections } : {}),
    }),
    onListHistory: (id, signal) =>
      capture(() =>
        options.list
          ? options.list(id, signal)
          : Promise.resolve([
              saved("first", "Saved layout review"),
              saved("second", "Saved keyboard navigation"),
            ]),
      ),
    onPreviewHistory: async (tree, id, signal) => {
      previews.push(id);
      return options.preview
        ? options.preview(tree, id, signal)
        : ok({
            id,
            worktreeId: tree,
            text: `You\nSaved question ${id}\n\nAgent\nSaved answer ${id}`,
            truncated: false,
            sections: [
              {
                id: `${id}:prompt`,
                kind: "user",
                title: "You",
                text: `Saved question ${id}`,
                status: "complete",
              },
              {
                id: `${id}:answer`,
                kind: "assistant",
                title: "Agent",
                text: `Saved answer ${id}`,
                status: "complete",
              },
            ],
          });
    },
    onResumeSession: async (tree, id) => {
      resumed.push(`${tree}/${id}`);
      return capture(() => (options.resume ? options.resume(tree, id) : Promise.resolve("a2")));
    },
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  await render();
  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) throw new Error(`Missing ${id}`);
    return node;
  };
  return {
    ...app,
    clock,
    view,
    selection,
    resumed,
    previews,
    runs,
    get,
    render,
    leader(key: string) {
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey(key);
    },
    async open() {
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey("h");
      await render();
    },
    async click(id: string) {
      const node = get(id);
      await app.mockMouse.click(node.x, node.y);
      await render();
    },
    async visible(text: string) {
      const deadline = Date.now() + 1500;
      while (!app.captureCharFrame().includes(text)) {
        if (Date.now() > deadline) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
        await render();
      }
    },
    async close() {
      view.dispose();
      expect(app.renderer.getMaxListeners()).toBe(listenerLimit);
      await app.dispose();
    },
  };
}

test("History is an Agents search popup leaving only Workspace in the sidebar", async () => {
  // Browsing metadata is not a model/session action, and sidebar space is no longer spent on history.
  const app = await mount();
  try {
    expect(app.renderer.root.findDescendantById("agent-history-button")).toBeUndefined();
    await app.open();
    await app.visible("Saved layout review");

    expect(app.get("session-history").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
    expect(app.captureCharFrame()).not.toContain("History · radian");
    expect(app.get("history-search-field").y).toBe(app.get("history-dialog").y);
    expect(app.captureCharFrame()).toContain("2026-10-14 12:34");
    expect(app.captureCharFrame()).toContain("4 messages");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.resumed).toEqual([]);
    expect(app.runs).toEqual([]);
    // Fetch the first candidate without advancing fake time; previews have no loading indicator.
    expect(app.previews).toEqual(["first"]);
    expect(app.captureCharFrame()).toContain("Saved answer first");
    expect(!!app.renderer.root.findDescendantById("history-preview-loading")).toBe(false);
    expect(app.captureCharFrame()).not.toContain("Loading preview");
  } finally {
    await app.close();
  }
});

test.each([120, 60])(
  "History shows counts only inside search without reserving a status row at %s columns",
  async (width) => {
    // Normal results already have matched/total counts in the search field.
    const app = await mount();
    try {
      app.resize(width, 24);
      await app.render();
      await app.open();
      app.clock.advance(500);
      await app.render();
      const search = app.get("history-search") as InputRenderable;
      const field = app.get("history-search-field"),
        list = app.get("history-list");
      const counter = app.get("history-search-count") as TextRenderable;

      // Once loading settles, candidates start directly below search with no duplicate count.
      expect(counter.plainText).toBe("2/2");
      expect(counter.visible).toBe(true);
      expect(app.get("history-list-status").visible).toBe(false);
      expect(list.y).toBe(field.y + field.height);
      expect(app.captureCharFrame()).not.toContain("2 sessions");

      // Filtering updates the inline count without bringing back a status row.
      await app.mockInput.typeText("keyboard");
      app.clock.advance(500);
      await app.render();

      expect(counter.plainText).toBe("1/2");
      expect(counter.visible).toBe(true);
      expect(app.get("history-list-status").visible).toBe(false);
      expect(list.y).toBe(field.y + field.height);
      expect(app.captureCharFrame()).not.toContain("1 session");
      expect(app.captureCharFrame()).toContain("Saved keyboard navigation");
      expect(app.renderer.currentFocusedRenderable).toBe(search);
      expect(app.resumed).toEqual([]);
      expect(app.runs).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Previews reuse Agent cards, folding, and errors and open read-only at the latest content", async () => {
  // Live and preview surfaces receive identical structured data, but must not share view state.
  const sections: TranscriptSection[] = [
    { id: "latest-q", kind: "user", title: "You", text: "Newest prompt", status: "complete" },
    {
      id: "thought",
      kind: "thinking",
      title: "Thinking",
      text: "Visible reasoning",
      status: "complete",
    },
    {
      id: "tool",
      kind: "tool",
      title: "read",
      text: "Arguments:\n{}\n\nResult:\nRead failed",
      status: "error",
      error: "Read failed",
    },
    { id: "answer", kind: "assistant", title: "Agent", text: "Latest reply", status: "complete" },
  ];
  const app = await mount({
    liveSections: sections,
    preview: async (worktreeId, id) =>
      ok({ id, worktreeId, sections, text: "DO NOT RENDER THE LEGACY STRING", truncated: false }),
  });
  const body = (root: Renderable, text: string): EditBufferRenderable | undefined => {
    if (root instanceof EditBufferRenderable && root.plainText === text) return root;
    for (const child of root.getChildren()) {
      const found = body(child, text);
      if (found) return found;
    }
  };
  try {
    const live = app.get("session-transcript"),
      state = app.view.workViewPreferences.agentViews;
    await app.open();
    app.clock.advance(150);
    await app.render();
    const preview = app.get("history-preview") as ScrollBoxRenderable;
    // Preview transcripts share live-session scrollbar policy.
    if (!(live instanceof ScrollBoxRenderable)) throw new Error("Missing live transcript");
    expect(live.verticalScrollBar.visible).toBe(false);
    expect(preview.verticalScrollBar.visible).toBe(false);
    for (const section of sections) {
      const original = body(live, section.text),
        shown = body(preview, section.text);
      if (!(original?.parent instanceof BoxRenderable) || !(shown?.parent instanceof BoxRenderable))
        throw new Error("Expected native section cards");
      expect(shown.parent.backgroundColor.toInts()).toEqual(
        original.parent.backgroundColor.toInts(),
      );
      expect(shown.parent.border).toEqual(original.parent.border);
      expect(shown.parent.paddingLeft).toBe(original.parent.paddingLeft);
      expect(shown.visible).toBe(original.visible);
    }
    // New previews start at the latest answer like live sessions.
    expect(preview.scrollTop).toBe(Math.max(0, preview.scrollHeight - preview.viewport.height));
    expect(app.captureCharFrame()).toContain("Latest reply");
    expect(app.captureCharFrame()).not.toContain("[thinking]");
    expect(app.captureCharFrame()).not.toContain("DO NOT RENDER THE LEGACY STRING");
    const prompt = body(preview, "Newest prompt")!;
    expect(prompt.focusable).toBe(false);
    await app.mockMouse.click(
      preview.viewport.x + 1,
      preview.viewport.y + preview.viewport.height - 1,
    );
    await app.render();
    await app.mockInput.pasteBracketedText("must not edit");
    app.mockInput.pressBackspace();
    await app.render();
    expect(prompt.plainText).toBe("Newest prompt");
    expect(app.view.workViewPreferences.agentViews).toEqual(state);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.resumed).toEqual([]);
    expect(app.runs).toEqual([]);
    app.mockInput.pressEscape();
    await app.render();
    expect(app.get("session-history").visible).toBe(false);
  } finally {
    await app.close();
  }
});

test("History answers and Thinking use the same Markdown without changing search or live sessions", async () => {
  // Previews use the live transcript Markdown renderer, not a separate text converter.
  const sections: TranscriptSection[] = [
    { id: "q", kind: "user", title: "You", text: "Saved question", status: "complete" },
    {
      id: "a",
      kind: "assistant",
      title: "Agent",
      text: "### Preview title\n\n**Saved answer**",
      status: "complete",
    },
    { id: "t", kind: "thinking", title: "Thinking", text: "**Saved thought**", status: "complete" },
  ];
  const app = await mount({
    preview: async (worktreeId, id) => ok({ id, worktreeId, text: "", sections, truncated: false }),
  });
  const children = (node: Renderable): Renderable[] =>
    node.getChildren().flatMap((child) => [child, ...children(child)]);
  try {
    // Three padded cards need a taller dialog to inspect all Markdown surfaces together.
    app.resize(120, 36);
    await app.render();
    await app.open();
    app.clock.advance(150);
    await app.render();
    const preview = app.get("history-preview");
    for (let pass = 0; pass < 3; pass++) {
      await Promise.all(
        children(preview)
          .filter((node): node is CodeRenderable => node instanceof CodeRenderable)
          .map((node) => node.highlightingDone),
      );
      await app.render();
    }
    // Hiding syntax preserves live-session selection, drafts, and read-only behavior.
    const frame = app.captureCharFrame();
    expect(children(preview).filter((node) => node instanceof MarkdownRenderable)).toHaveLength(2);
    expect(frame).toContain("Preview title");
    expect(frame).toContain("Saved answer");
    expect(frame).toContain("Saved thought");
    expect(frame).not.toContain("### Preview title");
    expect(frame).not.toContain("**Saved answer**");
    expect(frame).not.toContain("[thinking]");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.view.promptDrafts.a1).toBe("untouched draft");
    expect(app.runs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("History shows real prompt and status components without changing input, submission, or drafts", async () => {
  // Verify saved model and cancellation state differ from the background session.
  const sections: TranscriptSection[] = [
    { id: "saved-q", kind: "user", title: "You", text: "Saved task", status: "complete" },
    {
      id: "saved-tool",
      kind: "tool",
      title: "read",
      text: "Recovered tool failure",
      status: "error",
      error: "Recovered tool failure",
    },
    {
      id: "saved-a",
      kind: "assistant",
      title: "Agent",
      text: "Saved result",
      status: "cancelled",
      completion: { startedAt: 1000, completedAt: 2000, durationMs: 1000, outcome: "cancelled" },
    },
  ];
  const app = await mount({
    preview: async (worktreeId, id) =>
      ok({
        id,
        worktreeId,
        text: "",
        sections,
        truncated: false,
        telemetry: {
          provider: "fixture",
          model: "saved-model",
          effort: "high",
          fast: null,
          context: null,
          weekly: null,
        },
      }),
  });
  try {
    app.resize(180, 36);
    await app.render();

    // Preview composers and telemetry must look exactly like the actual session components.
    await app.open();
    const prompt = app.get("history-preview-session-prompt") as EditBufferRenderable;
    const composer = app.get("history-preview-agent-composer") as BoxRenderable;
    const liveComposer = app.get("agent-composer") as BoxRenderable;
    const frame = app.captureCharFrame();
    expect(frame).toContain("Ask to do anything");
    expect(frame).not.toContain("Read-only preview");
    expect(frame).toContain("saved-model");
    expect(frame).toContain("Cancelled");
    expect(frame).toContain("context -");
    expect(frame).toContain("usage -");
    expect(composer.border).toEqual(liveComposer.border);
    expect(composer.height).toBe(liveComposer.height);
    expect(app.get("history-preview-session-status").visible).toBe(true);

    // Keys and pastes in read-only input never modify saved history or live drafts.
    await app.mockMouse.click(composer.x + 1, composer.y + 1);
    await app.render();
    expect(prompt.focusable).toBe(false);
    await app.mockInput.typeText("must not send");
    await app.mockInput.pasteBracketedText("pasted text");
    app.mockInput.pressBackspace();
    await app.render();
    expect(prompt.plainText).toBe("");
    expect(app.runs).toEqual([]);
    expect(app.resumed).toEqual([]);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.view.promptDrafts.a1).toBe("untouched draft");
    app.resize(60, 12);
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.get("session-history").visible).toBe(false);
  } finally {
    await app.close();
  }
});

test("Shared snapshot previews show saved run state, context, usage, and Fast in the same session UI", async () => {
  // Usage windows expired now still had actual observations in the saved screen.
  const capturedAt = 1700000000000;
  const snapshot: SessionRecord = {
    id: "closed-tab",
    name: "Archived task",
    worktreeId: "demo:main",
    lifecycle: "closed",
    updatedAt: capturedAt,
    state: {
      conversationId: "first",
      status: "failure",
      error: "Saved failure",
      output: "",
      sections: [
        {
          id: "a",
          kind: "assistant",
          title: "Agent",
          text: "Saved snapshot answer",
          status: "complete",
        },
      ],
      telemetry: {
        provider: "fixture",
        model: "archived-model",
        effort: "high",
        fast: true,
        context: { usedTokens: 72000, maxTokens: 200000 },
        weekly: null,
        usage: {
          provider: "fixture",
          status: "ready",
          windows: [
            { id: "quota", usedPercent: 43, periodMs: 604800000, resetsAt: capturedAt + 3600000 },
          ],
          updatedAt: capturedAt,
          errorCode: null,
        },
      },
    },
    subagents: [],
  };
  const app = await mount({
    preview: async (worktreeId, id) => ok({ id, worktreeId, text: "", truncated: false, snapshot }),
  });
  try {
    app.resize(220, 36);
    await app.render();

    // Pass the same saved record to AgentPanel instead of reconstructing fields by inference.
    await app.open();
    const frame = app.captureCharFrame();

    // Never expire historical values using today's clock or apply them to live settings.
    expect(frame).toContain("Saved snapshot answer");
    expect(frame).toContain("Failed");
    expect(frame).toContain("Saved failure");
    expect(frame).toContain("archived-model");
    expect(frame).toContain("fast on");
    expect(frame).toContain("64%");
    expect(frame).toContain("43% used");
    expect(frame).not.toContain("Preview ·");
    expect(frame).not.toContain("saved 2023-11-14");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.runs).toEqual([]);
    expect(app.resumed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Search matches normalized words while keeping hjkl and r literal", async () => {
  // Titles include separated Korean words and ordinary navigation letters.
  const app = await mount({
    list: async () => [
      saved("a", "Layout review"),
      saved("b", "키보드 검색"),
      saved("c", "hjkl refresh"),
    ],
  });
  try {
    await app.open();
    await app.mockInput.typeText("ＬＡＹ review");
    await app.render();
    expect(app.captureCharFrame()).toContain("Layout review");
    expect(app.captureCharFrame()).not.toContain("키보드 검색");
    const search = app.get("history-search") as InputRenderable;
    search.value = "보드 검색";
    await app.render();
    expect(app.captureCharFrame()).toContain("키보드 검색");
    search.value = "키검";
    await app.render();
    expect(app.captureCharFrame()).toContain("No matching sessions");
    search.value = "lyt rvw";
    await app.render();
    expect(app.captureCharFrame()).toContain("No matching sessions");

    // Ordinary letters stay in search instead of executing list navigation or refresh.
    search.value = "";
    await app.mockInput.typeText("hjkl r");
    await app.render();

    // Search changes must never open a session or send a model request.
    expect(search.value).toBe("hjkl r");
    expect(app.captureCharFrame()).toContain("hjkl refresh");
    expect(app.resumed).toEqual([]);
    expect(app.runs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("List clicks and Ctrl+N/P change only previews; Enter opens the selected session", async () => {
  const app = await mount();
  try {
    await app.open();
    await app.click("history:second");
    expect(app.resumed).toEqual([]);
    expect(app.selection.sessionId).toBe("a1");
    app.mockInput.pressKey("p", { ctrl: true });
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    expect(app.previews).toEqual(["first", "second"]);
    app.mockInput.pressEnter();
    await app.waitFor(() => app.selection.sessionId === "a2");
    await app.render();
    expect(app.resumed).toEqual(["demo:main/second"]);
    expect(app.get("session-history").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-transcript");
    expect(app.view.promptDrafts.a1).toBe("untouched draft");
    expect(app.runs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Esc restores prompt caret, draft, transcript scroll, and original focus", async () => {
  const app = await mount();
  try {
    const prompt = app.get("session-prompt") as InputRenderable,
      transcript = app.get("session-transcript") as ScrollBoxRenderable;
    prompt.focus();
    prompt.cursorOffset = 5;
    transcript.scrollTo(21);
    await app.render();
    const top = transcript.scrollTop;
    // The global shortcut preserves the prompt as the owner without a visible trigger button.
    await app.open();
    await app.mockInput.typeText("review");
    await app.render();
    app.mockInput.pressEscape();
    await app.render();
    expect(app.get("session-history").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(prompt.cursorOffset).toBe(5);
    expect(app.view.promptDrafts.a1).toBe("untouched draft");
    expect(transcript.scrollTop).toBe(top);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.resumed).toEqual([]);
    expect(app.runs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Repeated kitty Enter/Esc events after popup closure never become background commands", async () => {
  // Native kitty repeats sometimes carry repeated=true rather than eventType=repeat.
  const app = await mount();
  const raw = (text: string) => {
    const key = parseKeypress(text, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid kitty fixture");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    app.get("session-prompt").focus();
    await app.open();
    raw("\u001b[27;1u");
    raw("\u001b[27;1:2u");
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.view.promptDrafts.a1).toBe("untouched draft");
    raw("\u001b[27;1:3u");
    await app.open();
    raw("\u001b[13;1u");
    await app.render();
    const owner = app.renderer.currentFocusedRenderable;
    raw("\u001b[13;1:2u");
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(owner);
    expect(app.resumed).toEqual(["demo:main/first"]);
    expect(app.runs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Missing original inputs restore focus to visible navigation instead of hidden search", async () => {
  const app = await mount();
  try {
    app.get("session-prompt").focus();
    await app.open();
    app.selection.replaceSnapshot(
      app.selection.snapshot.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((tree) => ({ ...tree, sessions: [] })),
      })),
    );
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("agent-view");
    expect(app.get("session-history").visible).toBe(false);
    expect(app.resumed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Popups trap Tab focus, global commands, and background clicks while preserving sidebar folding", async () => {
  const app = await mount();
  try {
    expect(app.get("workspace-picker").visible).toBe(false);
    await app.open();
    const dialog = app.get("history-dialog");
    for (let i = 0; i < 9; i++) {
      app.mockInput.pressTab();
      await app.render();
      expect(["history-search", "history-list", "history-preview"]).toContain(
        app.renderer.currentFocusedRenderable!.id,
      );
    }
    app.leader("e");
    app.leader("b");
    pressLeader(app, "a");
    await app.render();
    expect(app.get("agent-view").visible).toBe(true);
    expect(app.get("workspace-sidebar").visible).toBe(false);
    await app.mockMouse.click(0, 0);
    await app.render();
    expect(app.get("session-history").visible).toBe(true);
    expect(dialog.x).toBeGreaterThan(0);
    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.runs).toEqual([]);
    app.mockInput.pressEscape();
    await app.render();
    expect(app.get("workspace-sidebar").visible).toBe(false);
  } finally {
    await app.close();
  }
});

test.each([120, 60])(
  "Pending History listings show loading text in the center of the candidate body at %s columns",
  async (width) => {
    // A real pending list has no candidates yet, but search and the preview region keep their layout.
    const pending = Promise.withResolvers<readonly HistoryItem[]>();
    const app = await mount({ list: () => pending.promise });
    try {
      app.resize(width, 24);
      await app.render();

      await app.open();

      // Loading guidance belongs to the centered empty list, never a header or preview overlay.
      const body = app.get("history-results");
      const title = app.get("history-loading-message") as TextRenderable;
      const feedback = app.get("history-loading-feedback");
      expect(title.plainText).toBe("Loading saved sessions…");
      expect(feedback.x).toBe(body.x + Math.floor((body.width - feedback.width) / 2));
      expect(feedback.y).toBe(body.y + Math.floor((body.height - 1) / 2));
      expect(app.get("history-loading").y).toBe(title.y);
      expect(app.get("history-list-status").visible).toBe(false);
      expect((app.get("history-message") as TextRenderable).visible).toBe(false);
      expect(app.get("history-loading").visible).toBe(true);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
      const field = app.get("history-search-field");
      expect(field.y).toBe(app.get("history-dialog").y);

      // Discovery uses the latest query and does not delay results for the spinner's minimum duration.
      await app.mockInput.typeText("keyboard");
      const search = app.get("history-search") as InputRenderable;
      search.cursorOffset = 3;
      pending.resolve([saved("first", "Layout review"), saved("second", "Keyboard review")]);
      await app.visible("Keyboard review");
      expect(app.captureCharFrame()).not.toContain("Loading saved sessions…");
      expect(app.captureCharFrame()).not.toContain("Layout review");
      expect(app.get("history-results-empty").visible).toBe(false);
      expect(search.value).toBe("keyboard");
      expect(search.cursorOffset).toBe(3);
      expect(app.renderer.currentFocusedRenderable).toBe(search);
    } finally {
      pending.resolve([]);
      await app.close();
    }
  },
);

test("Fast results appear immediately while shared spinners persist 500 ms and cancel when hidden", async () => {
  const app = await mount();
  try {
    await app.open();
    expect(app.captureCharFrame()).toContain("Saved layout review");
    expect(app.get("history-loading").visible).toBe(true);
    // Lookup feedback belongs to the session list, not the popup frame or preview screen.
    const loading = app.get("history-loading");
    expect(loading.parent?.id).toBe("history-loading-feedback");
    expect(loading.x).toBeGreaterThan(app.get("history-list").x);
    expect(loading.x).toBeLessThan(app.get("history-preview-pane").x);
    expect(loading.y).toBeGreaterThan(app.get("history-dialog").y);
    app.clock.advance(499);
    await app.render();
    expect(app.get("history-loading").visible).toBe(true);
    app.clock.advance(1);
    await app.render();
    expect(app.get("history-loading").visible).toBe(false);
    app.mockInput.pressKey("r", { ctrl: true });
    await app.render();
    expect(app.get("history-loading").visible).toBe(true);
    app.mockInput.pressEscape();
    await app.render();
    expect(app.get("history-loading").visible).toBe(false);
    expect(!!app.renderer.root.findDescendantById("history-preview-loading")).toBe(false);
  } finally {
    await app.close();
  }
});

test("History refresh keeps existing candidates and preview visible with only inline activity", async () => {
  // Only the second list request is delayed; accepted content remains available during refresh.
  const pending = Promise.withResolvers<readonly HistoryItem[]>();
  let calls = 0;
  const app = await mount({
    list: () =>
      ++calls === 1 ? Promise.resolve([saved("first", "Existing session")]) : pending.promise,
  });
  try {
    await app.open();
    expect(app.captureCharFrame()).toContain("Saved answer first");

    app.mockInput.pressKey("r", { ctrl: true });
    await app.render();

    expect(app.captureCharFrame()).toContain("Existing session");
    expect(app.captureCharFrame()).toContain("Saved answer first");
    expect(app.captureCharFrame()).not.toContain("Loading saved sessions…");
    expect(app.get("history-loading").visible).toBe(true);
    expect((app.get("history-loading-message") as TextRenderable).visible).toBe(false);
    expect(app.get("history-list-status").visible).toBe(false);
    pending.resolve([saved("first", "Updated session")]);
    await app.visible("Updated session");
  } finally {
    pending.resolve([]);
    await app.close();
  }
});

test("New listings ignore old responses and update only current spinners and results", async () => {
  // The first read remains pending while an explicit refresh takes ownership of the popup.
  const first = Promise.withResolvers<readonly HistoryItem[]>(),
    second = Promise.withResolvers<readonly HistoryItem[]>();
  let calls = 0;
  const signals: (AbortSignal | undefined)[] = [];
  const app = await mount({
    list: (_tree, signal) => {
      signals.push(signal);
      return ++calls === 1 ? first.promise : second.promise;
    },
  });
  try {
    await app.open();
    app.mockInput.pressKey("r", { ctrl: true });
    await app.render();
    expect(signals[0]?.aborted).toBe(true);
    first.resolve([saved("old", "STALE METADATA")]);
    await app.render();
    expect(app.captureCharFrame()).not.toContain("STALE METADATA");
    expect(app.get("history-loading").visible).toBe(true);
    second.resolve([saved("new", "CURRENT METADATA")]);
    await app.visible("CURRENT METADATA");
    app.clock.advance(500);
    await app.render();
    expect(app.get("history-loading").visible).toBe(false);
    expect(app.resumed).toEqual([]);
  } finally {
    first.resolve([]);
    second.resolve([]);
    await app.close();
  }
});

test("Late responses cache only their own sessions and are reused immediately on reselection", async () => {
  // A slow first response must not overwrite the second session but remains useful on revisit.
  const pending = Promise.withResolvers<Result<HistoryPreview, ExpectedError>>();
  const app = await mount({
    preview: async (tree, id) =>
      id === "first"
        ? pending.promise
        : ok({ worktreeId: tree, id, text: "CURRENT SECOND PREVIEW", truncated: false }),
  });
  try {
    await app.open();
    expect(app.previews).toEqual(["first"]);
    app.mockInput.pressArrow("down");
    await app.render();
    expect(app.previews).toEqual(["first", "second"]);
    pending.resolve(
      ok({ id: "first", worktreeId: "demo:main", text: "CACHED FIRST PREVIEW", truncated: false }),
    );
    await app.render();

    // Show only the current selection regardless of response order; revisiting A adds no request.
    expect(app.captureCharFrame()).toContain("CURRENT SECOND PREVIEW");
    expect(app.captureCharFrame()).not.toContain("CACHED FIRST PREVIEW");
    app.mockInput.pressKey("p", { ctrl: true });
    await app.render();
    expect(app.captureCharFrame()).toContain("CACHED FIRST PREVIEW");
    expect(app.previews).toEqual(["first", "second"]);
    expect(app.resumed).toEqual([]);
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    pending.resolve(ok({ id: "first", worktreeId: "demo:main", text: "late", truncated: false }));
    await app.close();
  }
});

test("Uncached candidates show selected titles and empty bodies without loading or stale content", async () => {
  // Showing previous content on cache misses could misattribute another session's answer.
  const pending = Promise.withResolvers<Result<HistoryPreview, ExpectedError>>();
  const app = await mount({
    preview: async (tree, id) =>
      id === "second"
        ? pending.promise
        : ok({ worktreeId: tree, id, text: "FIRST SESSION ANSWER", truncated: false }),
  });
  try {
    await app.open();
    expect(app.captureCharFrame()).toContain("FIRST SESSION ANSWER");
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();

    // Pending I/O must not display fixed timers or another session's body.
    const frame = app.captureCharFrame();
    expect(frame).toContain("Saved keyboard navigation");
    expect(frame).not.toContain("Preview ·");
    expect(frame).not.toContain("FIRST SESSION ANSWER");
    expect(frame).not.toContain("Loading preview");
    expect(!!app.renderer.root.findDescendantById("history-preview-loading")).toBe(false);
    expect(app.previews).toEqual(["first", "second"]);
    expect(app.get("history-loading").y).toBe(app.get("history:second").y);
    expect((app.get("history-loading-message") as TextRenderable).visible).toBe(false);
    expect(app.get("history-list-status").visible).toBe(false);
    pending.resolve(
      ok({
        worktreeId: "demo:main",
        id: "second",
        text: "SECOND SESSION ANSWER",
        truncated: false,
      }),
    );
    await app.visible("SECOND SESSION ANSWER");
  } finally {
    pending.resolve(ok({ worktreeId: "demo:main", id: "second", text: "late", truncated: false }));
    await app.close();
  }
});

test("Pending history previews hand focus from the empty pane to ready content without changing candidates", async () => {
  // A selected candidate can have no cached preview while its request is still pending.
  const pending = Promise.withResolvers<Result<HistoryPreview, ExpectedError>>();
  const app = await mount({ preview: () => pending.promise });
  try {
    await app.open();
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();

    // Preview scrolling must not move the candidate cursor or reveal a fake composer.
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-preview-pane");
    app.mockInput.pressKey("d", { ctrl: true });
    await app.render();
    expect(app.previews).toEqual(["first"]);
    expect(app.get("history-preview-agent-view").visible).toBe(false);
    pending.resolve(
      ok({
        worktreeId: "demo:main",
        id: "first",
        text: "Ready saved conversation",
        truncated: false,
      }),
    );
    await app.visible("Ready saved conversation");

    // The ready transcript inherits preview focus without opening or changing the live session.
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-preview");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.resumed).toEqual([]);
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
  } finally {
    pending.resolve(ok({ worktreeId: "demo:main", id: "first", text: "late", truncated: false }));
    await app.close();
  }
});

test("Saved empty sessions reuse the actual empty conversation screen and remain explicitly openable", async () => {
  // An empty saved conversation is still a selected session, not an unavailable preview.
  const app = await mount({
    preview: async (worktreeId, id) =>
      ok({ worktreeId, id, sections: [], text: "", truncated: false }),
  });
  try {
    await app.open();

    // Normal empty-session branding, composer and telemetry remain visible without preview-only prose.
    expect(app.get("history-preview-agent-view").visible).toBe(true);
    expect(app.captureCharFrame()).toContain("Ask to do anything");
    expect(app.captureCharFrame()).not.toContain("No saved sections in this branch.");
    expect(app.captureCharFrame()).not.toContain("Read-only preview");
    app.mockInput.pressEnter();
    await app.render();
    expect(app.resumed).toEqual(["demo:main/first"]);
  } finally {
    await app.close();
  }
});

test("Refresh and close clear preview caches and reject responses from older generations", async () => {
  // Even identical saved IDs require fresh request data after refresh.
  const old = Promise.withResolvers<Result<HistoryPreview, ExpectedError>>();
  const signals: (AbortSignal | undefined)[] = [];
  let calls = 0;
  const app = await mount({
    preview: async (tree, id, signal) => {
      signals.push(signal);
      calls++;
      return calls === 1
        ? old.promise
        : ok({ worktreeId: tree, id, text: `NEW PREVIEW ${calls}`, truncated: false });
    },
  });
  try {
    await app.open();
    app.mockInput.pressKey("r", { ctrl: true });
    await app.render();
    expect(signals[0]?.aborted).toBe(true);
    expect(app.captureCharFrame()).toContain("NEW PREVIEW 2");
    old.resolve(
      ok({ worktreeId: "demo:main", id: "first", text: "OBSOLETE PREVIEW", truncated: false }),
    );
    await app.render();
    expect(app.captureCharFrame()).not.toContain("OBSOLETE PREVIEW");

    // Never carry closed-modal body caches into the next opening.
    app.mockInput.pressEscape();
    await app.render();
    await app.open();
    expect(app.captureCharFrame()).toContain("NEW PREVIEW 3");
    expect(calls).toBe(3);
  } finally {
    old.resolve(ok({ worktreeId: "demo:main", id: "first", text: "late", truncated: false }));
    await app.close();
  }
});

test("Narrow layouts switch between lists and previews while preserving search and caret on resize", async () => {
  const app = await mount();
  try {
    await app.open();
    await app.mockInput.typeText("keyboard");
    app.clock.advance(150);
    await app.render();
    app.resize(60, 12);
    await app.render();
    expect(app.get("history-list").visible).toBe(true);
    expect(app.get("history-preview-pane").visible).toBe(false);
    expect(app.captureCharFrame().split("\n")[11]).not.toContain("<Esc> Close");
    expect(app.captureCharFrame().split("\n")[11]).toContain("<C-o> Preview");
    expect(app.view.workViewPreferences.active["demo:main"] ?? "agent").toBe("agent");
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();
    expect(app.get("history-list").visible).toBe(false);
    expect(app.get("history-preview-pane").visible).toBe(true);
    // Short panes retain the real session controls instead of a preview-specific compact status row.
    expect(app.get("history-preview-session-status").height).toBe(3);
    app.resize(60, 18);
    await app.render();
    expect(app.captureCharFrame()).toContain("Saved answer second");
    // Moving up from the latest answer reveals its request even in compact viewports.
    const preview = app.get("history-preview") as ScrollBoxRenderable,
      initialScroll = preview.scrollTop;
    await app.mockInput.pressKeys(["\x1b[5~"]);
    await app.render();
    expect(preview.scrollTop).toBeLessThan(initialScroll);
    for (
      let page = 0;
      page < 10 && !app.captureCharFrame().includes("Saved question second");
      page++
    ) {
      await app.mockInput.pressKeys(["\x1b[5~"]);
      await app.render();
    }
    expect(app.captureCharFrame()).toContain("Saved question second");
    const dialog = app.get("history-dialog");
    expect(dialog.x + dialog.width).toBeLessThanOrEqual(60);
    expect(dialog.y + dialog.height).toBeLessThanOrEqual(20);
    app.resize(140, 30);
    await app.render();
    expect(app.get("history-list").visible).toBe(true);
    expect(app.get("history-preview-pane").visible).toBe(true);
    expect((app.get("history-search") as InputRenderable).value).toBe("keyboard");
    expect(app.resumed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Empty lists, no matches, and lookup errors stay distinct with custom Refresh and reconnection", async () => {
  let calls = 0;
  const app = await mount({
    keymap: expectOk(
      parseKeymap({
        bindings: { "history.refresh": [{ keys: "ctrl+g", scope: "history-search" }] },
      }),
    ),
    list: async () => {
      calls++;
      if (calls === 1) throw new HistoryError("HISTORY_UNAVAILABLE", "Lookup failed");
      return calls === 2 ? [] : [saved("restored", "Restored history")];
    },
  });
  try {
    app.resize(160, 24);
    await app.render();
    await app.open();
    await app.visible("History error:");
    expect(app.captureCharFrame()).toContain("<C-g> Refresh");
    app.mockInput.pressKey("r", { ctrl: true });
    await app.render();
    expect(calls).toBe(1);
    app.mockInput.pressKey("g", { ctrl: true });
    await app.visible("No saved sessions");
    app.view.refreshHistory();
    await app.visible("Restored history");
    await app.mockInput.typeText("nothing matches");
    await app.visible("No matching sessions");
    app.mockInput.pressEscape();
    app.view.refreshHistory();
    await app.render();
    expect(calls).toBe(3);
    expect(app.resumed).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Busy and resume errors stay in the popup while existing sessions select without duplication", async () => {
  const app = await mount({
    list: async () => [
      { ...saved("busy", "Busy history"), unavailableReason: "Still closing" },
      saved("broken", "Broken history"),
      { ...saved("open", "Open history"), openSessionId: "a1" },
    ],
    resume: async (_tree, id) => {
      if (id === "broken") throw new HistoryError("HISTORY_UNAVAILABLE", "Cannot resume");
      return "a1";
    },
  });
  try {
    // Open failures must reveal their feedback even after the normal status row has disappeared.
    await app.open();
    app.clock.advance(500);
    await app.render();
    app.mockInput.pressEnter();
    await app.render();
    expect(app.captureCharFrame()).toContain("Still closing");
    expect(app.resumed).toEqual([]);
    app.mockInput.pressArrow("down");
    app.mockInput.pressEnter();
    await app.visible("Resume error:");
    expect(app.get("session-history").visible).toBe(true);
    expect(app.selection.sessionId).toBe("a1");
    app.mockInput.pressArrow("down");
    app.mockInput.pressEnter();
    await app.waitFor(() => !app.get("session-history").visible);
    expect(app.resumed).toEqual(["demo:main/broken", "demo:main/open"]);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.runs).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Preview failures appear explicitly while search and Open remain available", async () => {
  const app = await mount({
    preview: async () => ({
      ok: false,
      error: new HistoryError("HISTORY_UNAVAILABLE", "Preview unavailable"),
    }),
  });
  try {
    await app.open();
    app.clock.advance(150);
    await app.visible("Preview unavailable");
    expect(app.selection.sessionId).toBe("a1");
    app.mockInput.pressEnter();
    await app.waitFor(() => app.selection.sessionId === "a2");
    expect(app.resumed).toEqual(["demo:main/first"]);
  } finally {
    await app.close();
  }
});

test("Closing popups or changing worktrees prevents stale lists and previews from updating screens", async () => {
  const pending = Promise.withResolvers<readonly HistoryItem[]>();
  let signal: AbortSignal | undefined;
  const app = await mount({
    list: (_tree, current) => {
      signal = current;
      return pending.promise;
    },
  });
  try {
    await app.open();
    app.selection.selectWorktree("demo:feature");
    await app.render();
    expect(signal?.aborted).toBe(true);
    expect(app.get("session-history").visible).toBe(false);
    pending.resolve([saved("stale", "STALE RESPONSE")]);
    await app.render();
    expect(app.captureCharFrame()).not.toContain("STALE RESPONSE");
    expect(app.resumed).toEqual([]);
  } finally {
    pending.resolve([]);
    await app.close();
  }
});

test("Closing during Open never claims rollback or lets late responses change selection", async () => {
  const pending = Promise.withResolvers<string>();
  const app = await mount({ resume: () => pending.promise });
  try {
    // A pending Open still needs feedback after loading and ordinary counts have disappeared.
    await app.open();
    app.clock.advance(500);
    await app.render();
    app.mockInput.pressEnter();
    await app.render();
    expect(app.captureCharFrame()).toContain("Opening saved session…");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.captureCharFrame()).toContain("Open is still settling.");
    app.mockInput.pressKey(" ", { ctrl: true });
    app.mockInput.pressKey("!");
    app.mockInput.pressEnter();
    await app.render();
    expect(app.captureCharFrame()).toContain("does not cancel");
    app.mockInput.pressEscape();
    app.mockInput.pressEscape();
    await app.render();
    pending.resolve("a2");
    await app.render();
    expect(app.selection.sessionId).toBe("a1");
    expect(app.resumed).toEqual(["demo:main/first"]);
  } finally {
    pending.resolve("a2");
    await app.close();
  }
});

test("Late responses after disposal never write destroyed native buffers and timers are cleaned", async () => {
  const pending = Promise.withResolvers<readonly HistoryItem[]>();
  const app = await mount({ list: () => pending.promise });
  const cleared = spyOn(app.clock, "clearInterval");
  try {
    await app.open();
    app.view.dispose();
    pending.resolve([saved("late", "Late history")]);
    app.clock.advance(1000);
    await app.render();
    expect(cleared).toHaveBeenCalled();
    expect(app.captureCharFrame()).not.toContain("Late history");
    expect(app.resumed).toEqual([]);
  } finally {
    cleared.mockRestore();
    await app.close();
  }
});
