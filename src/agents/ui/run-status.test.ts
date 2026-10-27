import { expect, test } from "bun:test";
import type { TerminalColors } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import type { ExecutionState } from "../session-registry.ts";
import { SessionTranscript, type TranscriptSection } from "../transcript.ts";
import { uiTheme } from "../../ui/theme.ts";
import { RunStatus } from "./run-status.ts";

const user = (text: string, id = "request"): TranscriptSection => ({
  id,
  kind: "user",
  title: "You",
  text,
  status: "complete",
});
const working = (sections: readonly TranscriptSection[]): ExecutionState => ({
  status: "working",
  output: "",
  error: null,
  sections,
});
const settled = (
  outcome: "complete" | "cancelled" | "unfinished" | "error",
): TranscriptSection => ({
  id: "answer",
  kind: "assistant",
  title: "Agent",
  text: "Output",
  status: "complete",
  completion: { startedAt: 1800000000000, completedAt: 1800000001000, durationMs: 1000, outcome },
});
async function mount(width = 70, interruptKey?: () => string) {
  const clock = new ManualClock(),
    app = await createTestRenderer({ width, height: 4, kittyKeyboard: true, clock });
  const status = new RunStatus(app.renderer, interruptKey);
  app.renderer.root.add(status.root);
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  const node = () => app.renderer.root.findDescendantById("agent-run-status-text")!;
  const captionNode = () => app.renderer.root.findDescendantById("agent-run-request")!;
  return {
    ...app,
    clock,
    status,
    render,
    node,
    captionNode,
    caption: () =>
      captionNode().visible
        ? app.captureCharFrame().split("\n")[captionNode().y]!.slice(captionNode().x).trimEnd()
        : "",
    text: () =>
      node().visible ? app.captureCharFrame().split("\n")[node().y]!.slice(node().x).trimEnd() : "",
    spinner: () => app.renderer.root.findDescendantById("agent-run-loading")!,
    async close() {
      status.dispose();
      await app.dispose();
    },
  };
}

test("Working shows the actual latest request below it, never tool output or answers", async () => {
  const app = await mount();
  try {
    const latest = user("  Implement\nthe search\t carefully.  ", "latest");
    const state = working([
      user("Old request", "old"),
      latest,
      {
        id: "tool",
        kind: "tool",
        title: "bash",
        text: "DO NOT USE TOOL OUTPUT",
        status: "running",
      },
    ]);
    app.status.update("a", state, true);
    await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)");
    expect(app.caption()).toBe("“Implement the search carefully.”");
    expect(app.spinner().visible).toBe(true);
    expect(app.status.rows).toBe(2);
    expect(app.captionNode().y).toBe(app.node().y + 1);
    expect(app.captionNode().x).toBe(app.spinner().x);

    app.status.update("a", { ...state, sections: [...state.sections!, settled("complete")] }, true);
    await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)");
    expect(app.caption()).toBe("“Implement the search carefully.”");
    expect(latest.text).toBe("  Implement\nthe search\t carefully.  ");
  } finally {
    await app.close();
  }
});

test.each(["<C-x>", "<S-Tab>"])(
  "Run status preserves Neovim notation for configured interrupt key %s",
  async (key) => {
    // Interrupt hints are already formatted; preserve modifier capitalization.
    const app = await mount(70, () => key);
    try {
      // Show active work to verify its hints receive identical notation.
      app.status.update("a", working([user("Task")]), true);
      await app.render();

      // Preserve custom bindings in hints without changing input settings.
      expect(app.text()).toBe(`Working (0s · ${key} to interrupt)`);
    } finally {
      await app.close();
    }
  },
);

