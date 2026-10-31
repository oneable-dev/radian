import { openWorkspaceSearch, pressLeader, submitPromptCommand } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextRenderable } from "@opentui/core";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { HistoryItem } from "../../agents/history.ts";
import type { ExecutionState } from "../../agents/session-registry.ts";
import { ok } from "../../result.ts";
import { icons } from "../../icons.ts";

const saved = (id: string, unavailableReason: string | null = null): HistoryItem => ({
  id,
  title: id,
  worktreeId: "demo:main",
  modified: "2026-10-15T00:00:00.000Z",
  messageCount: 1,
  openSessionId: null,
  unavailableReason,
});

async function mount(
  list: () => Promise<readonly HistoryItem[]> = async () => [],
  actions: Partial<WorkbenchActions> = {},
) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const initialFocusListeners = app.renderer.listenerCount("focused_renderable");
  const selection = new WorkspaceSelection(demoWorkspace());
  let status: ExecutionState["status"] = "complete";
  const calls: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {
      calls.push("create");
    },
    onCloseSession: () => {
      calls.push("close");
    },
    onPrompt: (_id, text) => {
      calls.push(`prompt:${text}`);

      return ok(undefined);
    },
    getSessionDetails: () => ({ status, output: "Transcript", error: null }),
    onListHistory: async () => ok(await list()),
    onResumeSession: async (_tree, id) => {
      calls.push(`resume:${id}`);

      return ok("a1");
    },
    ...actions,
  });

  await app.renderOnce();

  return {
    ...app,
    selection,
    calls,
    view,
    initialFocusListeners,
    footerLine: () => app.captureCharFrame().split("\n")[app.renderer.height - 1]!,
    badge: () =>
      (app.renderer.root.findDescendantById("footer-identity") as TextRenderable).plainText.trim(),
    setStatus(next: ExecutionState["status"]) {
      status = next;
      selection.replaceSnapshot(selection.snapshot);
    },
    async openHistory() {
      submitPromptCommand(app, "/history");
      await app.renderOnce();
    },
    async visible(text: string) {
      const deadline = Date.now() + 3000;
      while (!app.captureCharFrame().includes(text)) {
        if (Date.now() > deadline) {
          throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
        }

        await app.renderOnce();
      }
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Default screens use content through the footer without fixed legends or hint rows", async () => {
  // The normal screen should spend its vertical space on work, not permanent help text.
  const app = await mount();
  try {
    const footer = app.renderer.root.findDescendantById("app-footer")!;
    const panel = app.renderer.root.findDescendantById("work-panel")!;

    // The normal footer reserves only its text row, returning the former decoration row to work.
    expect(footer.height).toBe(1);
    expect(footer.y).toBe(23);
    expect(app.captureCharFrame()).not.toContain("▂");
    expect(app.renderer.root.findDescendantById("footer-notice")).toBeUndefined();
    expect(panel.y + panel.height).toBe(footer.y);
    expect(app.captureCharFrame()).not.toContain("Status not supplied");
    expect(app.captureCharFrame()).not.toContain("UI preview only");
    expect(app.footerLine()).toContain("AGENT");
    expect(app.calls).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Account usage lives only in the footer while the session keeps model settings and context", async () => {
  // Both providers share account-level telemetry; the composer still belongs to this session.
  const resetsAt = Date.now() + 3600000;
  const app = await mount(undefined, {
    getSessionDetails: () => ({
      status: "complete",
      error: null,
      output: "Transcript",
      telemetry: {
        provider: "openai-codex",
        model: "gpt-test",
        effort: "high",
        fast: false,
        context: { usedTokens: 28000, maxTokens: 100000 },
        weekly: null,
        providerUsage: {
          "openai-codex": {
            provider: "openai-codex",
            status: "ready",
            windows: [{ id: "weekly", usedPercent: 18, periodMs: 604800000, resetsAt }],
            updatedAt: Date.now(),
            errorCode: null,
          },
          anthropic: {
            provider: "anthropic",
            status: "ready",
            windows: [{ id: "weekly", usedPercent: 43, periodMs: 604800000, resetsAt }],
            updatedAt: Date.now(),
            errorCode: null,
          },
        },
      },
    }),
  });
  try {
    const status = app.renderer.root.findDescendantById("session-status-line")!;
    const line = () => app.captureCharFrame().split("\n")[status.y]!;

    // Provider usage is global chrome; context remains right-aligned beneath the composer.
    expect(app.footerLine()).toContain("18% used");
    expect(app.footerLine()).toContain("43% used");
    expect(app.footerLine()).toContain("1h 0m");
    expect(line()).toContain("gpt-test");
    expect(line()).toContain("high");
    expect(line().trimEnd()).toEndWith("72% left");
    expect(line()).not.toContain("used");
    expect(app.footerLine()).not.toMatch(/<leader>|<F1>|Help|left/u);

    // Opening a popup does not replace usage with contextual shortcuts or remove Help's command.
    app.mockInput.pressKey("F1");
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Application shortcuts");
    expect(app.footerLine()).toContain("18% used");
    expect(app.footerLine()).toContain("43% used");
    expect(app.footerLine()).not.toMatch(/<F1>|Help|Copy|Close/u);
    app.mockInput.pressEscape();
    await app.renderOnce();
    expect(app.selection.sessionId).toBe("a1");
    expect(app.calls).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([120, 60])(
  "Width %i replaces the view badge with focused reader modes and restores AGENT for prompts",
  async (width) => {
    // Legacy output and a retained draft exercise mode changes without exposing implementation labels.
    const app = await mount(undefined, {
      initialDrafts: { a1: "unsent draft" },
      getSessionDetails: () => ({
        status: "complete",
        error: null,
        output: Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n"),
      }),
    });
    try {
      app.resize(width, 24);
      pressLeader(app, "a");
      await app.renderOnce();
      expect(app.badge()).toBe("AGENT");

      // Section navigation and body navigation share NORMAL, even while following is suspended.
      pressLeader(app, "[");
      app.mockInput.pressKey("HOME");
      await app.renderOnce();
      expect(app.badge()).toBe("NORMAL");
      expect(app.view.workViewPreferences.agentViews?.a1?.follow).toBe(false);
      expect(app.footerLine()).not.toMatch(/Paused|legacy preview|TEXT|AGENT/u);
      app.mockInput.pressEnter();
      await app.renderOnce();
      expect(app.badge()).toBe("NORMAL");

      // Selection replaces the badge instead of adding another mode label.
      app.mockInput.pressKey("v");
      await app.renderOnce();
      expect(app.badge()).toBe("VISUAL");
      app.mockInput.pressKey("v", { shift: true });
      await app.renderOnce();
      expect(app.badge()).toBe("VISUAL LINE");

      // Backing out preserves the native draft and restores the view name only on prompt focus.
      app.mockInput.pressEscape();
      await app.renderOnce();
      expect(app.badge()).toBe("NORMAL");
      app.mockInput.pressEscape();
      await app.renderOnce();
      expect(app.badge()).toBe("NORMAL");
      app.mockInput.pressEscape();
      await app.renderOnce();
      expect(app.badge()).toBe("AGENT");
      expect(app.renderer.currentFocusedRenderable?.id).toBe("session-prompt");
      expect(app.view.promptDrafts.a1).toBe("unsent draft");
      expect(app.calls).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Popups keep view badges and restore the focused reader mode on dismissal", async () => {
  // Popup search remains available, and the reader's selection must survive overlays.
  const app = await mount();
  try {
    pressLeader(app, "[");
    app.mockInput.pressEnter();
    app.mockInput.pressKey("v");
    await app.renderOnce();
    expect(app.badge()).toBe("VISUAL");

    openWorkspaceSearch(app);
    await app.mockInput.typeText("radian");
    await app.renderOnce();
    expect(app.badge()).toBe("AGENT");
    app.mockInput.pressEscape();
    await app.renderOnce();
    expect(app.badge()).toBe("VISUAL");

    // Usage owns its view badge rather than inheriting the background selection mode.
    pressLeader(app, "u");
    await app.renderOnce();
    expect(app.badge()).toBe("USAGE");
    app.mockInput.pressEscape();
    await app.renderOnce();
    expect(app.badge()).toBe("VISUAL");
    expect(app.calls).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([120, 60])(
  "Width %i prompts retain newline, interrupt, and submit behavior without default hints",
  async (width) => {
    // Omit hints regardless of footer width even for runs supporting interruption.
    let interruptions = 0;
    const app = await mount(undefined, {
      onInterrupt: async () => {
        interruptions++;

        return ok(undefined);
      },
    });
    try {
      app.resize(width, 24);
      pressLeader(app, "a");
      await app.mockInput.typeText("first");
      app.mockInput.pressEnter({ shift: true });
      await app.mockInput.typeText("second");
      await app.renderOnce();

      // Hiding defaults preserves input semantics and active-work submission routing.
      for (const state of ["complete", "working"] as const) {
        app.setStatus(state);
        await app.renderOnce();
        expect(app.footerLine()).not.toMatch(/Run|Queue|New line|Interrupt|<C-[cnp]>/u);
        expect(app.footerLine()).not.toMatch(/<F1>|Help|<leader>/u);
        expect(app.view.promptDrafts.a1).toBe("first\nsecond");
      }

      app.mockInput.pressEscape();
      await app.renderOnce();
      expect(interruptions).toBe(1);
      expect(app.view.promptDrafts.a1).toBe("first\nsecond");
      app.mockInput.pressEnter();
      await app.waitFor(() => app.view.promptDrafts.a1 === undefined);

      // Interrupt retains drafts; only one Enter creates actual submission requests.
      expect(app.calls).toEqual(["prompt:first\nsecond"]);
    } finally {
      await app.close();
    }
  },
);

test("Trees and search retain focus navigation and literal typing without default hints", async () => {
  // Moving between lists and search must not resurrect hidden navigation hints.
  const app = await mount();
  try {
    openWorkspaceSearch(app);
    app.mockInput.pressTab();
    await app.renderOnce();
    expect(app.footerLine()).not.toMatch(/<CR>|Navigate|½ page|Close|First\/last|<F1>|Help/u);

    openWorkspaceSearch(app);
    await app.renderOnce();
    await app.mockInput.typeText("nxq");
    await app.renderOnce();

    expect(app.footerLine()).not.toMatch(/<CR>|<Esc>|<C-[np]>|Navigate/u);
    expect(app.footerLine()).not.toContain("New session");
    expect(app.calls).toEqual([]);
    app.mockInput.pressCtrlC();
    app.mockInput.pressTab();
    await app.renderOnce();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
    expect(app.footerLine()).not.toMatch(/<F1>|Help/u);
  } finally {
    await app.close();
  }
});

test("History omits all footer hints while preserving lookup and selection", async () => {
  // Late metadata must not restore default open/navigation hints.
  const pending = Promise.withResolvers<readonly HistoryItem[]>();
  const app = await mount(() => pending.promise);
  try {
    await app.openHistory();
    expect(app.footerLine()).not.toMatch(/Refresh|Preview|<C-r>|<C-o>/u);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("history-search");
    expect(app.footerLine()).not.toContain("<CR> Open");

    pending.resolve([saved("Available saved"), saved("Busy saved", "Still closing")]);
    await app.visible("Available saved");

    expect(app.footerLine()).not.toContain("Preview");
    app.mockInput.pressTab();
    await app.renderOnce();
    expect(app.footerLine()).not.toMatch(/<CR>|Previous|Next|½ page|<Esc>/u);
    expect(app.footerLine()).not.toContain("New session");
    app.mockInput.pressArrow("down");
    await app.renderOnce();
    expect(app.footerLine()).not.toContain("<CR> Open");
    app.mockInput.pressEnter();
    await app.renderOnce();
    expect(app.calls).toEqual([]);
    expect(app.captureCharFrame()).toContain("Still closing");
  } finally {
    await app.close();
  }
});

test("Prompt availability preserves drafts and selection without any footer shortcuts", async () => {
  // Removing instructions must not change draft clearing, submission or workspace commands.
  const app = await mount();
  try {
    pressLeader(app, "a");
    await app.renderOnce();
    expect(app.footerLine()).not.toContain("<leader>b Workspace");
    expect(app.footerLine()).not.toContain("<CR> Run");
    await app.mockInput.typeText("hello");
    await app.renderOnce();
    expect(app.footerLine()).not.toContain("<C-c> Clear");
    expect(app.footerLine()).not.toContain("<CR> Run");

    app.setStatus("working");
    await app.renderOnce();
    expect(app.footerLine()).not.toMatch(/Run|Queue|New line|Interrupt/u);
    app.mockInput.pressEnter();
    await app.waitFor(() => app.view.promptDrafts.a1 === undefined);
    await app.renderOnce();

    expect(app.calls).toEqual(["prompt:hello"]);
    expect(app.footerLine()).not.toContain("<leader>b Workspace");
    expect(app.view.promptDrafts.a1).toBeUndefined();
    expect(app.selection.sessionId).toBe("a1");
    expect(app.footerLine()).not.toContain("<CR> Run");
  } finally {
    await app.close();
  }
});

test("Compact hidden-panel layouts keep footer/notifications at bottom and clicks preserve selection", async () => {
  // Responsive layout may hide the inspector, but the common footer remains outside every panel.
  const app = await mount();
  try {
    const focus = app.renderer.currentFocusedRenderable;
    app.view.setNotice("Runtime reconnecting", { level: "warning" });
    app.resize(60, 12);
    await app.renderOnce();

    await app.mockMouse.click(2, 11);
    await app.renderOnce();

    expect(app.footerLine()).toContain("AGENT");
    expect(app.footerLine()).not.toContain("0.0.0");
    expect(app.captureCharFrame()).toContain("Runtime reconnecting");
    expect(app.renderer.root.findDescendantById("app-footer")!.height).toBe(1);
    expect(app.captureCharFrame()).not.toContain("Inspector");
    expect(app.renderer.currentFocusedRenderable).toBe(focus);
    expect(app.selection.sessionId).toBe("a1");
    expect(app.calls).toEqual([]);
    app.resize(120, 24);
    await app.renderOnce();
    expect(app.footerLine()).not.toContain("<leader>[ Transcript");
  } finally {
    await app.close();
  }
});

test("Prompts and status align to the work-area left without sidebar space", async () => {
  // Popup navigation must not reserve a divider cell or shrink Agent content.
  const app = await mount();
  try {
    for (const [width, height, inset] of [
      [120, 24, 2],
      [60, 12, 1],
      [79, 18, 1],
      [80, 17, 2],
      [120, 24, 2],
    ] as const) {
      app.resize(width, height);
      await app.renderOnce();

      const composer = app.renderer.root.findDescendantById("agent-composer")!;
      const prompt = app.renderer.root.findDescendantById("session-prompt")!;
      const panel = app.renderer.root.findDescendantById("work-panel")!;
      const status = app.renderer.root.findDescendantById("session-status")!;

      expect(panel.x).toBe(0);
      expect(panel.width).toBe(width);
      expect(composer.x).toBe(panel.x);
      expect(prompt.x).toBe(composer.x + inset);
      expect(composer.y + composer.height).toBe(status.y);
      expect(status.y + status.height).toBe(panel.y + panel.height);
      expect(app.renderer.root.findDescendantById("workspace-picker")!.visible).toBe(false);
      expect(app.calls).toEqual([]);
    }
  } finally {
    await app.close();
  }
});

test("Regular layout padding shrinks in compact screens and restores alongside drafts", async () => {
  // Content keeps responsive insets while the view badge retains symmetric one-cell padding.
  const app = await mount();
  const transcript = app.renderer.root.findDescendantById("session-transcript")!;
  const composer = app.renderer.root.findDescendantById("agent-composer")!;
  const prompt = app.renderer.root.findDescendantById("session-prompt")!;
  try {
    expect(app.renderer.root.findDescendantById("workspace-picker")!.visible).toBe(false);
    expect(transcript.x).toBe(2);
    expect(composer.x).toBe(0);
    expect(prompt.x - composer.x).toBe(2);
    expect(app.footerLine().indexOf("AGENT")).toBe(1);

    // Shrinking the real renderer reduces insets rather than clipping the active input.
    pressLeader(app, "a");
    await app.mockInput.typeText("keep this draft");
    app.resize(60, 12);
    await app.renderOnce();

    expect(transcript.x).toBe(1);
    expect(composer.x).toBe(0);
    expect(prompt.x - composer.x).toBe(1);
    expect(app.footerLine().indexOf("AGENT")).toBe(1);
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);

    // The normal spacing returns without rebuilding the Agent or replacing its draft.
    app.resize(120, 24);
    await app.renderOnce();

    expect(transcript.x).toBe(2);
    expect(composer.x).toBe(0);
    expect(prompt.x - composer.x).toBe(2);
    expect(app.footerLine().indexOf("AGENT")).toBe(1);
    expect(app.view.promptDrafts.a1).toBe("keep this draft");
    expect(app.calls).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Short terminals keep Agent status/input clear of single-row footers", async () => {
  // Height changes retain the same composer treatment and keep usable input above the footer.
  const app = await mount();
  try {
    pressLeader(app, "a");
    await app.mockInput.typeText("compact draft");

    // Resizing while typing must preserve the active draft and fit every control above the footer.
    app.resize(60, 12);
    await app.renderOnce();

    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const prompt = app.renderer.root.findDescendantById("session-prompt")!;
    const footer = app.renderer.root.findDescendantById("footer-bar")!;

    expect(composer.height).toBe(3);

    const status = app.renderer.root.findDescendantById("session-status")!;
    expect(composer.y + composer.height).toBe(status.y);
    expect(status.height).toBe(3);
    expect(status.y + status.height).toBeLessThanOrEqual(footer.y);

    const row = status.getChildren()[0]!;
    expect(app.captureCharFrame().split("\n")[row.y]).toContain(`${icons.context} -`);
    expect(app.captureCharFrame().split("\n")[row.y]).not.toContain(`${icons.robot} -`);
    expect(prompt.y + prompt.height).toBeLessThanOrEqual(footer.y);
    expect(app.captureCharFrame().split("\n")[prompt.y]).toContain("compact draft");
    expect(app.captureCharFrame()).not.toContain("Status not supplied");
    expect(app.footerLine().trimStart()).toStartWith("AGENT");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.renderer.currentFocusedRenderable).toBe(prompt);

    // Increasing the height keeps the same input treatment without losing its state.
    app.resize(120, 24);
    await app.renderOnce();
    expect(composer.height).toBe(3);
    expect(app.view.promptDrafts.a1).toBe("compact draft");
    expect(app.calls).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Blur and disposal leave neither stale shortcuts nor focus subscriptions", async () => {
  // Footer integration must not keep listeners alive after the view has been disposed.
  const app = await mount();
  try {
    app.renderer.currentFocusedRenderable?.blur();
    await app.renderOnce();
    expect(app.footerLine()).toContain("AGENT");
    expect(app.footerLine()).not.toContain("Help");
    expect(app.footerLine()).not.toContain("Open worktree");
    app.view.dispose();

    expect(app.renderer.listenerCount("focused_renderable")).toBe(app.initialFocusListeners);
    app.view.setNotice("Late update");
    await app.renderOnce();
    expect(app.captureCharFrame()).not.toContain("Late update");
  } finally {
    await app.close();
  }
});
