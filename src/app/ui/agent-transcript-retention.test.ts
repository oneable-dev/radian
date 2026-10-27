import { pressLeader } from "../../testing/keys.ts";
import { expect, spyOn, test } from "bun:test";
import {
  EditBufferRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  type Renderable,
} from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { TranscriptMarkdown } from "../../agents/ui/transcript-markdown.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { icons } from "../../icons.ts";
import { ok } from "../../result.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

const descendants = (node: Renderable): Renderable[] =>
  node.getChildren().flatMap((child) => [child, ...descendants(child)]);
const prose = (id: string, text: string, streaming = false): TranscriptSection => ({
  id,
  text,
  kind: "assistant",
  title: "Agent",
  status: streaming ? "streaming" : "complete",
});

async function mount() {
  const app = await createTestRenderer({
    width: 120,
    height: 30,
    kittyKeyboard: true,
    clock: new ManualClock(),
  });
  let open = ["a", "b", "c", "d"];
  const states: Record<string, ExecutionState> = Object.fromEntries(
    open.map((id) => [
      id,
      {
        conversationId: `conversation-${id}`,
        status: "working",
        output: "",
        error: null,
        // Section identities can repeat across conversations and must not share native buffers.
        sections: [
          prose("history", `${id} history`),
          prose("stream", `${id} streaming`, true),
          prose("tail", `${id} tail`),
        ],
      },
    ]),
  );
  const snapshot = () => [
    {
      id: "probe",
      name: "probe",
      worktrees: [
        {
          id: "probe:main",
          name: "main",
          path: process.cwd(),
          branch: "main",
          sessions: open.map((id) => ({ id, name: id, status: states[id]!.status, subagents: [] })),
        },
      ],
    },
  ];
  const selection = new WorkspaceSelection(snapshot());
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    onPrompt: () => ok(undefined),
    getSessionDetails: (id) => states[id] ?? null,
    initialDrafts: { a: "keep draft a", b: "keep draft b" },
  });
  const scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript viewport");
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  await render();
  return {
    ...app,
    view,
    selection,
    states,
    scroll,
    render,
    markdown(text: string) {
      const node = descendants(scroll).find(
        (node) => node instanceof MarkdownRenderable && node.content === text,
      );
      if (!(node instanceof MarkdownRenderable)) throw new Error(`Missing Markdown: ${text}`);
      return node;
    },
    async select(id: string) {
      selection.selectSession("probe:main", id);
      await render();
    },
    async update(id: string, patch: Partial<ExecutionState>) {
      states[id] = { ...states[id]!, ...patch };
      selection.replaceSnapshot(snapshot());
      await render();
    },
    async closeSession(id: string) {
      open = open.filter((current) => current !== id);
      selection.replaceSnapshot(snapshot());
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Background output/status changes update tabs without refreshing current conversations", async () => {
  // Deliver B's output and terminal state while reading A.
  const app = await mount(),
    updates = spyOn(TranscriptMarkdown.prototype, "update");
  try {
    const markdown = app.markdown("a history");
    updates.mockClear();

    // Background changes arrive through actual global snapshot notifications.
    await app.update("b", {
      status: "failure",
      sections: [prose("history", "b background output")],
    });

    // Preserve current conversation while still showing B's failure status.
    expect(updates).not.toHaveBeenCalled();
    expect(app.markdown("a history") === markdown).toBe(true);
    expect(app.captureCharFrame()).toContain(icons.failure);
    expect(app.captureCharFrame()).not.toContain("b background output");
  } finally {
    updates.mockRestore();
    await app.close();
  }
});

test("Streaming one response section never updates unchanged historical conversation", async () => {
  // Grow only the middle of three Markdown sections.
  const app = await mount(),
    updates = spyOn(TranscriptMarkdown.prototype, "update");
  try {
    const history = app.markdown("a history"),
      stream = app.markdown("a streaming");
    updates.mockClear();

    // IPC-style cloned sections with equal values do not count as changes.
    await app.update("a", {
      sections: [
        prose("history", "a history"),
        prose("stream", "a streaming plus", true),
        prose("tail", "a tail"),
      ],
    });

    // Update existing buffers without rerendering historical Markdown.
    expect(updates.mock.calls.map(([text]) => text)).toEqual(["a streaming plus"]);
    expect(app.markdown("a history") === history).toBe(true);
    expect(app.markdown("a streaming plus") === stream).toBe(true);
  } finally {
    updates.mockRestore();
    await app.close();
  }
});