test("Compaction shows dedicated wording and animated spinners, restoring requests when work resumes", async () => {
  // Automatic compaction neither finishes the active run nor creates a new request.
  const app = await mount(),
    state = working([user("Previous delivered request")]);
  try {
    const compacting = { ...state, activity: "compacting" as const };
    app.status.update("a", compacting, true);
    await app.render();
    const first = app.captureCharFrame();
    expect(first).toContain("○ Compacting context");
    expect(app.spinner().width).toBe(1);
    expect(app.node().x).toBe(app.spinner().x + 2);

    // Circle-fill frames keep advancing without restarting on repeated compaction snapshots.
    app.clock.advance(80);
    app.status.update("a", compacting, true);
    await app.render();
    expect(app.captureCharFrame()).toContain("◔ Compacting context");
    expect(app.text()).toBe("Compacting context (0s · <Esc> to interrupt)");
    expect(app.spinner().visible).toBe(true);
    expect(app.captureCharFrame()).not.toBe(first);
    expect(app.text()).not.toContain("Previous delivered request");

    // Normal execution resumes the same request and spinner afterward.
    app.status.update("a", state, true);
    await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)");
    expect(app.caption()).toBe("“Previous delivered request”");
    expect(app.spinner().visible).toBe(true);
    expect(app.captureCharFrame()).toContain("⠋ Working");
    expect(app.node().x).toBe(app.spinner().x + 2);
  } finally {
    await app.close();
  }
});

test("Compaction overrides Fast arrows and shimmer, then restores them when execution resumes", async () => {
  // Compaction uses one cell like ordinary work, even when the session keeps Fast enabled.
  const app = await mount();
  const state = {
    ...working([user("Retained request")]),
    telemetry: {
      provider: "fixture",
      model: "fixture",
      effort: "high",
      fast: true,
      context: null,
      weekly: null,
    },
  };
  try {
    app.status.update("a", state, true);
    await app.render();
    const timers = app.clock.pendingTimerCount,
      textX = app.node().x;
    expect(app.captureCharFrame()).toContain("▶▷▷ Working");

    // Automatic compaction changes presentation without starting another operation or shimmer timer.
    app.status.update("a", { ...state, activity: "compacting" }, true);
    await app.render();

    expect(app.captureCharFrame()).toContain("○ Compacting context");
    expect(app.spinner().width).toBe(1);
    expect(app.node().x).toBe(textX - 2);
    expect(app.clock.pendingTimerCount).toBe(timers - 1);
    expect(app.caption()).toBe("");
    app.clock.advance(80);
    await app.render();
    expect(app.captureCharFrame()).toContain("◔ Compacting context");

    // Returning to model work restores the configured Fast presentation and original request.
    app.status.update("a", state, true);
    await app.render();
    expect(app.captureCharFrame()).toContain("▶▷▷ Working");
    expect(app.spinner().width).toBe(3);
    expect(app.node().x).toBe(textX);
    expect(app.caption()).toBe("“Retained request”");
    expect(app.clock.pendingTimerCount).toBe(timers);
  } finally {
    await app.close();
  }
});

test("Fast compaction completion finishes only the spinner minimum without redisplaying old requests", async () => {
  // Show compaction results immediately without a disappearing spinner flash.
  const app = await mount(),
    state = { ...working([user("Previous request")]), activity: "compacting" as const };
  try {
    app.status.update("a", state, true);
    await app.render();
    app.clock.advance(100);

    app.status.update("a", { ...state, status: "complete" }, true);
    await app.render();

    expect(app.text()).toBe("");
    expect(app.spinner().visible).toBe(true);
    app.clock.advance(400);
    await app.render();
    expect(app.spinner().visible).toBe(false);
    expect(app.status.hasContent).toBe(false);
  } finally {
    await app.close();
  }
});

test("Working requests truncate to one line after reserving attachment badges", async () => {
  const app = await mount(50);
  try {
    const request = {
      ...user("Original full prompt"),
      request: { text: "A long original prompt ".repeat(20), images: 2, files: 3 },
    };
    app.status.update("a", working([request]), true);
    await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)");
    expect(app.caption()).toBe("“…”  [2 images] [3 files]");
    expect(Bun.stringWidth(app.caption())).toBeLessThanOrEqual(25);
    expect(app.captureCharFrame().split("\n")[2]?.trim()).toBe("");
    expect(request.text).toBe("Original full prompt");
  } finally {
    await app.close();
  }
});

