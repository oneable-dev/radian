import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable, type TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { ok } from "../../result.ts";

async function mount(withRequest = false) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  let status: ExecutionState["status"] = "working";
  let children = false;
  let request = withRequest;
  const workspace = () =>
    demoWorkspace().map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.map((tree) => ({
        ...tree,
        sessions: tree.sessions.map((session) => ({
          ...session,
          subagents: children ? session.subagents : [],
        })),
      })),
    }));
  const selection = new WorkspaceSelection(workspace());
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    onPrompt: () => ok(undefined),
    initialDrafts: { a1: "Retained draft" },
    onComplete: async () =>
      ok({
        items: [{ kind: "file", value: "context.txt", description: "Context file" }],
        truncated: false,
      }),
    getSessionDetails: () => ({
      status,
      output: "",
      error: null,
      sections: [
        {
          id: "history",
          kind: "assistant",
          title: "Agent",
          text:
            "```text\n" +
            Array.from({ length: 70 }, (_, index) => `OLDER_LINE_${index}\n`).join("") +
            "```",
          status: "complete",
        },
        {
          id: "edit",
          kind: "tool",
          title: "edit",
          summary: "example.ts",
          text: "EDIT_RESULT",
          status: "complete",
        },
        ...(request
          ? [
              {
                id: "request",
                kind: "user" as const,
                title: "You",
                text: "Request caption ".repeat(30),
                status: "complete" as const,
              },
            ]
          : []),
      ],
    }),
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) {
      throw new Error(`Missing ${id}`);
    }

    return node;
  };

  await render();

  const scroll = get("session-transcript");
  if (!(scroll instanceof ScrollBoxRenderable)) {
    throw new Error("Missing transcript");
  }

  return {
    ...app,
    clock,
    view,
    scroll,
    render,
    get,
    lastCard() {
      return scroll.content
        .getChildren()
        .filter((node): node is BoxRenderable => node instanceof BoxRenderable)
        .at(-1)!;
    },
    async state(next: ExecutionState["status"], ownedChildren = false) {
      status = next;
      children = ownedChildren;
      selection.replaceSnapshot(workspace());
      await render();
    },
    async request(next: boolean) {
      request = next;
      selection.replaceSnapshot(workspace());
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test.each([120, 60])(
  "At width %i, execution, completion, and subagent transitions retain one-row bottom spacing",
  async (width) => {
    // The final tinted tool card exposes duplicate gutters that plain text can conceal.
    const app = await mount();
    const expectStatusGap = () => {
      const card = app.lastCard();
      const row = app.get("transcript-status-row");
      const composer = app.get("agent-composer");
      const content = row.getChildren().find((node) => node.visible)!;

      expect(row.visible).toBe(true);
      expect({
        above: content.y - card.y - card.height,
        below: composer.y - content.y - content.height,
        statusHeight: row.height,
      }).toEqual({ above: 1, below: 1, statusHeight: 1 });
    };
    const expectComposerGap = () => {
      const card = app.lastCard();
      const composer = app.get("agent-composer");

      expect(app.get("transcript-status-row").visible).toBe(false);
      expect(composer.y - card.y - card.height).toBe(1);
    };
    try {
      for (const height of [30, 18, 30]) {
        app.resize(width, height);
        await app.render();
        expectStatusGap();
        // Spinner tails retain their own row, but must not add a second boundary gutter.
        await app.state("complete");
        expectStatusGap();
        app.clock.advance(500);
        await app.render();
        expectComposerGap();
        // Owned-child feedback uses the same boundary even when the parent run has finished.
        await app.state("complete", true);
        expectStatusGap();
        await app.state("complete");
        expectComposerGap();
        await app.state("working");
        expectStatusGap();
      }

      expect(app.view.promptDrafts.a1).toBe("Retained draft");
    } finally {
      await app.close();
    }
  },
);

test("Removing status rows preserves the first visible historical line, scroll, and input focus", async () => {
  const app = await mount();
  try {
    pressLeader(app, "a");
    app.scroll.scrollTo(12);
    await app.render();

    const top = app.scroll.scrollTop;
    const focus = app.renderer.currentFocusedRenderable;
    const first = () =>
      app
        .captureCharFrame()
        .split("\n")
        .slice(app.scroll.viewport.y, app.scroll.viewport.y + app.scroll.viewport.height)
        .join("\n")
        .match(/OLDER_LINE_\d+/u)?.[0];
    const before = first();

    expect(before).toBeDefined();
    expect(app.view.workViewPreferences.agentViews?.a1?.follow).toBe(false);

    // Releasing the status region changes viewport height, not the paused reader's anchor.
    await app.state("complete");
    app.clock.advance(500);
    await app.render();
    expect(app.get("transcript-status-row").visible).toBe(false);
    expect(first()).toBe(before);
    expect(app.scroll.scrollTop).toBe(top);
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.view.promptDrafts.a1).toBe("Retained draft");
    await app.state("working");
    expect(first()).toBe(before);
    expect(app.scroll.scrollTop).toBe(top);
  } finally {
    await app.close();
  }
});

test.each([120, 60])(
  "At width %i, two-line Working avoids return-to-bottom controls and preserves reading positions and drafts",
  async (width) => {
    // Request captions add an occupied status row, never a blank slot for the floating button.
    const app = await mount(true);
    const first = () =>
      app
        .captureCharFrame()
        .split("\n")
        .slice(app.scroll.viewport.y, app.scroll.viewport.y + app.scroll.viewport.height)
        .join("\n")
        .match(/OLDER_LINE_\d+/u)?.[0];
    const verify = () => {
      const row = app.get("transcript-status-row");
      const run = app.get("agent-run-status");
      const caption = app.get("agent-run-request") as TextRenderable;
      const button = app.get("transcript-bottom-button");
      const composer = app.get("agent-composer");

      expect(row.height).toBe(2);
      expect(run.height).toBe(2);
      expect(caption.y).toBe(run.y + 1);
      expect(caption.x).toBe(run.x);
      expect(caption.plainText).toContain("Request caption");
      expect(caption.plainText).toStartWith("“");
      expect(caption.plainText).toEndWith("…”");
      expect(caption.height).toBe(1);
      expect(composer.y - row.y - row.height).toBe(1);
      expect(button.visible).toBe(true);
      expect(button.y).toBe(app.scroll.viewport.y + app.scroll.viewport.height);
      expect(button.y + button.height).toBeLessThanOrEqual(run.y);
    };
    try {
      app.resize(width, 30);
      await app.render();
      pressLeader(app, "a");
      app.scroll.scrollTo(12);
      await app.render();

      const before = first();
      const top = app.scroll.scrollTop;

      expect(before).toBeDefined();
      verify();

      // Adding/removing the caption and settling a run may resize the viewport, not move its reader.
      await app.request(false);
      expect(app.get("transcript-status-row").height).toBe(1);
      expect(first()).toBe(before);
      expect(app.scroll.scrollTop).toBe(top);
      await app.request(true);
      verify();
      expect(first()).toBe(before);
      expect(app.scroll.scrollTop).toBe(top);
      await app.state("complete");
      app.clock.advance(500);
      await app.render();
      expect(app.get("transcript-status-row").visible).toBe(false);
      expect(first()).toBe(before);
      expect(app.scroll.scrollTop).toBe(top);
      await app.state("working");
      verify();
      app.resize(width, 8);
      await app.render();
      expect(app.get("transcript-bottom-button").visible).toBe(false);
      app.resize(width, 30);
      await app.render();
      verify();
      expect(first()).toBe(before);

      // A primary click resumes following without submitting or clearing the retained input.
      const button = app.get("transcript-bottom-button");
      await app.mockMouse.click(button.x + 1, button.y);
      await app.render();
      expect(app.view.workViewPreferences.agentViews?.a1?.follow).toBe(true);
      expect(app.scroll.scrollTop).toBe(
        Math.max(0, app.scroll.scrollHeight - app.scroll.viewport.height),
      );
      expect(button.visible).toBe(false);
      expect(app.view.promptDrafts.a1).toBe("Retained draft");
      expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    } finally {
      await app.close();
    }
  },
);

test.each([120, 60])(
  "At width %i, completion, input, and bottom information add no extra section gaps",
  async (width) => {
    const app = await mount();
    try {
      app.resize(width, 24);
      pressLeader(app, "a");
      await app.mockInput.typeText(" @");
      await app.render();
      app.clock.advance(150);
      await app.render();

      const composer = app.get("agent-composer");
      const menu = app.get("prompt-completions");
      const metadata = app.get("session-status");

      // Only the conversation/status/input groups have separation; completion stays attached to input.
      expect(menu.visible).toBe(true);
      expect(app.captureCharFrame()).toContain("context.txt");
      expect(menu.y).toBe(composer.y + composer.height);
      expect(metadata.y).toBe(menu.y + menu.height);
      expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
      expect(app.view.promptDrafts.a1).toBe("Retained draft @");
      app.mockInput.pressEscape();
      await app.render();
      expect(metadata.y).toBe(composer.y + composer.height);
    } finally {
      await app.close();
    }
  },
);
