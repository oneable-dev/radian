import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import type { WorkViewPreferences } from "../../runtime/protocol.ts";
import { ok } from "../../result.ts";

const summary = (): TranscriptSection => ({
  id: "compaction",
  kind: "notice",
  title: "Context compacted",
  status: "complete",
  text: Array.from({ length: 80 }, (_, i) => `COMPACTION_SUMMARY_${i}`).join("\n"),
});
const history = (): TranscriptSection[] => [
  {
    id: "request",
    kind: "user",
    title: "You",
    text: "Previous delivered request",
    status: "complete",
  },
  {
    id: "answer",
    kind: "assistant",
    title: "Agent",
    text: "Previous response",
    status: "complete",
  },
];
async function mount(
  initial: ExecutionState = {
    status: "complete",
    output: "",
    error: null,
    sections: [...history(), summary()],
  },
  preferences?: WorkViewPreferences,
) {
  const clock = new ManualClock(),
    app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  let current = initial;
  const snapshot = () =>
    demoWorkspace().map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.map((tree) => ({
        ...tree,
        sessions: tree.sessions.map((session) =>
          session.id === "a1" ? { ...session, status: current.status, subagents: [] } : session,
        ),
      })),
    }));
  const selection = new WorkspaceSelection(snapshot());
  const copied: string[] = [],
    sent: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    onPrompt: (_id, text) => {
      sent.push(text);
      return ok(undefined);
    },
    getSessionDetails: (id) => (id === "a1" ? current : null),
    initialDrafts: { a1: "retained draft" },
    ...(preferences ? { initialWorkViews: preferences } : {}),
    onCopyTranscript: async (text) => {
      copied.push(text);
      return ok("Copied to clipboard");
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
    selection,
    view,
    copied,
    sent,
    render,
    get,
    state: () => view.workViewPreferences.agentViews?.[selection.sessionId ?? ""],
    tabStatus(id = "a1") {
      const tab = `session:demo:main:${id}`,
        number = get(`${tab}:number`),
        title = get(`${tab}:title`);
      return app
        .captureCharFrame()
        .split("\n")
        [number.y]!.slice(number.x + number.width, title.x)
        .trim();
    },
    async update(state: ExecutionState) {
      current = state;
      selection.replaceSnapshot(snapshot());
      await render();
    },
    async transcript() {
      pressLeader(app, "[");
      app.mockInput.pressKey("HOME");
      app.mockInput.pressKey("j");
      app.mockInput.pressKey("j");
      await render();
    },
    async clickSummary() {
      const lines = app.captureCharFrame().split("\n"),
        y = lines.findIndex((line) => line.includes("[Context compacted]"));
      if (y < 0) throw new Error(`Missing compaction heading\n${app.captureCharFrame()}`);
      await app.mockMouse.click(lines[y]!.indexOf("[Context compacted]"), y);
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test.each([false, true])(
  "Compaction with Fast %s uses one-cell circles in tabs and status, preserving drafts and focus",
  async (fast) => {
    // Manual compaction uses one unpadded circle regardless of the session's Fast setting.
    const compacting = {
      status: "working" as const,
      activity: "compacting" as const,
      output: "",
      error: null,
      sections: history(),
      telemetry: {
        provider: "fixture",
        model: "fixture",
        effort: "high",
        fast,
        context: null,
        weekly: null,
      },
    };
    const app = await mount(compacting);
    try {
      const status = app.get("agent-run-status-text"),
        prompt = app.get("session-prompt");
      pressLeader(app, "a");
      await app.render();
      const label = () =>
        app
          .captureCharFrame()
          .split("\n")
          [status.y]!.slice(status.x, status.x + status.width)
          .trimEnd();
      expect(label()).toBe("Compacting context (0s · <Esc> to interrupt)");
      expect(app.get("agent-run-loading").visible).toBe(true);
      expect(app.tabStatus()).toBe("○");
      expect(app.captureCharFrame()).toContain("○ Compacting context");
      expect(app.get("agent-run-loading").width).toBe(1);
      expect(status.x).toBe(app.get("agent-run-loading").x + 2);

      // The tab and body animate independently from the same session activity without changing the draft.
      app.clock.advance(80);
      await app.render();

      expect(app.tabStatus()).toBe("◔");
      expect(app.captureCharFrame()).toContain("◔ Compacting context");
      expect(label()).not.toContain("Previous delivered request");

      // Clear status after compaction and hide long summary bodies by default.
      await app.update({
        status: "complete",
        output: "",
        error: null,
        sections: [...history(), summary()],
      });
      app.clock.advance(420);
      await app.render();

      expect(status.visible).toBe(false);
      expect(app.get("agent-run-loading").visible).toBe(false);
      expect(app.tabStatus()).toBe("");
      expect(app.captureCharFrame()).toContain("[Context compacted] (<C-o> to expand)");
      expect(app.captureCharFrame()).not.toContain("COMPACTION_SUMMARY_");
      expect(app.view.promptDrafts.a1).toBe("retained draft");
      expect(app.renderer.currentFocusedRenderable?.id).toBe(prompt.id);
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Folded compaction summaries toggle by keyboard and copy full source while collapsed", async () => {
  // Initially show only one section header even when the summary exceeds the viewport.
  const app = await mount();
  try {
    await app.transcript();
    expect(app.captureCharFrame()).not.toContain("COMPACTION_SUMMARY_");

    // Reuse existing transcript folding shortcuts to expand and collapse bodies.
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();
    expect(app.captureCharFrame()).toContain("COMPACTION_SUMMARY_0");
    expect(app.state()?.folded.compaction).toBe(false);
    app.mockInput.pressKey("z");
    app.mockInput.pressKey("a");
    await app.render();
    app.mockInput.pressKey("y");
    await app.render();

    expect(app.captureCharFrame()).not.toContain("COMPACTION_SUMMARY_");
    expect(app.state()?.folded.compaction).toBe(true);
    expect(app.copied).toEqual([summary().text]);
    expect(app.view.promptDrafts.a1).toBe("retained draft");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Clicking compaction headers toggles folding while ordinary notices stay expanded", async () => {
  const app = await mount();
  try {
    // Clicking compaction headers neither submits input nor modifies content.
    await app.clickSummary();
    expect(app.captureCharFrame()).toContain("COMPACTION_SUMMARY_0");
    expect(app.state()?.folded.compaction).toBe(false);
    await app.clickSummary();

    expect(app.captureCharFrame()).not.toContain("COMPACTION_SUMMARY_");
    expect(app.state()?.folded.compaction).toBe(true);
    await app.update({
      status: "complete",
      output: "",
      error: null,
      sections: [
        ...history(),
        summary(),
        {
          id: "notice",
          kind: "notice",
          title: "Compaction failed",
          text: "KEEP_FAILURE_VISIBLE",
          status: "error",
        },
      ],
    });
    expect(app.captureCharFrame()).toContain("KEEP_FAILURE_VISIBLE");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("User-expanded compaction summaries remain expanded across snapshots and UI restoration", async () => {
  let preferences: WorkViewPreferences | undefined;
  const app = await mount();
  try {
    // Explicitly saved expansion overrides default folding.
    await app.transcript();
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();
    await app.update({
      status: "complete",
      output: "",
      error: null,
      sections: [...history(), summary()],
    });
    expect(app.state()?.folded.compaction).toBe(false);
    preferences = structuredClone(app.view.workViewPreferences);
  } finally {
    await app.close();
  }
  const next = await mount(undefined, preferences);
  try {
    // New renderables restore folding from UI preferences, not model conversations.
    await next.transcript();
    expect(next.state()?.folded.compaction).toBe(false);
    expect(next.captureCharFrame()).toContain("COMPACTION_SUMMARY_0");
    expect(next.sent).toEqual([]);
  } finally {
    await next.close();
  }
});