test("Working shows input and actual image/file counts without internal image guidance", async () => {
  // Verify the status display using sections from real SDK messages.
  const app = await mount(120),
    transcript = new SessionTranscript([]);
  const text =
    'Review both images [Image #1] [Image #2] @"/tmp/a.ts" @"/tmp/b.ts"\n\n[Image: original 3000x4000, displayed at 1500x2000. Multiply coordinates by 2.00 to map to original image.]';
  transcript.handle({
    type: "message_end",
    message: {
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: "one" },
        { type: "image", mimeType: "image/png", data: "two" },
      ],
    },
  });
  try {
    // Two-line and height-constrained one-line modes share presentation policy.
    app.status.update("a", working(transcript.sections), true);
    await app.render();
    expect(app.caption()).toBe("“Review both images”  [2 images] [2 files]");
    app.status.fitRows(1);
    await app.render();

    // One-line mode retains input and attachment totals instead of internal guidance.
    expect(app.text()).toContain("“Review both images”  [2 images] [2 files]");
    expect(app.captureCharFrame()).not.toContain("Image:");
    expect(app.captureCharFrame()).not.toContain("Multiply coordinates");
  } finally {
    await app.close();
  }
});

test("Image-only attachment sections show counts without treating filenames as work requests", async () => {
  const app = await mount();
  try {
    const attachment: TranscriptSection = {
      id: "attachment",
      kind: "notice",
      title: "read",
      text: "clipboard-1.png",
      status: "complete",
      image: { id: "a".repeat(64), name: "clipboard-1.png", mimeType: "image/png", byteLength: 80 },
      request: { text: "", images: 1, files: 0 },
    };
    app.status.update("a", working([attachment]), true);
    await app.render();

    expect(app.text()).toStartWith("Working");
    expect(app.caption()).toBe("[1 image]");
    expect(app.captureCharFrame()).not.toContain("clipboard-1.png");
    expect(app.caption()).not.toContain("“");
  } finally {
    await app.close();
  }
});

test("Repeated snapshots never restart minimum spinner time or invent normal completion text", async () => {
  const app = await mount();
  try {
    const state = working([user("Short job")]);
    app.status.update("a", state, true);
    await app.render();
    const first = app.captureCharFrame();
    app.clock.advance(80);
    await app.render();
    expect(app.captureCharFrame()).not.toBe(first);
    app.clock.advance(400);
    app.status.update("a", state, true);
    app.status.update("a", { ...state, status: "complete" }, true);
    await app.render();

    // The final answer can show its completion footer while the shared spinner finishes its minimum interval.
    expect(app.text()).toBe("");
    expect(app.spinner().visible).toBe(true);
    expect(app.status.hasContent).toBe(true);
    app.clock.advance(20);
    await app.render();
    expect(app.spinner().visible).toBe(false);
    expect(app.status.hasContent).toBe(false);
    app.clock.advance(1000);
    await app.render();
    expect(app.text()).toBe("");
  } finally {
    await app.close();
  }
});

test.each(["cancelled", "unfinished", "error"] as const)(
  "Spinner-free %s states align to the body origin without blank space",
  async (outcome) => {
    // Static outcomes have no loading indicator whose width needs reserving.
    const app = await mount();
    try {
      app.status.update(
        "a",
        { status: null, output: "", error: null, sections: [user("Task"), settled(outcome)] },
        true,
      );
      await app.render();

      expect(app.spinner().visible).toBe(false);
      expect(app.node().x).toBe(app.status.root.x);
      expect(app.node().width).toBe(app.status.root.width);
      if (outcome === "cancelled") expect(app.text()).toBe("Cancelled (1s) “Task”");
    } finally {
      await app.close();
    }
  },
);

