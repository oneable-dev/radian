import { pressLeader } from "../../testing/keys.ts";
import { expect, spyOn, test } from "bun:test";
import type { TerminalColors, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import type { SessionTelemetry } from "../telemetry.ts";
import type { SessionExtensionUi } from "../extension-ui.ts";
import type { ProviderUsage } from "../../usage/model.ts";
import { uiTheme } from "../../ui/theme.ts";
import { icons, spinnerFrames } from "../../icons.ts";
import { SessionStatus } from "./session-status.ts";

const unavailable = (): ProviderUsage => ({
  provider: "openai",
  status: "unavailable",
  windows: [],
  updatedAt: null,
  errorCode: null,
});
const sample = (): SessionTelemetry => ({
  provider: "openai-codex",
  model: "gpt-5.5",
  effort: "high",
  fast: true,
  context: { usedTokens: 72000, maxTokens: 200000 },
  weekly: null,
  usage: {
    provider: "openai",
    status: "ready",
    windows: [
      { id: "period", usedPercent: 18, periodMs: 604800000, resetsAt: Date.now() + 3600000 },
    ],
    updatedAt: Date.now(),
    errorCode: null,
  },
});

async function mount(telemetry: SessionTelemetry = sample(), clock?: ManualClock, settled = false) {
  const app = await createTestRenderer({
    width: 140,
    height: 24,
    kittyKeyboard: true,
    ...(clock ? { clock } : {}),
  });
  const snapshot = demoWorkspace();
  const selection = new WorkspaceSelection(
    settled
      ? snapshot.map((repo) => ({
          ...repo,
          worktrees: repo.worktrees.map((tree) => ({
            ...tree,
            sessions: tree.sessions.map((session) => ({ ...session, subagents: [] })),
          })),
        }))
      : snapshot,
  );
  const states: Record<string, SessionTelemetry | undefined> = { a1: telemetry };
  let extensions: SessionExtensionUi[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    onPrompt: () => ok(undefined),
    getExtensionUi: () => extensions,
    getSessionDetails: (id) => ({
      conversationId: `conversation-${id}`,
      status: "complete",
      output: "Transcript",
      error: null,
      ...(states[id] ? { telemetry: states[id] } : {}),
    }),
  });

  await app.renderOnce();

  const root = app.renderer.root.findDescendantById("session-status")!;
  const row = root.getChildren()[0]!;

  return {
    ...app,
    view,
    selection,
    root,
    row,
    line: () => app.captureCharFrame().split("\n")[row.y]!,
    async set(value: SessionTelemetry) {
      states[selection.sessionId!] = value;
      selection.replaceSnapshot(selection.snapshot);
      await app.renderOnce();
    },
    async setExtensions(value: SessionExtensionUi[]) {
      extensions = value;
      selection.replaceSnapshot(selection.snapshot);
      await app.renderOnce();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

const palette = (light: boolean): TerminalColors => ({
  palette: [
    "#000000",
    "#CC2222",
    "#228822",
    "#998800",
    "#2255AA",
    "#AA22AA",
    light ? "#996633" : "#117799",
    "#DDDDDD",
  ],
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

test("Status below prompts has one-row outer spacing and separates context from usage", async () => {
  // The session has 64% context remaining, while its account has used 18% of the selected allowance.
  const app = await mount();
  try {
    pressLeader(app, "a");
    await app.mockInput.typeText("keep this draft");
    await app.renderOnce();

    const prompt = app.renderer.root.findDescendantById("session-prompt")!;
    const composer = app.renderer.root.findDescendantById("agent-composer")!;

    // The telemetry has its own one-row gutters, separate from the prompt's internal padding.
    expect(app.root.y).toBe(composer.y + composer.height);
    expect(app.root.height).toBe(3);
    expect(app.row.y - app.root.y).toBe(1);
    expect(app.root.y + app.root.height - app.row.y - app.row.height).toBe(1);

    const frame = app.captureCharFrame().split("\n");
    for (const y of [app.row.y - 1, app.row.y + 1]) {
      expect(frame[y]!.slice(app.root.x, app.root.x + app.root.width).trim()).toBe("");
    }

    const panel = app.renderer.root.findDescendantById("agent-view")!;
    expect(composer.x).toBe(panel.x);
    expect(composer.width).toBe(panel.width);
    expect(prompt.x).toBe(app.root.x);
    expect(prompt.x + prompt.width).toBe(app.root.x + app.root.width);
    expect(app.line()).toContain(
      `${icons.model} gpt-5.5 · ${icons.brain} high · ${icons.bolt} fast on`,
    );
    expect(app.line()).toContain(icons.context);
    expect(app.line()).toContain("64% left");
    expect(app.line()).toContain("chatgpt");
    expect(app.line()).not.toContain("ChatGPT");
    expect(app.line()).toMatch(/context ▉{8} 64%/);
    expect(app.line()).toContain(icons.openai);
    expect(app.line()).toContain("18% used 1h 0m");

    const usageText = app.line().slice(app.line().indexOf(icons.openai));
    expect(usageText).not.toContain("·");
    expect(usageText).not.toContain("━");
    expect(usageText).toMatch(/▉{8} 18% used 1h 0m/);
    expect(app.renderer.root.findDescendantById("usage-provider-icon")?.width).toBe(2);
    expect(app.line()).not.toContain("82%");
    expect(app.line()).not.toContain("weekly");
    expect(app.line()).not.toContain("⟳");

    // Passive status text never steals focus or submits a draft.
    await app.mockMouse.click(app.row.x + 2, app.row.y);
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.view.promptDrafts.a1).toBe("keep this draft");

    const icon = app.renderer.root.findDescendantById("usage-provider-icon")!;
    await app.mockMouse.click(icon.x, icon.y);
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.view.promptDrafts.a1).toBe("keep this draft");
  } finally {
    await app.close();
  }
});

test("MCP follows Fast with a Nerd Font plug and colored issues without duplicating footer status", async () => {
  // A legacy adapter status remains readable until a structured snapshot becomes available.
  const app = await mount();
  app.resize(220, 24);

  const extension: SessionExtensionUi = {
    sessionId: "a1",
    conversationId: "conversation-a1",
    notifications: [],
    statuses: { mcp: "Legacy MCP footer", fixture: "Other extension" },
  };
  const footer = () => app.captureCharFrame().split("\n")[app.renderer.height - 1]!;
  const span = (text: string) =>
    app.captureSpans().lines[app.row.y]!.spans.find((value) => value.text.includes(text))!;
  try {
    await app.setExtensions([extension]);
    expect(footer()).toContain("Legacy MCP footer");
    expect(app.line()).not.toContain("mcp");
    pressLeader(app, "a");
    await app.mockInput.typeText("keep MCP draft");

    // The runtime summary replaces only the MCP footer entry, never unrelated extension status.
    await app.setExtensions([{ ...extension, mcp: { servers: 8, needsAuth: 1, errors: 1 } }]);

    expect(app.line()).toContain(
      `${icons.bolt} fast on · ${icons.mcp} mcp 8 (1 needs auth · 1 error)`,
    );
    expect(icons.mcp).toBe("\uF1E6");
    expect(app.line()).not.toContain("🔌");
    expect(footer()).not.toContain("Legacy MCP footer");
    expect(footer()).not.toContain("mcp 8");
    expect(footer()).toContain("Other extension");
    for (const light of [false, true]) {
      app.renderer.emit("palette", palette(light));
      await app.renderOnce();

      const colors = uiTheme(app.renderer).colors;
      expect(span("mcp 8").fg.toInts()).toEqual(colors.muted.toInts());
      expect(span("1 needs auth").fg.toInts()).toEqual(colors.warning.toInts());
      expect(span("1 error").fg.toInts()).toEqual(colors.error.toInts());
    }

    const column = Bun.stringWidth(app.line().slice(0, app.line().indexOf(icons.mcp)));
    await app.mockMouse.click(column, app.row.y);
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
    expect(app.view.promptDrafts.a1).toBe("keep MCP draft");
  } finally {
    await app.close();
  }
});

test.each([
  { mcp: { servers: 8, needsAuth: 0, errors: 0 }, expected: "mcp 8" },
  { mcp: { servers: 8, needsAuth: 1, errors: 0 }, expected: "mcp 8 (1 needs auth)" },
  { mcp: { servers: 8, needsAuth: 0, errors: 1 }, expected: "mcp 8 (1 error)" },
  { mcp: { servers: 8, needsAuth: 2, errors: 2 }, expected: "mcp 8 (2 need auth · 2 errors)" },
  { mcp: { servers: 0, needsAuth: 0, errors: 0 }, expected: "" },
])("MCP shows only nonzero issue counts: $expected", async ({ mcp, expected }) => {
  // Zero issues do not need parentheses, and a session with no enabled servers needs no indicator.
  const app = await mount();
  app.resize(220, 24);
  try {
    await app.setExtensions([
      {
        sessionId: "a1",
        conversationId: "conversation-a1",
        notifications: [],
        statuses: {},
        mcp,
      },
    ]);

    if (expected) {
      expect(app.line()).toContain(`${icons.mcp} ${expected}`);
      if (!mcp.needsAuth && !mcp.errors) {
        expect(app.line()).not.toContain("(");
      }
    } else {
      expect(app.line()).not.toContain(icons.mcp);
    }

    expect(app.line()).not.toContain("0 needs auth");
    expect(app.line()).not.toContain("0 errors");
  } finally {
    await app.close();
  }
});

test("MCP follows the selected conversation without leaking another session or stale runtime", async () => {
  // Each session publishes its own summary; an old conversation must not overwrite its replacement.
  const app = await mount();
  app.resize(220, 24);

  const extensions: SessionExtensionUi[] = [
    {
      sessionId: "a1",
      conversationId: "conversation-a1",
      notifications: [],
      statuses: {},
      mcp: { servers: 8, needsAuth: 1, errors: 0 },
    },
    {
      sessionId: "a2",
      conversationId: "conversation-a2",
      notifications: [],
      statuses: {},
      mcp: { servers: 3, needsAuth: 0, errors: 2 },
    },
  ];
  try {
    await app.setExtensions(extensions);
    expect(app.line()).toContain("mcp 8 (1 needs auth)");

    app.selection.selectSession("demo:main", "a2");
    await app.renderOnce();

    expect(app.line()).toContain("mcp 3 (2 errors)");
    expect(app.line()).not.toContain("mcp 8");
    await app.setExtensions([{ ...extensions[1]!, conversationId: "old-conversation" }]);
    expect(app.line()).not.toContain(icons.mcp);
    await app.setExtensions([]);
    expect(app.line()).not.toContain(icons.mcp);
  } finally {
    await app.close();
  }
});

test("Narrow layouts drop MCP before model settings and resource ratios and restore it on expansion", async () => {
  // Optional runtime metadata must not displace the selected model, Fast or known percentages.
  const app = await mount();
  app.resize(220, 24);
  try {
    await app.setExtensions([
      {
        sessionId: "a1",
        conversationId: "conversation-a1",
        notifications: [],
        statuses: {},
        mcp: { servers: 8, needsAuth: 1, errors: 1 },
      },
    ]);
    pressLeader(app, "a");
    await app.mockInput.typeText("resize MCP draft");

    app.resize(90, 24);
    await app.renderOnce();

    expect(app.line()).not.toContain(icons.mcp);
    expect(app.line()).toContain("gpt-5.5");
    expect(app.line()).toContain("fast on");
    expect(app.line()).toContain("64% left");
    expect(app.line()).toContain("18% used");
    app.resize(220, 24);
    await app.renderOnce();
    expect(app.line()).toContain(`${icons.mcp} mcp 8 (1 needs auth · 1 error)`);
    expect(app.view.promptDrafts.a1).toBe("resize MCP draft");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
  } finally {
    await app.close();
  }
});

test("Worktree and branch move to the footer without duplicating session telemetry", async () => {
  // Workspace identity belongs to the workbench, not the Agent-only model row.
  const app = await mount();
  try {
    for (const light of [false, true]) {
      app.renderer.emit("palette", palette(light));
      await app.renderOnce();

      const footer = app.captureCharFrame().split("\n")[app.renderer.height - 1]!;
      expect(footer).toContain(`${icons.folder} radian`);
      expect(footer).toContain(`${icons.branch} main`);
      expect(app.line()).not.toContain(icons.folder);
      expect(app.line()).not.toContain(icons.branch);
      expect(app.line()).toContain("gpt-5.5");
      expect(app.line()).toContain("64%");
    }
  } finally {
    await app.close();
  }
});

test("Narrow status rows preserve usage ratios without reserving workspace metadata", async () => {
  // Removing the duplicated scope returns its width to known resource percentages.
  const app = await createTestRenderer({ width: 60, height: 5 });
  const status = new SessionStatus(app.renderer);

  app.renderer.root.add(status.root);
  status.update(sample(), true);
  try {
    for (const width of [60, 50, 40, 30, 60]) {
      app.resize(width, 5);
      await app.renderOnce();

      expect(status.root.findDescendantById("session-worktree-context")).toBeUndefined();

      const line = app.captureCharFrame().split("\n")[status.root.y + 1]!;
      expect(line).toContain("64%");
      expect(line).toContain("18% used");
    }
  } finally {
    status.dispose();
    await app.dispose();
  }
});

test("Input backgrounds fill panels while input aligns with run-status and model-row padding", async () => {
  // The surface reaches the pane edges; its editable content keeps the shared responsive inset.
  const app = await mount({
    ...sample(),
    model: "gpt-6.1-sol",
    effort: "xhigh",
    fast: null,
    context: { usedTokens: 6000, maxTokens: 200000 },
    usage: unavailable(),
  });
  try {
    // Width changes adapt text insets; height changes keep the same vertical treatment.
    for (const [width, height, inset, gap] of [
      [120, 24, 2, 1],
      [79, 18, 1, 1],
      [80, 18, 2, 1],
      [60, 12, 1, 1],
      [120, 24, 2, 1],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();

      const run = app.renderer.root.findDescendantById("agent-run-status")!;
      const composer = app.renderer.root.findDescendantById("agent-composer")!;
      const prompt = app.renderer.root.findDescendantById("session-prompt")!;
      const panel = app.renderer.root.findDescendantById("agent-view")!;
      const statusColumn = run.x;

      // Only the background expands; the mode line, telemetry and editable text stay aligned.
      expect(composer.x).toBe(panel.x);
      expect(composer.width).toBe(panel.width);
      expect(prompt.x - composer.x).toBe(inset);
      expect(composer.x + composer.width - prompt.x - prompt.width).toBe(inset);
      expect(statusColumn).toBe(prompt.x);
      expect(app.root.x).toBe(prompt.x);
      expect(app.root.x + app.root.width).toBe(prompt.x + prompt.width);
      expect(composer.y - run.y - run.height).toBe(gap);
      expect(app.row.y - composer.y - composer.height).toBe(1);
      expect(app.root.y + app.root.height - app.row.y - app.row.height).toBe(1);
    }
  } finally {
    await app.close();
  }
});

test("Empty inputs show only placeholders and preserve inner backgrounds across focus and theme changes", async () => {
  // Placeholder and native caret identify the input without a border or second background stripe.
  const app = await mount();
  const composer = app.renderer.root.findDescendantById("agent-composer")!;
  const prompt = app.renderer.root.findDescendantById("session-prompt")!;
  const verifyBackground = () => {
    const frame = app.captureSpans();
    const surface = uiTheme(app.renderer).colors.surface.toInts();
    for (let y = composer.y; y < composer.y + composer.height; y++) {
      let column = 0;
      for (const span of frame.lines[y]!.spans) {
        if (column < composer.x + composer.width && column + span.width > composer.x) {
          expect(span.bg.toInts()).toEqual(surface);
        }

        column += span.width;
      }
    }
  };
  try {
    // Empty, focused and unfocused states must look consistent in both terminal palettes.
    for (const light of [false, true]) {
      app.renderer.emit("palette", palette(light));
      for (const focused of [false, true]) {
        if (focused) {
          prompt.focus();
        } else {
          prompt.blur();
        }

        await app.renderOnce();

        expect(
          app
            .captureCharFrame()
            .split("\n")
            [prompt.y]!.slice(composer.x + 1, composer.x + composer.width)
            .trim(),
        ).toBe("Ask to do anything");
        verifyBackground();
      }
    }

    await app.mockInput.typeText("aligned draft");
    await app.renderOnce();

    // Removing the decoration must not change focus, draft editing or text alignment.
    expect(app.captureCharFrame().split("\n")[prompt.y]!.indexOf("aligned draft")).toBe(app.root.x);
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);
    expect(app.view.promptDrafts.a1).toBe("aligned draft");
    verifyBackground();
  } finally {
    await app.close();
  }
});

test("Filled bars use theme accent gradients while retaining context and usage directions", async () => {
  const data = sample();
  const app = await mount({
    ...data,
    context: { usedTokens: 0, maxTokens: 200000 },
    usage: { ...data.usage!, windows: [{ ...data.usage!.windows[0]!, usedPercent: 100 }] },
  });
  const spanAt = (column: number) => {
    let x = 0;

    return app.captureSpans().lines[app.row.y]!.spans.find((span) => {
      x += span.width;

      return x > column;
    })!;
  };
  const verify = () => {
    const line = app.line();
    const start = Bun.stringWidth(line.slice(0, line.indexOf("context"))) + "context ".length;
    const first = spanAt(start);
    const last = spanAt(start + 7);

    expect(first.fg.toInts()).toEqual(uiTheme(app.renderer).colors.accent.toInts());
    expect(last.fg.equals(first.fg)).toBe(false);
    expect(first.bg.equals(uiTheme(app.renderer).colors.panel)).toBe(true);
    expect(app.line()).toContain("context ▉▉▉▉▉▉▉▉ 100%");
    expect(app.line()).toContain("▉▉▉▉▉▉▉▉ 100% used");

    return first.fg.toInts();
  };
  try {
    app.resize(140, 24);
    app.renderer.emit("palette", palette(false));
    await app.renderOnce();

    const dark = verify();

    app.renderer.emit("palette", palette(true));
    await app.renderOnce();

    expect(verify()).not.toEqual(dark);
  } finally {
    await app.close();
  }
});

test("77% and 53% bars retain bold segment shapes with cell-level fill colors", async () => {
  // Eight segments approximate the fill; the labels must retain the exact percentages.
  const data = sample();
  const app = await mount({
    ...data,
    context: { usedTokens: 46000, maxTokens: 200000 },
    usage: { ...data.usage!, windows: [{ ...data.usage!.windows[0]!, usedPercent: 53 }] },
  });
  const spanAt = (column: number) => {
    let x = 0;

    return app.captureSpans().lines[app.row.y]!.spans.find((span) => {
      x += span.width;

      return x > column;
    })!;
  };
  try {
    for (const light of [false, true]) {
      // Switching palettes must preserve thick segments without adding a continuous background track.
      app.renderer.emit("palette", palette(light));
      await app.renderOnce();

      // Six context segments and four usage segments are active; empty cells keep the same glyph.
      const line = app.line();
      const panel = uiTheme(app.renderer).colors.panel;

      expect(line).toContain("context ▉▉▉▉▉▉▉▉ 77% left");
      expect(line).toContain("chatgpt ▉▉▉▉▉▉▉▉ 53% used");
      for (const [label, filled] of [
        ["context ", 6],
        ["chatgpt ", 4],
      ] as const) {
        const start = Bun.stringWidth(line.slice(0, line.indexOf(label) + label.length));
        const empty = spanAt(start + 7).fg;

        expect(empty.equals(panel)).toBe(false);
        for (let cell = 0; cell < 8; cell++) {
          const span = spanAt(start + cell);
          expect(span.bg.toInts()).toEqual(panel.toInts());
          expect(span.fg.equals(empty)).toBe(cell >= filled);
        }
      }
    }
  } finally {
    await app.close();
  }
});

test("Context matches used-text colors while model, effort, and Fast follow theme roles and state", async () => {
  const app = await mount();
  const span = (text: string) =>
    app.captureSpans().lines[app.row.y]!.spans.find((value) => value.text.includes(text))!;
  const verify = (enabled: boolean) => {
    const colors = uiTheme(app.renderer).colors;
    expect(span("context").fg.toInts()).toEqual(span("18% used").fg.toInts());
    expect(span("context").fg.toInts()).toEqual(colors.text.toInts());
    expect(span("gpt-5.5").fg.toInts()).toEqual(colors.success.toInts());
    expect(span("high").fg.toInts()).toEqual(colors.keyword.toInts());
    expect(span(`fast ${enabled ? "on" : "off"}`).fg.toInts()).toEqual(
      (enabled ? colors.number : colors.muted).toInts(),
    );
  };
  try {
    // A known palette makes each role distinguishable from a hardcoded color or blanket muted style.
    app.renderer.emit("palette", palette(false));
    await app.renderOnce();
    verify(true);

    await app.set({ ...sample(), fast: false });
    verify(false);
    app.renderer.emit("palette", {
      ...palette(true),
      palette: [
        "#000000",
        "#CC2222",
        "#447711",
        "#BB7700",
        "#6655AA",
        "#773399",
        "#996633",
        "#DDDDDD",
      ],
    });
    await app.renderOnce();

    verify(false);
    expect(app.line()).toContain(
      `${icons.model} gpt-5.5 · ${icons.brain} high · ${icons.bolt} fast off`,
    );
  } finally {
    await app.close();
  }
});

test("Narrow layouts compact bars, settings, and time while preserving ratios and drafts for restoration", async () => {
  const app = await mount();
  try {
    pressLeader(app, "a");
    await app.mockInput.typeText("resize draft");
    for (const [width, height, gap] of [
      [100, 20, 1],
      [60, 12, 1],
      [140, 24, 1],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();

      expect(app.line()).toContain("context");
      expect(app.line()).toContain("64%");
      expect(app.line()).toContain("18% used");
      expect(app.line()).toContain(icons.openai);
      expect(Bun.stringWidth(app.line())).toBeLessThanOrEqual(width);

      const prompt = app.renderer.root.findDescendantById("session-prompt")!;
      const composer = app.renderer.root.findDescendantById("agent-composer")!;
      const footer = app.renderer.root.findDescendantById("footer-bar")!;
      const run = app.renderer.root.findDescendantById("agent-run-status")!;

      expect(composer.y - run.y - run.height).toBe(gap);
      expect(app.row.y - composer.y - composer.height).toBe(1);
      expect(app.root.y + app.root.height).toBeLessThanOrEqual(footer.y);
      expect(app.root.x).toBe(prompt.x);
      expect(app.root.x + app.root.width).toBe(prompt.x + prompt.width);
      expect(composer.y + composer.height).toBeLessThanOrEqual(footer.y);
      expect(app.renderer.currentFocusedRenderable).toBe(prompt);
      expect(app.view.promptDrafts.a1).toBe("resize draft");
    }

    expect(app.line()).toContain("fast on");
    expect(app.line()).toContain("▉▉▉▉▉▉▉▉");
    expect(app.line()).toContain("1h 0m");
  } finally {
    await app.close();
  }
});

test("Full and abbreviated fast labels remain lowercase in every state", async () => {
  const app = await mount();
  try {
    expect(app.line()).toContain("fast on");
    expect(app.line()).not.toContain("Fast");

    // A compact identity keeps the robot, brain and bolt while dropping verbose labels.
    app.resize(56, 24);
    await app.renderOnce();

    const compact = `${icons.model} gpt-5.5 ${icons.brain} high ${icons.bolt}`;
    expect(app.line()).toContain(`${compact} on`);
    await app.set({ ...sample(), fast: false });
    expect(app.line()).toContain(`${compact} off`);
    await app.set({ ...sample(), fast: null });
    expect(app.line()).toContain(`${compact} —`);
    expect(app.line()).not.toContain("Fast");
  } finally {
    await app.close();
  }
});

test("Idle Fast indicators stay static and inputs add neither animation nor borders", async () => {
  // Fast is session configuration; it must not animate the idle composer or passive metadata.
  const clock = new ManualClock();
  const app = await mount(sample(), clock, true);
  try {
    const before = app.captureSpans().lines[app.row.y];
    const baseline = clock.pendingTimerCount;

    clock.advance(450);
    await app.renderOnce();

    expect(app.captureSpans().lines[app.row.y]).toEqual(before);
    expect(clock.pendingTimerCount).toBe(baseline);

    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const frame = app.captureCharFrame().split("\n");
    for (const y of [composer.y, composer.y + composer.height - 1]) {
      expect(frame[y]!.trim()).toBe("");
    }

    expect(app.line()).toContain("fast on");
    await app.set({ ...sample(), fast: false });
    expect(app.line()).toContain("fast off");
    await app.set({ ...sample(), fast: null });
    expect(app.line()).toContain("fast —");
    expect(clock.pendingTimerCount).toBe(baseline);
  } finally {
    await app.close();
  }
});

test("Unknown context and unsupported usage show dashes without bars or cross-session leakage", async () => {
  const app = await mount();
  try {
    await app.set({
      ...sample(),
      fast: null,
      context: { usedTokens: null, maxTokens: 200000 },
      usage: unavailable(),
    });

    expect(app.line()).toContain("fast —");
    expect(app.line()).toContain("context -");
    expect(app.line().slice(app.line().indexOf(icons.openai)).trim().replace(/\s+/g, " ")).toBe(
      `${icons.openai} chatgpt -`,
    );
    expect(app.line()).not.toContain("▉");
    expect(app.line()).not.toContain("0%");
    app.selection.selectSession("demo:main", "a2");
    await app.renderOnce();
    expect(app.line()).not.toContain("gpt-5.5");
    expect(app.line()).not.toContain("18% used");
  } finally {
    await app.close();
  }
});

test("Estimated post-compaction context shows remaining percentage against the current model limit without extra markers", async () => {
  // Accept estimates when usage is unknown, but calculate remaining capacity from the actual model limit.
  const app = await mount();
  try {
    // Estimated 40,000 tokens against an 872,000-token model rounds to 95% remaining.
    await app.set({ ...sample(), context: { usedTokens: 40000, maxTokens: 872000 } });

    // Preserve existing bar/percentage format without tildes or unknown-value dashes.
    expect(app.line()).toMatch(/context ▉{8} 95%/);
    expect(app.line()).not.toContain("~");
    expect(app.line()).not.toContain("context -");
  } finally {
    await app.close();
  }
});

test("Unsupported usage retains context bars without fabricating usage bars or times", async () => {
  // Providers without usage support must not spin recovery indicators indefinitely.
  const app = await mount();
  try {
    await app.set({ ...sample(), usage: unavailable() });

    // Unlike retry errors, unsupported states retain static unknown indicators.
    expect(app.line()).toMatch(/context ▉+ 64% left/);
    expect(app.line().slice(app.line().indexOf(icons.openai)).trim().replace(/\s+/g, " ")).toBe(
      `${icons.openai} chatgpt -`,
    );
  } finally {
    await app.close();
  }
});

test("Usage recovery shows only gray last-fill bars and spinners until fresh success", async () => {
  // Start with usage failure after the session's last successful value of 18%.
  const clock = new ManualClock();
  const data = sample();
  const app = await mount(data, clock, true);
  const spinner = () => app.renderer.root.findDescendantById("usage-loading") as TextRenderable;
  const spanAt = (column: number) => {
    let x = 0;

    return app.captureSpans().lines[app.row.y]!.spans.find((span) => {
      x += span.width;

      return x > column;
    })!;
  };
  try {
    pressLeader(app, "a");
    await app.mockInput.typeText("keep recovery draft");
    for (const light of [false, true]) {
      // Backoff snapshots and theme changes never reset spinners or last-fill bars.
      await app.set({
        ...data,
        usage: { ...data.usage!, status: "error", errorCode: "USAGE_TIMEOUT" },
      });
      app.renderer.emit("palette", palette(light));
      await app.renderOnce();

      const usage = app.line().slice(app.line().indexOf(icons.openai));
      const start = Bun.stringWidth(
        app.line().slice(0, app.line().indexOf("chatgpt ") + "chatgpt ".length),
      );
      const styles = uiTheme(app.renderer).styles;

      // Retain fill but hide numbers, units, and countdowns; context keeps its normal color.
      expect(usage).toContain("▉▉▉▉▉▉▉▉");
      expect(usage).not.toMatch(/18%|used|1h|-/);
      expect(spanAt(start).fg.toInts()).toEqual(styles["ui.muted"].fg.toInts());
      expect(spanAt(start + 7).fg.equals(spanAt(start).fg)).toBe(false);
      expect(spinner().visible).toBe(true);
      expect(spinnerFrames.some((frame) => frame === spinner().plainText)).toBe(true);
      expect(spanAt(spinner().x).fg.toInts()).toEqual(styles["ui.muted"].fg.toInts());
      expect(app.line()).toContain("64% left");

      const before = spinner().plainText;
      clock.advance(80);
      await app.renderOnce();
      expect(spinner().plainText).not.toBe(before);
    }

    clock.advance(60000);
    await app.renderOnce();
    expect(spinner().visible).toBe(true);
    await app.set({
      ...data,
      usage: { ...data.usage!, windows: [{ ...data.usage!.windows[0]!, usedPercent: 42 }] },
    });

    // Recovery displays fresh values immediately without touching drafts or focus.
    expect(app.line()).toContain("42% used");
    expect(spinner().visible).toBe(false);
    expect(app.view.promptDrafts.a1).toBe("keep recovery draft");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
  } finally {
    await app.close();
  }
});

test("Initial usage requests and failed waits show spinners without previous values or delayed success", async () => {
  // New apps have no historical usage; never invent percentages or fills.
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 100, height: 5, clock });
  const status = new SessionStatus(app.renderer);

  app.renderer.root.add(status.root);

  const data = sample();
  const spinner = () => status.root.findDescendantById("usage-loading") as TextRenderable;
  try {
    for (const state of ["loading", "error"] as const) {
      status.update({ ...data, usage: { ...unavailable(), status: state } }, true);
      await app.renderOnce();

      // Initial failures also retry and retain spinners, unlike unsupported states.
      const line = app.captureCharFrame().split("\n")[spinner().y]!;
      expect(spinner().visible).toBe(true);
      expect(line.slice(line.indexOf(icons.openai))).not.toMatch(/▉|%|used|-/);
    }

    status.update(data, true);
    await app.renderOnce();

    // Fresh success appears immediately during the shared spinner minimum without overlap.
    expect(app.captureCharFrame()).toContain("18% used 1h 0m");
    expect(spinner().visible).toBe(true);
    clock.advance(500);
    await app.renderOnce();
    expect(spinner().visible).toBe(false);
    // Drain frames scheduled by spinner hiding before checking animation leaks.
    clock.advance(20);
    await app.renderOnce();
    expect(clock.pendingTimerCount).toBe(0);
  } finally {
    status.dispose();
    await app.dispose();
  }
});

test("Recovery hides reset usage windows and cleans spinner timers on hiding, static history, and disposal", async () => {
  // Expired success values in error states must not become current-limit fills.
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 100, height: 5, clock });
  const status = new SessionStatus(app.renderer);

  app.renderer.root.add(status.root);

  const data = sample();
  const now = Date.now();
  const failed: SessionTelemetry = {
    ...data,
    usage: {
      ...data.usage!,
      status: "error",
      errorCode: "USAGE_QUERY_FAILED",
      windows: [{ ...data.usage!.windows[0]!, resetsAt: now - 1 }],
    },
  };
  try {
    status.update(failed, true);
    await app.renderOnce();
    clock.advance(20);
    await app.renderOnce();

    const line = app.captureCharFrame().split("\n")[status.root.y + 1]!;
    expect(line.slice(line.indexOf(icons.openai))).not.toContain("▉");
    expect(clock.pendingTimerCount).toBe(1);

    // Drain screen-transition frames so only recovery animation timers could remain.
    status.update(failed, false);
    clock.advance(20);
    await app.renderOnce();
    expect(clock.pendingTimerCount).toBe(0);
    status.update(failed, true, now);
    await app.renderOnce();
    clock.advance(20);
    await app.renderOnce();
    expect(clock.pendingTimerCount).toBe(0);
    status.update(failed, true);
    await app.renderOnce();
    clock.advance(20);
    await app.renderOnce();
    expect(clock.pendingTimerCount).toBe(1);
    status.dispose();
    clock.advance(20);
    await app.renderOnce();

    expect(clock.pendingTimerCount).toBe(0);
  } finally {
    status.dispose();
    await app.dispose();
  }
});