test("Session round-trips reuse Markdown/source buffers while preserving drafts and selections", async () => {
  // Identical section IDs across sessions must not share A's selection.
  const app = await mount();
  try {
    const markdown = app.markdown("a history");
    pressLeader(app, "[");
    app.mockInput.pressKey("HOME");
    app.mockInput.pressEnter();
    app.mockInput.pressKey("l");
    app.mockInput.pressKey("v");
    await app.render();
    const reader = app.renderer.currentFocusedRenderable;
    if (!(reader instanceof EditBufferRenderable)) throw new Error("Missing source reader");
    const selection = reader.getSelectedText(),
      cursor = reader.cursorOffset;

    // Detach old conversations without destroying objects or reading state.
    await app.select("b");
    expect(markdown.isDestroyed).toBe(false);
    expect(descendants(app.scroll).includes(markdown)).toBe(false);
    await app.select("a");

    // Return to the same reading position without reparsing or allocating source buffers.
    expect(app.markdown("a history") === markdown).toBe(true);
    expect(app.renderer.currentFocusedRenderable === reader).toBe(true);
    expect(reader.cursorOffset).toBe(cursor);
    expect(reader.getSelectedText()).toBe(selection);
    expect(app.view.promptDrafts).toMatchObject({ a: "keep draft a", b: "keep draft b" });
  } finally {
    await app.close();
  }
});

test("Returning to retained sessions applies changed output and deleted rows", async () => {
  // Deliver new A output while retaining its conversation UI offscreen.
  const app = await mount();
  try {
    const history = app.markdown("a history"),
      stream = app.markdown("a streaming"),
      removed = app.markdown("a tail");
    await app.select("b");
    await app.update("a", {
      sections: [
        prose("history", "a history"),
        prose("stream", "a finished"),
        prose("new", "a new response"),
      ],
    });

    // Compare the latest snapshot against retained rows when reselecting A.
    await app.select("a");

    // Reuse surviving rows and release only deleted native objects.
    expect(app.markdown("a history") === history).toBe(true);
    expect(app.markdown("a finished") === stream).toBe(true);
    expect(removed.isDestroyed).toBe(true);
    expect(app.captureCharFrame()).toContain("a new response");
  } finally {
    await app.close();
  }
});

test("Replacing a tab's conversation discards retained old content and selection", async () => {
  // Identical tab IDs must not reuse old native buffers for reset conversations.
  const app = await mount();
  try {
    const old = app.markdown("a history");
    await app.select("b");
    await app.update("a", {
      conversationId: "replacement-a",
      sections: [prose("history", "replacement history")],
    });

    // Returning to reset tabs displays the new conversation.
    await app.select("a");

    // Release old buffers without leaking bodies or selections into new conversations.
    expect(old.isDestroyed).toBe(true);
    expect(app.markdown("replacement history") === old).toBe(false);
    expect(app.captureCharFrame()).not.toContain("a history");
    expect(app.view.workViewPreferences.agentViews?.a?.mode ?? "sections").toBe("sections");
  } finally {
    await app.close();
  }
});

test("Closing retained sessions immediately releases offscreen native conversation objects", async () => {
  // Keep A offscreen for reuse until closure.
  const app = await mount();
  try {
    const markdown = app.markdown("a history");
    await app.select("b");

    // Conversations removed from open sessions must not remain cached.
    await app.closeSession("a");

    // Preserve current sessions while releasing closed native resources.
    expect(markdown.isDestroyed).toBe(true);
    expect(app.selection.sessionId).toBe("b");
    expect(app.captureCharFrame()).toContain("b history");
  } finally {
    await app.close();
  }
});