test.each([false, true])(
  "Theme brightness %s keeps cancellation gray and unfinished/failure states in error colors",
  async (light) => {
    // Semantic palette roles must keep intentional cancellation neutral without changing time or request colors.
    const app = await mount(),
      theme = uiTheme(app.renderer);
    try {
      theme.configure({
        palette: [],
        defaultForeground: light ? "#202020" : "#ECECEC",
        defaultBackground: light ? "#FAFAF6" : "#141414",
        cursorColor: null,
        mouseForeground: null,
        mouseBackground: null,
        tekForeground: null,
        tekBackground: null,
        highlightForeground: null,
        highlightBackground: null,
      });

      // Render each terminal outcome independently of the aggregate session status.
      for (const [outcome, label, color] of [
        ["cancelled", "Cancelled", "muted"],
        ["unfinished", "Stopped", "error"],
        ["error", "Failed", "error"],
      ] as const) {
        app.status.update(
          "a",
          { status: null, output: "", error: null, sections: [user("Task"), settled(outcome)] },
          true,
        );
        await app.render();

        // Failed and unfinished work share error red; only cancellation and elapsed time use neutral gray.
        const spans = app.captureSpans().lines[app.node().y]!.spans;
        expect(spans.find((span) => span.text.includes(label))!.fg.toInts()).toEqual(
          theme.colors[color].toInts(),
        );
        if (outcome === "cancelled")
          expect(spans.find((span) => span.text.includes("(1s)"))!.fg.toInts()).toEqual(
            theme.colors.muted.toInts(),
          );
        expect(spans.find((span) => span.text.includes("Task"))!.fg.toInts()).toEqual(
          theme.colors.text.toInts(),
        );
        expect(app.node().x).toBe(app.status.root.x);
      }
    } finally {
      await app.close();
    }
  },
);

test("Fast cancellation removes spinner slots and spacing at tail completion while fixing cancellation time", async () => {
  const app = await mount();
  try {
    // The shared spinner keeps its minimum interval, independently of the settled result.
    app.status.update("a", working([user("Task")]), true);
    await app.render();
    expect(app.node().x).toBe(app.status.root.x + 2);
    app.clock.advance(100);
    app.status.update(
      "a",
      { status: null, output: "", error: null, sections: [user("Task"), settled("cancelled")] },
      true,
    );
    await app.render();
    expect(app.spinner().visible).toBe(true);
    expect(app.text()).toBe("Cancelled (1s) “Task”");

    app.clock.advance(400);
    await app.render();

    expect(app.spinner().visible).toBe(false);
    expect(app.node().x).toBe(app.status.root.x);
    app.clock.advance(5000);
    await app.render();
    expect(app.text()).toBe("Cancelled (1s) “Task”");
  } finally {
    await app.close();
  }
});

test("Cancellation, interruption, and failure differ from completion and never reuse old completion metadata", async () => {
  const app = await mount();
  try {
    for (const [outcome, label] of [
      ["cancelled", "Cancelled (1s)"],
      ["unfinished", "Stopped"],
      ["error", "Failed"],
      ["complete", ""],
    ] as const) {
      app.status.update(
        "a",
        { status: null, output: "", error: null, sections: [user("Task"), settled(outcome)] },
        true,
      );
      await app.render();
      expect(app.text()).toBe(label ? `${label} “Task”` : "");
      expect(app.spinner().visible).toBe(false);
    }
    app.status.update(
      "a",
      {
        status: null,
        output: "",
        error: null,
        sections: [user("Old"), settled("cancelled"), user("New", "new")],
      },
      true,
    );
    await app.render();
    expect(app.text()).toBe("");
    app.status.update(
      "a",
      {
        status: "failure",
        output: "",
        error: "AGENT_FAILED: fixture failure",
        sections: [user("Task"), settled("complete")],
      },
      true,
    );
    await app.render();
    expect(app.text()).toBe("Failed: AGENT_FAILED: fixture failure");
  } finally {
    await app.close();
  }
});

test("Korean, combining characters, and emoji truncate by grapheme and cell width while preserving source and following rows", async () => {
  const app = await mount(34);
  try {
    const request = user("A 👨‍👩‍👧‍👦 e\u0301 한글👩🏽‍💻 " + "Z".repeat(40));
    app.status.update("a", working([request]), true);
    await app.render();
    expect(app.caption()).toContain("👨‍👩‍👧‍👦");
    expect(app.caption()).toContain("e\u0301");
    expect(app.caption()).toStartWith("“");
    expect(app.caption()).toEndWith("…”");
    expect(app.caption()).not.toContain("\uFFFD");
    expect(Bun.stringWidth(app.caption())).toBeLessThanOrEqual(17);
    expect(app.captureCharFrame().split("\n")[2]!.trim()).toBe("");
    app.resize(6, 4);
    await app.render();
    expect(Bun.stringWidth(app.text())).toBeLessThanOrEqual(4);
    expect(Bun.stringWidth(app.caption())).toBeLessThanOrEqual(3);
    app.resize(70, 4);
    await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)");
    expect(app.caption()).toEndWith("…”");
    expect(Bun.stringWidth(app.caption())).toBeLessThanOrEqual(35);
    expect(request.text).toEndWith("Z".repeat(40));
  } finally {
    await app.close();
  }
});