test("Actual zero usage and zero remaining context show empty bars distinct from unknown values", async () => {
  const data = sample();
  const app = await mount({
    ...data,
    context: { usedTokens: 200000, maxTokens: 200000 },
    usage: { ...data.usage!, windows: [{ ...data.usage!.windows[0]!, usedPercent: 0 }] },
  });
  try {
    await app.renderOnce();

    expect(app.line()).toContain("context ▉▉▉▉▉▉▉▉ 0%");
    expect(app.line()).toContain("▉▉▉▉▉▉▉▉ 0% used");
    expect(app.line()).not.toContain("100%");

    const colors = uiTheme(app.renderer).colors;
    for (const span of app
      .captureSpans()
      .lines[app.row.y]!.spans.filter((span) => span.text.includes("▉"))) {
      expect(span.fg.equals(colors.accent)).toBe(false);
      expect(span.bg.toInts()).toEqual(colors.panel.toInts());
    }
  } finally {
    await app.close();
  }
});

test("Legacy weekly responses convert to used ratios and new providers receive matching icons", async () => {
  const data = sample();
  const { usage: _usage, ...legacy } = data;
  const app = await mount({
    ...legacy,
    weekly: { remainingPercent: 82, observedAt: Date.now(), resetsAt: Date.now() + 3600000 },
  });
  try {
    await app.renderOnce();
    expect(app.line()).toContain("18% used");

    await app.set({
      ...sample(),
      provider: "anthropic",
      usage: { ...unavailable(), provider: "anthropic" },
    });

    expect(app.line()).toContain(icons.claude);
    expect(app.line()).toContain("claude");
    expect(app.line()).not.toContain("Claude");
    expect(app.line()).not.toContain(icons.openai);
    await app.set({ ...sample(), provider: "openai" });
    expect(app.line()).toContain(icons.openai);
    expect(app.line()).toContain("openai");
    expect(app.line()).not.toContain("OpenAI");
    expect(app.line()).not.toContain("chatgpt");
  } finally {
    await app.close();
  }
});

