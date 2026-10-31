import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import type { TerminalColors } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ok } from "../../result.ts";
import type { SessionTelemetry } from "../telemetry.ts";
import type { SessionExtensionUi } from "../extension-ui.ts";
import type { ProviderUsage } from "../../usage/model.ts";
import { uiTheme } from "../../ui/theme.ts";
import { icons } from "../../icons.ts";
import { SessionStatus } from "./session-status.ts";

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

async function mount(telemetry: SessionTelemetry = sample()) {
  const app = await createTestRenderer({ width: 140, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
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

async function mountStatus(
  telemetry: SessionTelemetry = sample(),
  width = 100,
  clock?: ManualClock,
) {
  const app = await createTestRenderer({ width, height: 5, ...(clock ? { clock } : {}) });
  const status = new SessionStatus(app.renderer);
  app.renderer.root.add(status.root);
  status.update(telemetry, true);
  await app.renderOnce();

  return {
    ...app,
    status,
    line: () => app.captureCharFrame().split("\n")[status.root.y + 1]!,
    async close() {
      status.dispose();
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

test("Status below prompts keeps model settings left and only context right with one-row outer spacing", async () => {
  // The session has 64% context left; its account allowance must not consume the metadata row.
  const app = await mount();
  try {
    // Editing a draft leaves the passive metadata visible without taking its focus.
    pressLeader(app, "a");
    await app.mockInput.typeText("keep this draft");
    await app.renderOnce();

    const prompt = app.renderer.root.findDescendantById("session-prompt")!;
    const composer = app.renderer.root.findDescendantById("agent-composer")!;

    // Telemetry has its own one-row gutters, separate from the prompt's internal padding.
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
    expect(app.line().trimStart()).toStartWith(
      `${icons.model} gpt-5.5 · ${icons.brain} high · ${icons.bolt} fast on`,
    );
    expect(app.line().trimEnd()).toEndWith(`${icons.context} ▉▉▉▉▉▉▉▉ 64% left`);
    expect(Bun.stringWidth(app.line().trimEnd())).toBe(app.root.x + app.root.width);
    expect(app.line()).not.toMatch(/context|chatgpt|ChatGPT|used|1h/u);
    expect(app.line()).not.toContain(icons.openai);
    expect(app.root.findDescendantById("usage-provider-icon")).toBeUndefined();

    // Clicking either end of the metadata must not steal input focus or submit the draft.
    for (const x of [app.row.x + 2, app.row.x + app.row.width - 2]) {
      await app.mockMouse.click(x, app.row.y);
      await app.renderOnce();
      expect(app.renderer.currentFocusedRenderable).toBe(prompt);
      expect(app.view.promptDrafts.a1).toBe("keep this draft");
    }
  } finally {
    await app.close();
  }
});

test("MCP follows fast on the left with colored issues without duplicating footer status", async () => {
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

    // Runtime metadata stays with settings, before the right-aligned context meter.
    expect(app.line()).toContain(
      `${icons.bolt} fast on · ${icons.mcp} mcp 8 (1 needs auth · 1 error)`,
    );
    expect(app.line().indexOf(icons.mcp)).toBeLessThan(app.line().indexOf(icons.context));
    expect(Bun.stringWidth(app.line().trimEnd())).toBe(app.root.x + app.root.width);
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
  const app = await mountStatus(sample(), 140);
  try {
    // Each structured summary replaces the session's previous MCP state.
    app.status.updateMcp(mcp);
    await app.renderOnce();

    // Known issues retain their grammatical counts without displaying zero-valued noise.
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

    // Selecting another session and later receiving a stale snapshot must replace, not merge, metadata.
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

test("Narrow rows drop MCP before model settings and restore it on expansion", async () => {
  // Optional MCP details must not displace model settings or known remaining context.
  const app = await mountStatus(sample(), 140);
  app.status.updateMcp({ servers: 8, needsAuth: 1, errors: 1 });
  try {
    // Shrinking the row hides optional metadata, without changing the telemetry or its alignment.
    app.resize(70, 5);
    await app.renderOnce();

    expect(app.line()).not.toContain(icons.mcp);
    expect(app.line()).toContain("gpt-5.5");
    expect(app.line()).toContain("fast on");
    expect(app.line().trimEnd()).toEndWith("64% left");
    expect(Bun.stringWidth(app.line().trimEnd())).toBe(70);
    app.resize(140, 5);
    await app.renderOnce();
    expect(app.line()).toContain(`${icons.mcp} mcp 8 (1 needs auth · 1 error)`);
    expect(app.line().trimEnd()).toEndWith(`${icons.context} ▉▉▉▉▉▉▉▉ 64% left`);
  } finally {
    await app.close();
  }
});

test("Worktree and branch stay in the footer without duplicating session metadata", async () => {
  // Workspace identity belongs to the workbench, not the Agent-only model row.
  const app = await mount();
  try {
    // Terminal palette changes must not move scope information back into the session row.
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

test("Narrow rows preserve right-aligned context even after all model settings no longer fit", async () => {
  // Context remains useful when the entire settings block must be hidden.
  const app = await mountStatus(sample(), 60);
  try {
    // Each resize must recompute the layout rather than preserve stale whitespace or hidden settings.
    for (const width of [60, 50, 40, 30, 20, 10, 6, 4, 1, 60]) {
      app.resize(width, 5);
      await app.renderOnce();

      // A minimal percentage survives until even its digits cannot fit, always at the right edge.
      expect(Bun.stringWidth(app.line().trimEnd())).toBe(width);
      expect(app.line()).not.toContain(icons.openai);
      expect(app.line()).not.toContain("used");
      if (width >= 4) {
        expect(app.line()).toContain("64%");
      } else {
        expect(app.line()).toBe("-");
      }
      if (width >= 10) {
        expect(app.line()).toContain(icons.context);
        expect(app.line().trimEnd()).toEndWith("64% left");
      }
      if (width === 20) {
        expect(app.line()).not.toContain("gpt-5.5");
      }
    }

    expect(app.line()).toContain("gpt-5.5");
    expect(app.line()).toContain("fast on");
    expect(app.line()).toContain("▉▉▉▉▉▉▉▉");
  } finally {
    await app.close();
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

test("Filled context bars retain theme accent gradients across palette changes", async () => {
  // An unused context window fills every segment, making the accent gradient observable.
  const app = await mountStatus({ ...sample(), context: { usedTokens: 0, maxTokens: 200000 } });
  const spanAt = (column: number) => {
    let x = 0;

    return app.captureSpans().lines[app.status.root.y + 1]!.spans.find((span) => {
      x += span.width;

      return x > column;
    })!;
  };
  const verify = () => {
    const line = app.line();
    const start = Bun.stringWidth(line.slice(0, line.indexOf(icons.context)) + `${icons.context} `);
    const first = spanAt(start);
    const last = spanAt(start + 7);

    expect(first.fg.toInts()).toEqual(uiTheme(app.renderer).colors.accent.toInts());
    expect(last.fg.equals(first.fg)).toBe(false);
    expect(first.bg.equals(uiTheme(app.renderer).colors.panel)).toBe(true);
    expect(line.trimEnd()).toEndWith(`${icons.context} ▉▉▉▉▉▉▉▉ 100% left`);

    return first.fg.toInts();
  };
  try {
    // Theme changes must repaint the passive meter even when the telemetry has not changed.
    app.renderer.emit("palette", palette(false));
    await app.renderOnce();

    const dark = verify();

    app.renderer.emit("palette", palette(true));
    await app.renderOnce();

    // The new theme changes colors without changing the remaining-context direction.
    expect(verify()).not.toEqual(dark);
  } finally {
    await app.close();
  }
});

test("Partial context bars retain bold segment shapes with cell-level fill colors", async () => {
  // Eight segments approximate the fill; the label must retain the exact 77% value.
  const app = await mountStatus({ ...sample(), context: { usedTokens: 46000, maxTokens: 200000 } });
  const spanAt = (column: number) => {
    let x = 0;

    return app.captureSpans().lines[app.status.root.y + 1]!.spans.find((span) => {
      x += span.width;

      return x > column;
    })!;
  };
  try {
    // Switching palettes must preserve thick segments without adding a continuous background track.
    for (const light of [false, true]) {
      app.renderer.emit("palette", palette(light));
      await app.renderOnce();

      // Six context segments are active; empty cells keep the same glyph and panel background.
      const line = app.line();
      const panel = uiTheme(app.renderer).colors.panel;
      const label = `${icons.context} `;
      const start = Bun.stringWidth(line.slice(0, line.indexOf(label) + label.length));
      const empty = spanAt(start + 7).fg;

      expect(line).toContain(`${icons.context} ▉▉▉▉▉▉▉▉ 77% left`);
      expect(empty.equals(panel)).toBe(false);
      for (let cell = 0; cell < 8; cell++) {
        const span = spanAt(start + cell);
        expect(span.bg.toInts()).toEqual(panel.toInts());
        expect(span.fg.equals(empty)).toBe(cell >= 6);
      }
    }
  } finally {
    await app.close();
  }
});

test("Context, model, effort and fast retain theme roles and configuration state", async () => {
  // A known palette distinguishes each role from hardcoded or uniformly muted text.
  const app = await mountStatus();
  const span = (text: string) =>
    app
      .captureSpans()
      .lines[app.status.root.y + 1]!.spans.find((value) => value.text.includes(text))!;
  try {
    // Both fast states must follow the active palette without changing label casing or alignment.
    for (const light of [false, true]) {
      app.renderer.emit("palette", palette(light));
      for (const enabled of [true, false]) {
        app.status.update({ ...sample(), fast: enabled }, true);
        await app.renderOnce();

        const colors = uiTheme(app.renderer).colors;
        expect(span(icons.context).fg.toInts()).toEqual(colors.text.toInts());
        expect(span("gpt-5.5").fg.toInts()).toEqual(colors.success.toInts());
        expect(span("high").fg.toInts()).toEqual(colors.keyword.toInts());
        expect(span(`fast ${enabled ? "on" : "off"}`).fg.toInts()).toEqual(
          (enabled ? colors.number : colors.muted).toInts(),
        );
        expect(app.line()).toContain(
          `${icons.model} gpt-5.5 · ${icons.brain} high · ${icons.bolt} fast ${enabled ? "on" : "off"}`,
        );
      }
    }
  } finally {
    await app.close();
  }
});

test("Narrow layouts preserve context, drafts and focus while restoring settings on expansion", async () => {
  // A session remains editable while its metadata switches between compact and wide layouts.
  const app = await mount();
  try {
    pressLeader(app, "a");
    await app.mockInput.typeText("resize draft");

    // Resizing must affect presentation only, never the active draft or keyboard focus.
    for (const [width, height] of [
      [100, 20],
      [60, 12],
      [140, 24],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();

      // Context is the only resource shown in the row and stays flush with the prompt's right inset.
      expect(app.line()).toContain(icons.context);
      expect(app.line()).toContain("64%");
      expect(app.line()).not.toContain("used");
      expect(app.line()).not.toContain(icons.openai);
      expect(Bun.stringWidth(app.line().trimEnd())).toBe(app.root.x + app.root.width);

      const prompt = app.renderer.root.findDescendantById("session-prompt")!;
      const composer = app.renderer.root.findDescendantById("agent-composer")!;
      const footer = app.renderer.root.findDescendantById("footer-bar")!;
      const run = app.renderer.root.findDescendantById("agent-run-status")!;

      expect(composer.y - run.y - run.height).toBe(1);
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
  } finally {
    await app.close();
  }
});

test("Full and abbreviated fast labels remain lowercase in every state", async () => {
  // Compact settings retain their model, brain and bolt icons while dropping verbose labels.
  const app = await mountStatus();
  try {
    expect(app.line()).toContain("fast on");

    // The narrower row must retain all three settings rather than silently hide fast configuration.
    app.resize(40, 5);
    for (const [fast, label] of [
      [true, "on"],
      [false, "off"],
      [null, "—"],
    ] as const) {
      app.status.update({ ...sample(), fast }, true);
      await app.renderOnce();

      expect(app.line()).toContain(
        `${icons.model} gpt-5.5 ${icons.brain} high ${icons.bolt} ${label}`,
      );
      expect(app.line()).not.toContain("Fast");
      expect(app.line()).toContain("64% left");
    }
  } finally {
    await app.close();
  }
});

test.each([
  { name: "missing context", context: null },
  { name: "unknown used tokens", context: { usedTokens: null, maxTokens: 200000 } },
  { name: "unknown model limit", context: { usedTokens: 72000, maxTokens: 0 } },
])("Unknown context shows a right-aligned dash without bars: $name", async ({ context }) => {
  // Unknown usage or capacity must never look like a full or empty known context window.
  const app = await mountStatus();
  try {
    // Replacing known context must clear its previous percentage and every filled segment.
    app.status.update({ ...sample(), fast: null, context }, true);
    await app.renderOnce();

    expect(app.line()).toContain("fast —");
    expect(app.line().trimEnd()).toEndWith(`${icons.context} -`);
    expect(Bun.stringWidth(app.line().trimEnd())).toBe(100);
    expect(app.line()).not.toContain("▉");
    expect(app.line()).not.toContain("%");
  } finally {
    await app.close();
  }
});

test("Selecting a session without telemetry clears the previous model and context", async () => {
  // The selected session initially has a known model and 64% remaining context.
  const app = await mount();
  try {
    // Another session has no telemetry and must not inherit the previous session's metadata.
    app.selection.selectSession("demo:main", "a2");
    await app.renderOnce();

    expect(app.line()).not.toContain("gpt-5.5");
    expect(app.line()).not.toContain("64%");
    expect(app.line()).toContain("model —");
    expect(app.line().trimEnd()).toEndWith(`${icons.context} -`);
  } finally {
    await app.close();
  }
});

test("Estimated post-compaction context uses the current model limit without extra markers", async () => {
  // Estimated token usage is still useful when measured against the actual model capacity.
  const app = await mountStatus();
  try {
    // Estimated 40,000 tokens against an 872,000-token model rounds to 95% remaining.
    app.status.update({ ...sample(), context: { usedTokens: 40000, maxTokens: 872000 } }, true);
    await app.renderOnce();

    // Preserve the existing bar and percentage format without tildes or unknown-value dashes.
    expect(app.line().trimEnd()).toEndWith(`${icons.context} ▉▉▉▉▉▉▉▉ 95% left`);
    expect(app.line()).not.toContain("~");
    expect(app.line()).not.toContain(`${icons.context} -`);
  } finally {
    await app.close();
  }
});

test("Zero remaining context shows empty segments instead of an unknown dash", async () => {
  // A completely full context window is known, unlike missing telemetry.
  const app = await mountStatus();
  try {
    // Moving from partial usage to the model limit must empty every segment without losing its shape.
    app.status.update({ ...sample(), context: { usedTokens: 200000, maxTokens: 200000 } }, true);
    await app.renderOnce();

    expect(app.line().trimEnd()).toEndWith(`${icons.context} ▉▉▉▉▉▉▉▉ 0% left`);
    expect(app.line()).not.toContain("100%");
    expect(app.line()).not.toContain(`${icons.context} -`);

    const colors = uiTheme(app.renderer).colors;
    for (const span of app
      .captureSpans()
      .lines[app.status.root.y + 1]!.spans.filter((value) => value.text.includes("▉"))) {
      expect(span.fg.equals(colors.accent)).toBe(false);
      expect(span.bg.toInts()).toEqual(colors.panel.toInts());
    }
  } finally {
    await app.close();
  }
});

test("Provider usage, legacy quota and recovery activity never appear on the session row", async () => {
  // Telemetry may contain multiple account allowances and legacy quota while settings remain unchanged.
  const clock = new ManualClock();
  const data = sample();
  const app = await mountStatus(data, 140, clock);
  try {
    const before = app.line();

    // Every account state belongs to the global footer, not a duplicate per-session resource meter.
    for (const status of ["ready", "loading", "error", "unavailable"] as const) {
      const usage: ProviderUsage = { ...data.usage!, status };
      app.status.update(
        {
          ...data,
          usage,
          providerUsage: {
            "openai-codex": usage,
            anthropic: { ...usage, provider: "anthropic" },
            custom: { ...usage, provider: "custom" },
          },
          weekly: { remainingPercent: 82, observedAt: Date.now(), resetsAt: Date.now() + 3600000 },
        },
        true,
      );
      await app.renderOnce();
      clock.advance(1000);
      await app.renderOnce();

      // Provider updates neither change the session line nor leave spinner or countdown timers behind.
      expect(app.line()).toBe(before);
      expect(app.line()).not.toContain(icons.openai);
      expect(app.line()).not.toContain(icons.claude);
      expect(app.line()).not.toMatch(/18%|used|1h/u);
      expect(app.status.root.findDescendantById("usage-provider-icon")).toBeUndefined();
      expect(app.status.root.findDescendantById("usage-loading")).toBeUndefined();
      expect(clock.pendingTimerCount).toBe(0);
    }
  } finally {
    await app.close();
  }
});

test("Captured history retains its model settings, MCP and context without live timers", async () => {
  // An old history snapshot may carry expired usage and recovery state alongside captured session metadata.
  const capturedAt = 1700000000000;
  const clock = new ManualClock();
  const data = sample();
  const snapshot: SessionTelemetry = {
    ...data,
    usage: {
      ...data.usage!,
      status: "error",
      windows: [{ ...data.usage!.windows[0]!, resetsAt: capturedAt + 3600000 }],
    },
  };
  const app = await mountStatus(snapshot, 140, clock);
  try {
    // History callers keep the capture-time argument, even though the remaining metadata is clock-free.
    app.status.update(snapshot, true, capturedAt);
    app.status.updateMcp({ servers: 3, needsAuth: 0, errors: 1 });
    await app.renderOnce();
    clock.advance(20);
    await app.renderOnce();

    const before = app.line();
    expect(before).toContain(
      `${icons.model} gpt-5.5 · ${icons.brain} high · ${icons.bolt} fast on`,
    );
    expect(before).toContain(`${icons.mcp} mcp 3 (1 error)`);
    expect(before.trimEnd()).toEndWith(`${icons.context} ▉▉▉▉▉▉▉▉ 64% left`);
    expect(before).not.toContain(icons.openai);
    expect(clock.pendingTimerCount).toBe(0);

    // Advancing local time must not age or animate a captured session.
    clock.advance(60000);
    await app.renderOnce();

    expect(app.line()).toBe(before);
    expect(clock.pendingTimerCount).toBe(0);
    app.resize(160, 5);
    await app.renderOnce();
    expect(app.line()).toContain(`${icons.mcp} mcp 3 (1 error)`);
    expect(Bun.stringWidth(app.line().trimEnd())).toBe(160);
  } finally {
    await app.close();
  }
});

test("Hidden session metadata restores without scheduling activity and disposal ignores late updates", async () => {
  // Passive settings and context require neither countdown nor animation timers.
  const clock = new ManualClock();
  const data = sample();
  const app = await mountStatus(data, 100, clock);
  try {
    const before = app.line();

    // Switching surfaces hides the metadata and later restores exactly the same captured values.
    app.status.update(data, false);
    await app.renderOnce();
    expect(app.line().trim()).toBe("");
    app.status.update(data, true);
    await app.renderOnce();
    clock.advance(20);
    await app.renderOnce();

    expect(app.line()).toBe(before);
    expect(clock.pendingTimerCount).toBe(0);
    app.status.dispose();
    app.status.update({ ...data, model: "late model" }, true);
    app.status.updateMcp({ servers: 9, needsAuth: 0, errors: 0 });
    await app.renderOnce();
    clock.advance(20);
    await app.renderOnce();

    // Late snapshots cannot repaint a disposed session or reintroduce asynchronous work.
    expect(app.line()).toBe(before);
    expect(clock.pendingTimerCount).toBe(0);
  } finally {
    await app.close();
  }
});