test("Skill calls hide internal instructions and request-free runs never guess names", async () => {
  const app = await mount();
  try {
    app.status.update(
      "a",
      working([
        {
          id: "skill",
          kind: "notice",
          title: "write-good-code",
          skillName: "write-good-code",
          text: "PRIVATE INTERNAL INSTRUCTIONS",
          status: "complete",
        },
      ]),
      true,
    );
    await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)");
    expect(app.caption()).toBe("“/skill:write-good-code”");
    expect(app.captureCharFrame()).not.toContain("PRIVATE INTERNAL INSTRUCTIONS");
    app.status.update("a", { status: "working", output: "Legacy output", error: null }, true);
    await app.render();
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)");
    app.status.update("a", { status: null, output: "Legacy output", error: null }, true);
    await app.render();
    expect(app.text()).toBe("");
  } finally {
    await app.close();
  }
});

test.each([false, true])(
  "Conversations without terminal state leave neither Ready nor empty status rows in format %s",
  async (structured) => {
    // Retained transcript content is not evidence of active work or a terminal outcome.
    const app = await mount();
    try {
      const state: ExecutionState = {
        status: null,
        output: "Retained conversation",
        error: null,
        ...(structured ? { sections: [user("Previous request")] } : {}),
      };

      app.status.update("a", state, true);
      await app.render();

      expect(app.text()).toBe("");
      expect(app.status.hasContent).toBe(false);
      expect(app.spinner().visible).toBe(false);
      expect(app.captureCharFrame()).not.toContain("Ready");
      expect(state.output).toBe("Retained conversation");
    } finally {
      await app.close();
    }
  },
);

test("Elapsed time continues from runtime observations across snapshots, hiding, and reconnection", async () => {
  // A reattached UI has already missed twelve seconds of this runtime-owned run.
  const app = await mount();
  const state = {
    ...working([user("Long job")]),
    runTiming: { startedAt: 1000, elapsedMs: 12000 },
  };
  try {
    app.status.update("a", state, true);
    await app.render();
    expect(app.text()).toContain("Working (12s · <Esc> to interrupt)");

    // Equal snapshots must not restart the locally interpolated timer.
    app.clock.advance(2000);
    app.status.update("a", state, true);
    await app.render();
    expect(app.text()).toContain("Working (14s · <Esc> to interrupt)");
    app.status.update("a", state, false);
    app.clock.advance(2000);
    app.status.update("a", { ...state, runTiming: { startedAt: 1000, elapsedMs: 16000 } }, true);
    await app.render();

    expect(app.text()).toContain("Working (16s · <Esc> to interrupt)");
    app.status.update("a", { ...state, status: "complete" }, true);
    app.clock.advance(1000);
    await app.render();
    expect(app.text()).toBe("");
  } finally {
    await app.close();
  }
});

test("Hiding, replacing conversations, and disposal clean old spinners and ignore late updates", async () => {
  const app = await mount();
  try {
    const state = { ...working([user("Task")]), conversationId: "old" };
    app.status.update("a", state, true);
    await app.render();
    expect(app.spinner().visible).toBe(true);
    app.status.update("a", state, false);
    expect(app.spinner().visible).toBe(false);
    app.status.update("a", state, true);
    expect(app.spinner().visible).toBe(true);
    app.status.update(
      "a",
      { status: null, error: null, output: "", sections: [], conversationId: "new" },
      true,
    );
    await app.render();
    expect(app.text()).toBe("");
    expect(app.spinner().visible).toBe(false);
    expect(app.status.hasContent).toBe(false);
    app.status.update("a", state, true);
    app.status.root.destroyRecursively();
    app.clock.advance(5000);
    expect(() => app.status.update("a", state, true)).not.toThrow();
  } finally {
    await app.close();
  }
});