test("Countdowns update from local clocks without inventing refreshed limits after reset", async () => {
  const now = 1800000000000;
  const reset = now + (5 * 24 + 23) * 3600000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const scheduled = spyOn(globalThis, "setTimeout");
  const app = await mount({
    ...sample(),
    usage: {
      ...sample().usage!,
      windows: [{ id: "period", usedPercent: 10, periodMs: 604800000, resetsAt: reset }],
    },
  });
  const tick = () => {
    const index = scheduled.mock.calls.findLastIndex(([, delay]) => delay === 60000);
    const result = scheduled.mock.results[index];
    const callback = scheduled.mock.calls[index]?.[0];
    if (!result || result.type !== "return" || typeof callback !== "function") {
      throw new Error("Countdown did not acquire a local timer.");
    }

    clearTimeout(result.value);
    callback();
  };
  try {
    expect(app.line()).toContain("10% used 5d 23h");

    clock.mockReturnValue(now + 3600000);
    tick();
    await app.renderOnce();

    expect(app.line()).toContain("10% used 5d 22h");
    clock.mockReturnValue(reset + 1);
    tick();
    await app.renderOnce();
    expect(app.line().slice(app.line().indexOf(icons.openai)).trim().replace(/\s+/g, " ")).toBe(
      `${icons.openai} chatgpt -`,
    );
    expect(app.line()).not.toContain("100%");
  } finally {
    await app.close();
    scheduled.mockRestore();
    clock.mockRestore();
  }
});