test("Retention limits evict least-recent conversations and screen disposal releases the rest", async () => {
  // Retain at most two recent native trees beyond the active conversation.
  const app = await mount();
  const first = app.markdown("a history");
  let second: MarkdownRenderable | undefined, third: MarkdownRenderable | undefined;
  try {
    await app.select("b");
    second = app.markdown("b history");
    await app.select("c");
    third = app.markdown("c history");

    // Entering a fourth session evicts oldest A.
    await app.select("d");

    // Recent conversations survive without unbounded accumulation.
    expect(first.isDestroyed).toBe(true);
    expect(second.isDestroyed).toBe(false);
    expect(third.isDestroyed).toBe(false);
  } finally {
    await app.close();
  }
  expect(second?.isDestroyed).toBe(true);
  expect(third?.isDestroyed).toBe(true);
});

test.each([
  ["following latest output", false],
  ["reading history", true],
] as const)(
  "Growing retained conversations preserve %s scroll intent on return",
  async (_label, paused) => {
    // Distinguish following latest output from reading historical content.
    const app = await mount();
    try {
      const history: TranscriptSection = {
        id: "history",
        kind: "user",
        title: "You",
        text: "Earlier line\n".repeat(80),
        status: "complete",
      };
      await app.update("a", { sections: [history] });
      if (paused) {
        pressLeader(app, "[");
        app.mockInput.pressKey("HOME");
        await app.render();
      }
      const position = app.scroll.scrollTop;
      await app.select("b");
      await app.update("a", { sections: [history, prose("new", "BACKGROUND_TAIL\n".repeat(30))] });

      // Apply offscreen changes on return without overwriting historical reading intent.
      await app.select("a");

      // Only following conversations move to the new bottom; paused readers keep positions.
      expect(app.view.workViewPreferences.agentViews?.a?.follow).toBe(!paused);
      if (paused) expect(app.scroll.scrollTop).toBe(position);
      else {
        expect(app.scroll.scrollTop).toBe(
          Math.max(0, app.scroll.scrollHeight - app.scroll.viewport.height),
        );
        expect(app.captureCharFrame()).toContain("BACKGROUND_TAIL");
      }
    } finally {
      await app.close();
    }
  },
);

test("Late retained-Markdown resize never changes current-session scroll", async () => {
  // Move A's native tree offscreen before highlighting or theme work completes.
  const app = await mount();
  try {
    const old = app.markdown("a history");
    await app.select("b");
    const scrollTo = spyOn(app.scroll, "scrollTo");
    try {
      // Deliver late resize events allowed by native lifecycle.
      old.emit("resize");

      // Offscreen owners must not alter B's following intent or position.
      expect(scrollTo).not.toHaveBeenCalled();
      expect(app.selection.sessionId).toBe("b");
      expect(app.view.promptDrafts.b).toBe("keep draft b");
    } finally {
      scrollTo.mockRestore();
    }
  } finally {
    await app.close();
  }
});

test("Combined section budgets evict old conversations even with few sessions", async () => {
  // Small conversations still exceed retention once native rows total over 600.
  const app = await mount();
  const sections = (id: string): TranscriptSection[] => [
    prose("history", `${id} history`),
    ...Array.from({ length: 300 }, (_, index): TranscriptSection => ({
      id: `tool-${index}`,
      kind: "tool",
      title: "read",
      text: "result",
      status: "complete",
    })),
  ];
  try {
    await app.update("a", { sections: sections("a") });
    const first = app.markdown("a history");
    await app.select("b");
    expect(first.isDestroyed).toBe(false);
    await app.update("b", { sections: sections("b") });
    const second = app.markdown("b history");

    // Entering C would exceed the section budget if both A and B were retained.
    await app.select("c");

    // Retain recent B and evict A so native limits do not depend solely on session count.
    expect(first.isDestroyed).toBe(true);
    expect(second.isDestroyed).toBe(false);
  } finally {
    await app.close();
  }
});

test("Oversized source releases native buffers on departure even with few rows", async () => {
  // A single large tool result must not bypass row-count retention limits.
  const app = await mount();
  try {
    await app.update("a", {
      sections: [
        prose("history", "a history"),
        {
          id: "large-tool",
          kind: "tool",
          title: "read",
          text: "result line\n".repeat(200_000),
          status: "complete",
        },
      ],
    });
    const markdown = app.markdown("a history");

    // Conversations exceeding 2 MiB of source do not enter reuse caches.
    await app.select("b");

    // Release the entire native tree, including smaller Markdown sections.
    expect(markdown.isDestroyed).toBe(true);
    expect(app.captureCharFrame()).toContain("b history");
  } finally {
    await app.close();
  }
});