test.each([70, 28])(
  "Elapsed time stays gray at width %i while Working and request colors remain intact",
  async (width) => {
    // Both full interrupt hints and compact labels keep elapsed time visually secondary.
    const app = await mount(width),
      theme = uiTheme(app.renderer);
    try {
      app.status.update("a", working([user("Task")]), true);
      for (const [advance, elapsed] of [
        [36000, "36s"],
        [60000, "1m 36s"],
      ] as const) {
        app.clock.advance(advance);
        // Time ticks and terminal palette changes must not restore the timer's accent color.
        for (const light of [false, true]) {
          const palette: TerminalColors = {
            palette: [],
            defaultForeground: light ? "#202020" : "#ECECEC",
            defaultBackground: light ? "#FAFAF6" : "#141414",
            cursorColor: null,
            mouseForeground: null,
            mouseBackground: null,
            tekForeground: null,
            tekBackground: null,
            highlightForeground: null,
            highlightBackground: null,
          };
          theme.configure(palette);
          await app.render();

          const spans = app.captureSpans().lines[app.node().y]!.spans;
          expect(app.text()).toContain(`Working (${elapsed}`);
          expect(spans.find((span) => span.text.includes(elapsed))!.fg.toInts()).toEqual(
            theme.colors.muted.toInts(),
          );
          expect(spans.find((span) => span.text.includes("Working"))!.fg.toInts()).toEqual(
            theme.colors.accent.toInts(),
          );
          const caption = app.captureSpans().lines[app.captionNode().y]!.spans;
          expect(caption.find((span) => span.text.includes("Task"))!.fg.toInts()).toEqual(
            theme.colors.muted.toInts(),
          );
        }
      }
    } finally {
      await app.close();
    }
  },
);

test("Only Fast shows yellow arrows and Working shimmer; time and requests stay static", async () => {
  // Fast is observed telemetry, never inferred from the model name or a user's draft.
  const app = await mount();
  const state = {
    ...working([user("Keep this request")]),
    telemetry: {
      provider: "openai-codex",
      model: "fixture",
      effort: "high",
      fast: true,
      context: null,
      weekly: null,
    },
  };
  const colorAt = (offset: number) => {
    let column = 0;
    return app
      .captureSpans()
      .lines[app.node().y]!.spans.find((span) => {
        column += span.width;
        return column > app.node().x + offset;
      })!
      .fg.toInts();
  };
  try {
    app.status.update("a", state, true);
    await app.render();
    const base = uiTheme(app.renderer).colors.number.toInts(),
      geometry = [app.node().x, app.node().y, app.captionNode().x, app.status.root.height];
    const caption = app.caption();
    expect(app.node().x).toBe(app.status.root.x + 4);
    expect(app.captionNode().x).toBe(app.spinner().x);
    expect(app.captureCharFrame()).toContain("▶▷▷ Working");
    expect(colorAt(0)).toEqual(base);

    // Only the word Working is swept; elapsed time, interrupt hint and request remain fixed.
    app.clock.advance(100);
    await app.render();
    const first = colorAt(0);

    expect(first).not.toEqual(base);
    expect(colorAt(3)).toEqual(base);
    app.clock.advance(350);
    await app.render();
    expect(colorAt(0)).toEqual(base);
    expect(colorAt(3)).not.toEqual(base);
    expect(app.caption()).toBe(caption);
    expect(app.text()).toBe("Working (0s · <Esc> to interrupt)");
    expect([app.node().x, app.node().y, app.captionNode().x, app.status.root.height]).toEqual(
      geometry,
    );
    app.clock.advance(1150);
    await app.render();
    expect(colorAt(0)).toEqual(first);
    const timers = app.clock.pendingTimerCount;
    app.status.update("a", { ...state, telemetry: { ...state.telemetry, fast: false } }, true);
    await app.render();
    expect(app.clock.pendingTimerCount).toBe(timers - 1);
    expect(colorAt(0)).toEqual(uiTheme(app.renderer).colors.accent.toInts());
    expect(app.spinner().width).toBe(1);
    expect(app.captionNode().x).toBe(app.spinner().x);
    app.clock.advance(450);
    await app.render();
    expect(colorAt(0)).toEqual(uiTheme(app.renderer).colors.accent.toInts());
    app.status.update("a", state, false);
    await app.render();
    expect(app.clock.pendingTimerCount).toBe(0);
  } finally {
    await app.close();
  }
});

