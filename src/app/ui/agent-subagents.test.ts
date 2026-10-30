import { expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { PiSubagentDisplay } from "../../agents/pi-subagent-display.ts";
import { piSubagentsFromWidget } from "../../agents/pi-subagent-status.ts";
import { expectOk } from "../../testing/results.ts";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import type { Subagent } from "../../agents/model.ts";
import { ok } from "../../result.ts";
import { pressLeader } from "../../testing/keys.ts";

const child = (id: string, elapsedMs: number): Subagent => ({
  id,
  name: id,
  status: "working",
  request: {
    text: `Received ${id} task with Unicode 한글👩‍💻 e\u0301 details `.repeat(10),
    images: 0,
    files: 0,
  },
  runTiming: { startedAt: 1000, elapsedMs },
});

async function mount(width = 120) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width, height: 30, kittyKeyboard: true, clock });
  let children: readonly Subagent[] = [];
  let status: ExecutionState["status"] = "working";
  const workspace = () =>
    demoWorkspace().map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.map((tree) => ({
        ...tree,
        sessions: tree.sessions.map((session) => ({
          ...session,
          subagents: session.id === "a1" ? children : [],
        })),
      })),
    }));
  const selection = new WorkspaceSelection(workspace());
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    onPrompt: () => ok(undefined),
    initialDrafts: { a1: "Retained unsent draft" },
    getSessionDetails: () => ({
      status,
      output: "",
      error: null,
      sections: [
        {
          id: "request",
          kind: "user",
          title: "You",
          text: "A long original main request ".repeat(30),
          status: "complete",
        },
        {
          id: "history",
          kind: "assistant",
          title: "Agent",
          text: Array.from({ length: 100 }, (_, index) => `HISTORY_LINE_${index}`).join("\n"),
          status: "streaming",
        },
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

  const list = get("subagent-summary");
  const scroll = get("session-transcript");
  if (!(scroll instanceof ScrollBoxRenderable)) {
    throw new Error("Missing transcript");
  }

  const rows = () =>
    list
      .getChildren()
      .filter((node): node is BoxRenderable => node instanceof BoxRenderable && node.visible);
  const text = (node: TextRenderable) => (node.visible ? node.plainText : "");

  return {
    ...app,
    clock,
    view,
    selection,
    get,
    render,
    list,
    scroll,
    rows,
    text,
    headings: () =>
      rows().map((row) => (row.getChildren()[0]!.getChildren().at(-1) as TextRenderable).plainText),
    captions: () =>
      rows()
        .map((row) => row.getChildren()[1] as TextRenderable)
        .filter((node) => node.visible),
    async update(next: readonly Subagent[], mainStatus = status) {
      children = next;
      status = mainStatus;
      selection.replaceSnapshot(workspace());
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test.each([120, 60, 200])(
  "At width %i, per-child status expands below Working with independently timed and half-width request previews",
  async (width) => {
    // Both the parent and children have long input, but the user's draft is unrelated to their work.
    const app = await mount(width);
    try {
      pressLeader(app, "a");
      await app.render();

      const prompt = app.get("session-prompt");
      const focus = app.renderer.currentFocusedRenderable;
      const inputY = app.get("agent-composer").y;

      await app.update([child("writer", 12000), child("reviewer", 24000)]);

      // Child rows extend one shared status block without pushing the composer off-screen.
      const main = app.get("agent-run-status");
      const group = app.get("transcript-status-row");

      expect(app.list.y).toBe(main.y + main.height);
      expect(app.headings()).toEqual(["writer · Working (12s)", "reviewer · Working (24s)"]);
      expect(group.height).toBe(main.height + app.list.height);
      expect(app.get("agent-composer").y).toBe(inputY);

      const captions = [app.get("agent-run-request") as TextRenderable, ...app.captions()];
      expect(captions).toHaveLength(3);
      for (const caption of captions) {
        expect(caption.plainText).toStartWith("“");
        expect(caption.plainText).toEndWith("…”");
        expect(Bun.stringWidth(caption.plainText)).toBeLessThanOrEqual(
          Math.min(60, Math.floor(app.list.width / 2)),
        );
        expect(caption.plainText).not.toContain("\uFFFD");
      }

      app.clock.advance(2000);
      await app.update([child("writer", 12000), child("reviewer", 24000)]);
      expect(app.headings()).toEqual(["writer · Working (14s)", "reviewer · Working (26s)"]);
      expect(app.renderer.currentFocusedRenderable).toBe(focus);
      expect(focus).toBe(prompt);
      expect(app.view.promptDrafts.a1).toBe("Retained unsent draft");
    } finally {
      await app.close();
    }
  },
);

test("Pi agent names and quoted inputs share a starting column without an extra input indent", async () => {
  // Four direct launches have real authored inputs independent from their task labels.
  const app = await mount();
  const events = createEventBus();
  const display = new PiSubagentDisplay(events, () => {});
  const names = ["implementer", "issue_writer", "reviewer", "review_fixer"];
  try {
    app.resize(120, 40);
    await app.render();
    pressLeader(app, "a");

    const focus = app.renderer.currentFocusedRenderable;
    for (const [index, name] of names.entries()) {
      const task =
        index === 0 ? "Check input" : `Received ${name} input 한글👩‍💻 e\u0301 `.repeat(10);
      display.handleEvent({
        type: "tool_execution_start",
        toolCallId: name,
        toolName: "subagent",
        args: { agent: name, task },
      });
      events.emit("subagent:async-started", {
        id: name,
        mode: "single",
        agent: name,
        task: "[prompt redacted]",
      });
      display.handleEvent({
        type: "tool_execution_end",
        toolCallId: name,
        toolName: "subagent",
        result: { content: [], details: { mode: "single", asyncId: name } },
        isError: false,
      });
    }

    const widget = [
      "PI_SUBAGENT_ASYNC_JSON:" +
        JSON.stringify({
          kind: "pi-subagents.async-status-snapshot",
          version: 1,
          generatedAt: 10000,
          runs: names.map((name) => ({
            id: name,
            kind: "subagent",
            label: name,
            state: "running",
            children: [
              {
                id: "step:0",
                kind: "step",
                label: `Test ${name} response`,
                state: "running",
                startedAt: 1000,
              },
            ],
          })),
        }),
    ];

    await app.update(expectOk(piSubagentsFromWidget(widget, display.lookup)));

    // Each input starts under its agent name, not under an additional indentation level.
    expect(app.headings()).toEqual(names.map((name) => `${name} · Working (9s)`));

    const captions = app.captions();
    expect(captions).toHaveLength(4);
    expect(captions[0]!.plainText).toBe("“Check input”");
    for (const [index, caption] of captions.entries()) {
      const heading = app.rows()[index]!.getChildren()[0]!.getChildren().at(-1)!;
      expect(caption.x).toBe(heading.x);
      expect(caption.plainText).toStartWith("“");
      expect(Bun.stringWidth(caption.plainText)).toBeLessThanOrEqual(60);
      if (index > 0) {
        expect(caption.plainText).toEndWith("…”");
      }
    }

    expect(app.captureCharFrame()).not.toContain("Test implementer response");
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.view.promptDrafts.a1).toBe("Retained unsent draft");
  } finally {
    display.dispose();
    await app.close();
  }
});

test("Child expansion and removal preserve a paused transcript anchor, caret, and input focus", async () => {
  // Historical reading and an unsent input must survive status-region height changes.
  const app = await mount();
  try {
    pressLeader(app, "a");
    app.scroll.scrollTo(12);
    await app.render();

    const top = app.scroll.scrollTop;
    const focus = app.renderer.currentFocusedRenderable;
    const firstLine = () =>
      app
        .captureCharFrame()
        .split("\n")
        .slice(app.scroll.viewport.y, app.scroll.viewport.y + app.scroll.viewport.height)
        .join("\n")
        .match(/HISTORY_LINE_\d+/u)?.[0];
    const before = firstLine();

    expect(before).toBeDefined();

    await app.update([child("writer", 1000), child("reviewer", 2000)]);

    expect(firstLine()).toBe(before);
    expect(app.scroll.scrollTop).toBe(top);
    await app.update([]);
    expect(firstLine()).toBe(before);
    expect(app.scroll.scrollTop).toBe(top);
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.view.promptDrafts.a1).toBe("Retained unsent draft");
  } finally {
    await app.close();
  }
});

test("Children remain visible after the parent settles and terminal durations stop advancing immediately", async () => {
  // Completion of a parent message does not prove that its background children have finished.
  const app = await mount();
  try {
    await app.update([], "complete");
    app.clock.advance(500);
    await app.render();

    const idleTimers = app.clock.pendingTimerCount;
    await app.update([child("reviewer", 12000)], "working");

    await app.update([child("reviewer", 12000)], "complete");
    app.clock.advance(500);
    await app.render();

    expect(app.get("agent-run-status").visible).toBe(false);
    expect(app.list.visible).toBe(true);
    expect(app.headings()[0]).toContain("Working (12s)");
    await app.update([{ ...child("reviewer", 14000), status: "failure" }]);
    expect(app.headings()).toEqual(["reviewer · Failed (14s)"]);
    app.clock.advance(5000);
    await app.render();
    expect(app.headings()).toEqual(["reviewer · Failed (14s)"]);
    app.selection.selectSession("demo:main", "a2");
    await app.render();
    expect(app.list.visible).toBe(false);
    expect(app.clock.pendingTimerCount).toBe(idleTimers);
  } finally {
    await app.close();
  }
});

test("All settled child feedback disappears together after ten seconds without changing focus or drafts", async () => {
  // One settled row must stay visible while another child is still working.
  const app = await mount();
  try {
    pressLeader(app, "a");
    const focus = app.renderer.currentFocusedRenderable;
    await app.update(
      [{ ...child("writer", 1000), status: "complete" }, child("reviewer", 2000)],
      "complete",
    );
    app.clock.advance(12_000);
    await app.render();
    expect(app.list.visible).toBe(true);

    await app.update([
      { ...child("writer", 1000), status: "complete" },
      { ...child("reviewer", 3000), status: "failure" },
    ]);
    app.clock.advance(9999);
    await app.render();
    expect(app.list.visible).toBe(true);
    app.clock.advance(1);
    await app.render();

    expect(app.list.visible).toBe(false);
    expect(app.get("transcript-status-row").visible).toBe(false);
    expect(app.captureCharFrame()).not.toContain("reviewer · Failed");
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.view.promptDrafts.a1).toBe("Retained unsent draft");
  } finally {
    await app.close();
  }
});

test("Meaningful progress updates the existing status caption without creating transcript messages", async () => {
  // Progress belongs to the compact live status area, not a new JSON notice in the transcript.
  const app = await mount();
  try {
    pressLeader(app, "a");
    const focus = app.renderer.currentFocusedRenderable;

    await app.update([
      { ...child("reviewer", 1000), progress: "Found a compatibility issue 한글👩‍💻" },
    ]);
    const captions = app.captions();

    expect(captions).toHaveLength(1);
    expect(captions[0]!.plainText).toContain("Found a compatibility issue");
    expect(captions[0]!.plainText).not.toContain("Received reviewer task");
    expect(app.captureCharFrame()).not.toContain("radian.subagent-event");
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.view.promptDrafts.a1).toBe("Retained unsent draft");
  } finally {
    await app.close();
  }
});

test("Compact layouts bound child rows and prioritize active children without stealing text input", async () => {
  // A large set of settled children must not hide the one agent that is still working.
  const app = await mount(60);
  try {
    const children = [
      ...Array.from({ length: 10 }, (_, index): Subagent => ({
        ...child(`done-${index}`, 2000),
        status: "complete",
      })),
      child("active", 9000),
    ];
    app.resize(60, 12);
    await app.render();
    pressLeader(app, "a");

    await app.update(children);

    expect(app.headings()[0]).toBe("active · Working (9s)");
    expect(app.list.height).toBeLessThanOrEqual(4);
    expect(app.captureCharFrame()).toContain("more subagents");
    expect(app.scroll.height).toBeGreaterThan(0);
    expect(app.get("session-status").y + app.get("session-status").height).toBeLessThanOrEqual(
      app.get("app-footer").y,
    );
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.view.promptDrafts.a1).toBe("Retained unsent draft");
  } finally {
    await app.close();
  }
});
