import { expect, test } from "bun:test";
import { CodeRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { AgentPanel } from "./agent-panel.ts";
import { SessionPreview } from "./session-preview.ts";
import { Button } from "../../ui/button.ts";
import { defaultKeymap } from "../../keybindings/config.ts";
import type { ExecutionState } from "../session-registry.ts";
import type { Worktree } from "../../workspace/model.ts";
import { ok } from "../../result.ts";

const sections = [
  {
    id: "first",
    kind: "user" as const,
    title: "You",
    text: "FIRST_RETAINED_SECTION",
    status: "complete" as const,
  },
  ...Array.from({ length: 8 }, (_, index) => ({
    id: `answer-${index}`,
    kind: "assistant" as const,
    title: "Agent",
    text: `### Saved answer ${index}\n\n**Content ${index}**`,
    status: "complete" as const,
  })),
  {
    id: "tool",
    kind: "tool" as const,
    title: "read",
    text: "Tool content must remain folded",
    status: "complete" as const,
  },
];
const telemetry = {
  provider: "fixture",
  model: "same-session-model",
  effort: "high",
  fast: true,
  context: { usedTokens: 72000, maxTokens: 200000 },
  weekly: null,
};
const states: { name: string; state: ExecutionState }[] = [
  {
    name: "working",
    state: {
      conversationId: "conversation",
      status: "working",
      error: null,
      output: "",
      sections,
      telemetry,
      runTiming: { startedAt: 1000, elapsedMs: 12000 },
      pendingMessages: [{ text: "Queued follow-up", images: 0, files: 0 }],
    },
  },
  {
    name: "complete",
    state: {
      conversationId: "conversation",
      status: "complete",
      error: null,
      output: "",
      sections,
      telemetry,
    },
  },
  {
    name: "failure",
    state: {
      conversationId: "conversation",
      status: "failure",
      error: "Saved failure",
      output: "",
      sections,
      telemetry,
    },
  },
  {
    name: "compacting",
    state: {
      conversationId: "conversation",
      status: "working",
      activity: "compacting",
      error: null,
      output: "",
      sections,
      telemetry,
    },
  },
  {
    name: "empty",
    state: {
      conversationId: "conversation",
      status: null,
      error: null,
      output: "",
      sections: [],
      telemetry,
    },
  },
];
const descendants = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(descendants),
];

async function renderSession(
  preview: boolean,
  state: ExecutionState,
  width: number,
  height: number,
) {
  const app = await createTestRenderer({ width, height, clock: new ManualClock() });
  const keymap = defaultKeymap();
  const keyHint = keymap.hint.bind(keymap);
  const noop = () => {};
  const tree: Worktree = {
    id: "tree",
    path: "/fixture",
    name: "fixture",
    branch: "main",
    sessions: [
      {
        id: "session",
        name: "Current task",
        status: state.status,
        subagents: [
          {
            id: "child",
            name: "Child task",
            status: "working",
            request: { text: "Inspect the source", images: 0, files: 0 },
          },
        ],
      },
      { id: "other", name: "Other task", status: "complete", subagents: [] },
    ],
  };
  const details = (id: string) => (id === "session" ? state : null);
  let surface: SessionPreview | undefined;
  let panel: AgentPanel;
  if (preview) {
    surface = new SessionPreview(app.renderer, "fixture", {
      notice: noop,
      changed: noop,
      focusList: noop,
      keyHint,
      details,
    });
    panel = surface.panel;
    app.renderer.root.add(surface.body.root);
    surface.show(tree, "session", state, true, undefined, "Unsent draft");
  } else {
    panel = new AgentPanel(
      app.renderer,
      {
        onNewSession: noop,
        onPrompt: () => ok(undefined),
        getSessionDetails: details,
        initialDrafts: { session: "Unsent draft" },
      },
      (label, activate) => new Button(app.renderer, label, activate),
      noop,
      noop,
      noop,
      {},
      noop,
      { initialPosition: "end", keyHint },
    );
    app.renderer.root.add(panel.root);
    panel.update(tree, "session", new Set(tree.sessions.map((session) => session.id)), true);
  }

  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
    await Promise.all(
      descendants(panel.root)
        .filter((node): node is CodeRenderable => node instanceof CodeRenderable)
        .map((node) => node.highlightingDone),
    );
    await app.renderOnce();
    await app.renderOnce();
  };
  try {
    await render();

    const frame = app.captureCharFrame();
    const height = panel.transcriptScroll.scrollHeight;
    const colors = app.captureSpans().lines.map((line) =>
      line.spans.map((span) => ({
        text: span.text,
        attributes: span.attributes,
        foreground: span.fg.toInts(),
        background: span.bg.toInts(),
      })),
    );

    panel.transcriptScroll.scrollTo(0);
    await render();

    return { frame, colors, height, top: app.captureCharFrame() };
  } finally {
    if (surface) {
      surface.dispose();
    } else {
      panel.dispose();
    }

    await app.dispose();
  }
}

for (const [width, height] of [
  [120, 30],
  [60, 16],
  [60, 7],
] as const) {
  test.each(states)(
    `$name previews match the entire session screen at ${width}x${height}`,
    async ({ state }) => {
      // The same runtime state, draft, roster, native session padding and dimensions go to both surfaces.
      const live = await renderSession(false, state, width, height);

      // Previewing uses the shared Agent renderer, not a shortened transcript or alternate composer.
      const preview = await renderSession(true, state, width, height);

      // Cell content, typography/colors, full scroll extent and the earliest sections all remain identical.
      expect(preview.frame).toBe(live.frame);
      expect(preview.colors).toEqual(live.colors);
      expect(preview.height).toBe(live.height);
      expect(preview.top).toBe(live.top);
      expect(preview.frame).not.toContain("Read-only preview");
    },
  );
}