test("Working collapses to one line when height is constrained and restores the summary below when space returns", async () => {
  // Layout policy may reclaim the caption row, but must not lose the original request.
  const app = await mount();
  try {
    app.status.update("a", working([user("Retained request")]), true);
    await app.render();
    expect(app.status.rows).toBe(2);
    expect(app.caption()).toBe("“Retained request”");

    app.status.fitRows(1);
    await app.render();

    expect(app.status.rows).toBe(1);
    expect(app.caption()).toBe("");
    expect(app.text()).toContain("Retained request");
    app.status.fitRows(2);
    await app.render();
    expect(app.status.rows).toBe(2);
    expect(app.caption()).toBe("“Retained request”");
    expect(app.text()).not.toContain("Retained request");
  } finally {
    await app.close();
  }
});

test("Hiding Fast screens, switching sessions, and disposal clean shimmer and spinner timers", async () => {
  // Per-session animation must not survive its owning screen or leak into a different session.
  const app = await mount();
  const state = {
    ...working([user("Fast request")]),
    telemetry: {
      provider: "fixture",
      model: "fixture",
      effort: "high",
      fast: true,
      context: null,
      weekly: null,
    },
  };
  try {
    app.status.update("a", state, true);
    await app.render();
    const timers = app.clock.pendingTimerCount;
    app.clock.advance(120);
    app.status.update("a", state, true);
    expect(app.clock.pendingTimerCount).toBe(timers);

    app.status.update("a", state, false);
    expect(app.clock.pendingTimerCount).toBe(0);

    app.status.update("a", state, true);
    await app.render();
    app.status.update("b", { status: null, error: null, output: "" }, true);
    await app.render();
    expect(app.clock.pendingTimerCount).toBe(0);
    expect(app.captureCharFrame()).not.toContain("▶");
    app.status.update("a", state, true);
    app.status.root.destroyRecursively();
    await app.render();
    expect(app.clock.pendingTimerCount).toBe(0);
    expect(() => app.clock.advance(5000)).not.toThrow();
  } finally {
    await app.close();
  }
});

test("Theme switching updates working and failure colors without fixed product colors", async () => {
  const app = await mount();
  try {
    for (const light of [false, true]) {
      const palette: TerminalColors = {
        palette: [],
        defaultForeground: light ? "#202020" : "#ECECEC",
        defaultBackground: light ? "#FAFAF6" : "#141414",
        cursorColor: null,
        mouseForeground: null,
        mouseBackground: null,
        tekForeground: null,
        tekBackground: null,
        highlightForeground: null,
        highlightBackground: null,
      };
      const theme = uiTheme(app.renderer);
      theme.configure(palette);
      app.status.update("a", working([user("Theme request")]), true);
      await app.render();
      const spans = () => app.captureSpans().lines[0]!.spans;
      expect(
        spans()
          .find((span) => span.text.includes("Working"))!
          .fg.toInts(),
      ).toEqual(theme.colors.accent.toInts());
      expect(
        app
          .captureSpans()
          .lines[app.captionNode().y]!.spans.find((span) => span.text.includes("Theme request"))!
          .fg.toInts(),
      ).toEqual(theme.colors.muted.toInts());
      app.status.update("a", { status: "failure", error: "Fixture failure", output: "" }, true);
      await app.render();
      expect(
        spans()
          .find((span) => span.text.includes("Failed"))!
          .fg.toInts(),
      ).toEqual(theme.colors.error.toInts());
    }
  } finally {
    await app.close();
  }
});