test("Usage selects the longest window regardless of provider names or primary/secondary order", async () => {
  const now = Date.now();
  const app = await mount({
    ...sample(),
    provider: "another-provider",
    usage: {
      provider: "another-provider",
      status: "ready",
      updatedAt: now,
      errorCode: null,
      windows: [
        { id: "first", usedPercent: 90, periodMs: 18000000, resetsAt: now + 3600000 },
        {
          id: "second",
          usedPercent: 10,
          periodMs: 604800000,
          resetsAt: now + (5 * 24 + 23) * 3600000,
        },
      ],
    },
  });
  try {
    app.resize(160, 24);
    await app.renderOnce();

    expect(app.line()).toContain("usage");
    expect(app.line()).toContain("10% used 5d 23h");
    expect(app.line()).not.toContain("90% used");
    expect(app.line()).not.toContain(icons.openai);
  } finally {
    await app.close();
  }
});

test("Hiding and disposal clean countdown timers", async () => {
  const scheduled = spyOn(globalThis, "setTimeout");
  const cleared = spyOn(globalThis, "clearTimeout");
  const app = await mount();
  const timer = () => {
    const index = scheduled.mock.calls.findLastIndex(([, delay]) => delay === 60000);
    const result = scheduled.mock.results[index];
    if (!result || result.type !== "return") {
      throw new Error("Countdown timer was not scheduled.");
    }

    return result.value;
  };
  try {
    const hidden = timer();
    app.selection.selectWorktree("demo:empty");
    await app.renderOnce();
    expect(cleared).toHaveBeenCalledWith(hidden);

    app.selection.selectSession("demo:main", "a1");
    await app.renderOnce();

    const disposed = timer();
    app.view.dispose();

    expect(cleared).toHaveBeenCalledWith(disposed);
  } finally {
    await app.close();
    scheduled.mockRestore();
    cleared.mockRestore();
  }
});
