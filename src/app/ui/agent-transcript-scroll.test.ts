import { expect, test } from "bun:test";
import { pressLeader } from "../../testing/keys.ts";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import type { AgentStatus } from "../../agents/model.ts";
import { emptyTranscriptView } from "../../agents/transcript-preferences.ts";
import { ok } from "../../result.ts";

const history = (): TranscriptSection[] =>
  Array.from({ length: 35 }, (_, index) => ({
    id: `older-${index}`,
    kind: index % 2 ? "notice" : "user",
    title: index % 2 ? "Agent error" : "You",
    text:
      `OLDER_MARKER_${index}\n` +
      ("Wrapped historical text with Unicode 한글👩‍💻 ".repeat(20) + "\n").repeat(2),
    status: index % 2 ? "error" : "complete",
  }));
const final: TranscriptSection = {
  id: "final",
  kind: "assistant",
  title: "Agent",
  status: "complete",
  text: "**FINAL_ANSWER_VISIBLE**\n\nThe response remains reachable.",
};

async function mount(width: number) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width, height: 30, kittyKeyboard: true, clock });
  let sections = history();
  let status: AgentStatus = "working";
  const workspace = () =>
    demoWorkspace().map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.map((tree) => ({
        ...tree,
        sessions: tree.sessions.map((session) => ({
          ...session,
          subagents: [],
          ...(session.id === "a1" ? { status } : {}),
        })),
      })),
    }));
  const selection = new WorkspaceSelection(workspace());
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    onPrompt: () => ok(undefined),
    initialDrafts: { a1: "Retained scroll draft" },
    initialWorkViews: { active: {}, agentScroll: {}, agentViews: { a1: emptyTranscriptView() } },
    getSessionDetails: () => ({ status, error: null, output: "", sections }),
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  await render();
  const scroll = app.renderer.root.findDescendantById("session-transcript");
  if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript");
  return {
    ...app,
    view,
    clock,
    scroll,
    render,
    state: () => view.workViewPreferences.agentViews?.a1,
    async update(next: TranscriptSection[], phase: AgentStatus) {
      sections = next;
      status = phase;
      selection.replaceSnapshot(workspace());
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test.each([60, 120, 200])(
  "At width %i, failure/retry/completion preserves tail following across culled wrapped history",
  async (width) => {
    // Offscreen plain editors have no settled public width but still contribute to the scroll extent.
    const app = await mount(width);
    try {
      const focus = app.renderer.currentFocusedRenderable;
      const error: TranscriptSection = {
        id: "failure",
        kind: "notice",
        title: "Agent error",
        text: ("A recoverable failure with a long diagnostic line ".repeat(18) + "\n").repeat(2),
        status: "error",
      };
      const thinking: TranscriptSection = {
        id: "thinking",
        kind: "thinking",
        title: "Thinking",
        text: "Retrying and comparing test counts",
        status: "streaming",
      };

      await app.update([...history(), error], "failure");
      app.clock.advance(500);
      await app.render();
      await app.update([...history(), error, thinking], "working");
      await app.update(
        [...history(), error, { ...thinking, status: "complete" }, final],
        "complete",
      );
      app.clock.advance(500);
      await app.render();
      const last = app.scroll.content.getChildren().at(-1)!;

      expect(app.captureCharFrame()).toContain("FINAL_ANSWER_VISIBLE");
      expect(last.y + last.height).toBeLessThanOrEqual(
        app.scroll.viewport.y + app.scroll.viewport.height,
      );
      expect(app.state()?.follow).toBe(true);
      expect(app.renderer.currentFocusedRenderable).toBe(focus);
      expect(app.view.promptDrafts.a1).toBe("Retained scroll draft");

      // A later width change must invalidate cached line counts and retain the true bottom.
      app.resize(width === 60 ? 160 : 60, 30);
      await app.render();
      expect(app.captureCharFrame()).toContain("FINAL_ANSWER_VISIBLE");
      expect(app.state()?.follow).toBe(true);
    } finally {
      await app.close();
    }
  },
);

test("Failure and recovery do not resume following for a user reading older wrapped content", async () => {
  // A geometry correction is not permission to pull a manually paused reader to the bottom.
  const app = await mount(120);
  try {
    await app.update([...history(), final], "working");
    app.scroll.scrollTo(20);
    await app.render();
    const top = app.scroll.scrollTop;
    const focus = app.renderer.currentFocusedRenderable;
    const before = app.captureCharFrame().split("\n")[app.scroll.viewport.y];
    expect(app.state()?.follow).toBe(false);

    const failure: TranscriptSection = {
      id: "failure",
      kind: "notice",
      title: "Agent error",
      text: "Wrapped failure ".repeat(100),
      status: "error",
    };
    await app.update([...history(), failure, final], "failure");
    app.clock.advance(500);
    await app.render();
    await app.update(
      [...history(), failure, { ...final, text: "A newer final response" }],
      "complete",
    );

    expect(app.state()?.follow).toBe(false);
    expect(app.scroll.scrollTop).toBe(top);
    expect(app.captureCharFrame().split("\n")[app.scroll.viewport.y]).toBe(before);
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.view.promptDrafts.a1).toBe("Retained scroll draft");

    // The configured latest command must reach the actual answer after an intentional pause.
    pressLeader(app, "[");
    app.mockInput.pressKey("g");
    app.mockInput.pressKey("e");
    await app.render();
    expect(app.state()?.follow).toBe(true);
    expect(app.captureCharFrame()).toContain("A newer final response");
  } finally {
    await app.close();
  }
});
