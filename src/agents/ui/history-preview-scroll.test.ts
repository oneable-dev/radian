import { expect, test } from "bun:test";
import { CodeRenderable, ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { HistoryPreviewCache } from "../history-preview-cache.ts";
import type { HistoryPreview } from "../history-preview.ts";
import type { TranscriptSection } from "../transcript.ts";
import { ok } from "../../result.ts";
import { submitPromptCommand } from "../../testing/keys.ts";

const descendants = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(descendants),
];

async function mount(preloaded: boolean, snapshot: boolean) {
  const app = await createTestRenderer({
    width: 120,
    height: 28,
    kittyKeyboard: true,
    clock: new ManualClock(),
  });
  const rows = ["first", "second"].map((id) => ({
    id,
    title: id,
    worktreeId: "demo:main",
    modified: "2026-10-14T12:34:00Z",
    messageCount: 10,
    openSessionId: null,
    unavailableReason: null,
  }));
  const load = async (tree: string, id: string) => {
    const sections: TranscriptSection[] = Array.from({ length: 10 }, (_, index) => ({
      id: `${id}-${index}`,
      kind: index === 0 ? "user" : "assistant",
      title: index === 0 ? "You" : "Agent",
      status: "complete",
      text:
        Array.from({ length: 10 }, (_, line) => `${id} section ${index} line ${line}`).join("\n") +
        `\n${id} END ${index}`,
    }));
    const value: HistoryPreview = {
      id,
      worktreeId: tree,
      text: "",
      sections,
      truncated: false,
      ...(snapshot
        ? {
            snapshot: {
              id,
              name: id,
              worktreeId: tree,
              lifecycle: "closed",
              updatedAt: 1000,
              state: { conversationId: id, status: "complete", error: null, output: "", sections },
              subagents: [],
            },
          }
        : {}),
    };

    return ok(value);
  };
  const previews = new HistoryPreviewCache(
    load,
    () => {},
    (error) => {
      throw error;
    },
  );
  if (preloaded) {
    previews.preload(
      "demo:main",
      rows.map((item) => ({ id: item.id, revision: "1" })),
    );
    for (let pass = 0; pass < 40; pass++) {
      await Promise.resolve();
    }

    expect(previews.read("demo:main", "first")?.kind).toBe("ready");
    expect(previews.read("demo:main", "second")?.kind).toBe("ready");
  }

  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), {
    onNewSession() {},
    onCloseSession() {},
    onPrompt: () => ok(undefined),
    getSessionDetails: () => ({
      conversationId: "live",
      status: "complete",
      error: null,
      output: "",
    }),
    onListHistory: async () => ok(rows),
    onPreviewHistory: load,
    ...(preloaded
      ? {
          preloaded: {
            cachedHistory: () => ok(rows),
            cachedAccounts: () => undefined,
            cachedModels: () => undefined,
            previews,
          },
        }
      : {}),
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
    await Promise.all(
      descendants(app.renderer.root)
        .filter((node): node is CodeRenderable => node instanceof CodeRenderable)
        .map((node) => node.highlightingDone),
    );
    await app.renderOnce();
    await app.renderOnce();
  };

  await render();

  const node = app.renderer.root.findDescendantById("history-preview");
  if (!(node instanceof ScrollBoxRenderable)) {
    throw new Error("Missing history preview");
  }

  return {
    ...app,
    preview: node,
    render,
    async open() {
      submitPromptCommand(app, "/history");
      await render();
    },
    async move(direction: "next" | "previous") {
      app.mockInput.pressKey(direction === "next" ? "n" : "p", { ctrl: true });
      await render();
    },
    async close() {
      view.dispose();
      previews.clear();
      await app.dispose();
    },
  };
}

for (const preloaded of [false, true]) {
  for (const snapshot of [false, true]) {
    test(`History revisits retain the latest position with preloaded=${preloaded} and snapshot=${snapshot}`, async () => {
      // Every conversation exceeds the viewport, including when all bodies are ready before opening.
      const app = await mount(preloaded, snapshot);
      const expectLatest = (id: string) => {
        const maximum = Math.max(0, app.preview.scrollHeight - app.preview.viewport.height);
        expect(maximum).toBeGreaterThan(0);
        expect(app.preview.scrollTop).toBe(maximum);
        expect(app.captureCharFrame()).toContain(`${id} END 9`);
      };
      try {
        await app.open();
        expectLatest("first");
        await app.move("next");
        expectLatest("second");

        // Switching away must not save a synthetic zero offset over the previous reading position.
        await app.move("previous");
        expectLatest("first");
        app.mockInput.pressEscape();
        await app.render();
        await app.open();
        expectLatest("first");
      } finally {
        await app.close();
      }
    });
  }
}

test.each([false, true])(
  "History preserves a manually scrolled position across revisits with preloaded=%s",
  async (preloaded) => {
    // Returning to a conversation should restore intentional reading, not force either endpoint.
    const app = await mount(preloaded, true);
    try {
      await app.open();
      app.preview.scrollTo(20);
      await app.render();

      const position = app.preview.scrollTop;
      expect(position).toBeGreaterThan(0);
      expect(position).toBeLessThan(app.preview.scrollHeight - app.preview.viewport.height);

      await app.move("next");
      await app.move("previous");

      expect(app.preview.scrollTop).toBe(position);
    } finally {
      await app.close();
    }
  },
);
