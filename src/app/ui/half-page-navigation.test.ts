import { openWorkspaceSearch } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { InputRenderable, ScrollBoxRenderable, parseKeypress } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { modelCommand } from "../../agents/model-selection.ts";
import { ok } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { horizontalInset } from "../../ui/spacing.ts";

type Surface = "workspace" | "history" | "monitor" | "model";
const surfaces = ["workspace", "history", "monitor", "model"] as const;
const count = 40;

async function mount(surface: Surface) {
  const clock = new ManualClock(),
    app = await createTestRenderer({
      width: 140,
      height: 30,
      kittyKeyboard: true,
      exitOnCtrlC: false,
      clock,
    });
  const repository = demoWorkspace()[0]!,
    original = repository.worktrees[0]!;
  const names = Array.from({ length: count }, (_, index) => `candidate-${index}`);
  const sessions = names.map((name, index) => ({
    id: `session-${index}`,
    name,
    status: "working" as const,
    subagents: [],
  }));
  const worktrees =
    surface === "workspace"
      ? names.map((name, index) => ({
          ...original,
          id: `tree-${index}`,
          path: `/demo/${index}`,
          name,
          sessions: index ? [] : sessions,
        }))
      : [{ ...original, sessions }];
  const selection = new WorkspaceSelection([{ ...repository, worktrees }]),
    opened: string[] = [],
    submitted: string[] = [];
  const interrupted: string[] = [],
    closed: string[] = [],
    detached: string[] = [];
  const body = Array.from({ length: 100 }, (_, index) => `Preview line ${index}`).join("\n");
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession: (_tree, id) => {
      closed.push(id);
    },
    onDetach: () => {
      detached.push("detach");
    },
    onInterrupt: async (id) => {
      interrupted.push(id);
      return ok(undefined);
    },
    initialDrafts: { "session-0": "KEEP_AGENT_DRAFT" },
    onPrompt: (_id, text) => {
      submitted.push(text);
      return ok(undefined);
    },
    getSessionDetails: (id) => ({
      conversationId: `conversation-${id}`,
      status: "working",
      output: body,
      error: null,
    }),
    onComplete: async () => ok({ items: [modelCommand], truncated: false }),
    onListHistory: async (worktreeId) =>
      ok(
        names.map((title, index) => ({
          id: `saved-${index}`,
          title,
          worktreeId,
          modified: "2026-10-21T00:00:00Z",
          messageCount: 1,
          openSessionId: null,
          unavailableReason: null,
        })),
      ),
    onPreviewHistory: async (worktreeId, id) =>
      ok({ worktreeId, id, text: body, truncated: false }),
    onResumeSession: async (_tree, id) => {
      opened.push(id);
      return ok("session-0");
    },
    onListModels: async (_id, conversationId) =>
      ok({
        conversationId,
        current: { provider: "fixture", id: names[0]! },
        effort: "off",
        models: names.map((id) => ({
          provider: "fixture",
          id,
          name: id,
          contextWindow: 1000,
          images: false,
          reasoning: false,
          efforts: ["off"],
          effort: "off",
        })),
      }),
    onSelectModel: async (_id, _conversation, model) => {
      opened.push(model.id);
      return ok(null);
    },
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) throw new Error(`Missing ${id}`);
    return node;
  };
  await render();
  if (surface === "model") {
    const prompt = get("session-prompt") as InputRenderable;
    prompt.focus();
    prompt.value = "/model";
    await render();
    clock.advance(150);
    await render();
    app.mockInput.pressEnter();
    await render();
  } else if (surface === "workspace") openWorkspaceSearch(app);
  else {
    app.mockInput.pressKey(" ", { ctrl: true });
    app.mockInput.pressKey(surface === "history" ? "h" : "s");
  }
  await render();
  const input = get(
    surface === "workspace" ? "workspace-search" : `${surface}-search`,
  ) as InputRenderable;
  const list = get(
    surface === "workspace" ? "workspace-tree" : `${surface}-list`,
  ) as ScrollBoxRenderable;
  return {
    ...app,
    clock,
    view,
    selection,
    opened,
    submitted,
    interrupted,
    closed,
    detached,
    input,
    list,
    get,
    render,
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test.each(surfaces)(
  "Reopening %s search popups starts fresh input without old queries",
  async (surface) => {
    // Reusing input instances must not preserve popup queries as drafts.
    const app = await mount(surface);
    try {
      await app.mockInput.typeText("candidate-1");
      await app.render();
      app.mockInput.pressEscape();
      await app.render();

      // All reopening entry points reset query and caret to fresh search state.
      if (surface === "model") {
        const prompt = app.get("session-prompt") as InputRenderable;
        prompt.focus();
        prompt.value = "/model";
        await app.render();
        app.clock.advance(150);
        await app.render();
        app.mockInput.pressEnter();
        await app.render();
      } else if (surface === "workspace") openWorkspaceSearch(app);
      else {
        app.mockInput.pressKey(" ", { ctrl: true });
        app.mockInput.pressKey(surface === "history" ? "h" : "s");
      }
      await app.render();

      // Do not reset only filters or append fresh input after stale text.
      expect(app.input.value).toBe("");
      expect(app.input.cursorOffset).toBe(0);
      expect(app.captureCharFrame().split("\n")[app.input.y]).not.toContain("candidate-1");
      await app.mockInput.typeText("candidate-2");
      await app.render();
      expect(app.input.value).toBe("candidate-2");
      expect(app.captureCharFrame()).toContain("candidate-2");
      expect(app.opened).toEqual([]);
      expect(app.submitted).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(surfaces)(
  "%s search shares padding/focus backgrounds and preserves caret after resize",
  async (surface) => {
    // Different search targets share input geometry and click behavior.
    const app = await mount(surface);
    try {
      if (!(app.input instanceof SearchInput)) throw new Error("Missing shared search field");
      const input = app.input,
        field = input.field;
      await app.mockInput.typeText("candidate");
      app.mockInput.pressArrow("left");
      const value = input.value,
        cursor = input.cursorOffset;
      const background = (x: number, y: number) => {
        let end = 0;
        return app
          .captureSpans()
          .lines[y]!.spans.find((span) => {
            end += span.width;
            return end > x;
          })!
          .bg.toInts();
      };

      // Leave results and return through input padding in wide and narrow terminals.
      for (const width of [120, 60]) {
        app.resize(width, 30);
        await app.render();
        app.list.focus();
        await app.render();
        const paddingY = input.y;
        expect(background(field.x + 1, paddingY)).toEqual(
          uiTheme(app.renderer).styles["ui.popup"].bg!.toInts(),
        );
        await app.mockMouse.click(field.x + 1, paddingY);
        await app.render();

        // Single-line editors share sizing and focus colors; monitor decoration surrounds the same native input.
        expect(field.height).toBe(3);
        expect(input.height).toBe(1);
        expect(input.y - field.y).toBe(1);
        const status =
          surface === "history"
            ? app.get("history-list-status")
            : surface === "model"
              ? app.get("model-message")
              : null;
        expect((status?.visible ? status : app.list).y).toBe(field.y + field.height);
        expect(app.list.y).toBe(field.y + field.height + (status?.visible ? status.height : 0));
        expect(app.list.x).toBe(field.x + 1);
        expect(app.list.width).toBe(field.width - 2);
        const inset = horizontalInset(width),
          counter = app.get(`${surface}-search-count`);
        expect(input.x - field.x).toBe(inset + 3);
        // Split-column percentages can round adjacent native text widths to different cells.
        expect(
          Math.abs(
            field.x +
              field.width -
              input.x -
              input.width -
              inset -
              (counter.visible ? counter.width + 2 : 1),
          ),
        ).toBeLessThanOrEqual(1);
        expect(background(field.x + 1, paddingY)).toEqual(
          uiTheme(app.renderer).styles["ui.popup"].bg!.toInts(),
        );
        expect(input.placeholder).toBe("");
        expect(app.renderer.currentFocusedRenderable).toBe(input);
        expect(input.value).toBe(value);
        expect(input.cursorOffset).toBe(cursor);
      }
      expect(input.maxLength).toBe(256);
      expect(app.opened).toEqual([]);
      expect(app.submitted).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("History preview panes fill their height without headings in split and compact layouts", async () => {
  // Preview-only panes must preserve list-local search and independent conversation state.
  const surface = "history",
    app = await mount(surface);
  try {
    await app.mockInput.typeText("candidate");
    app.mockInput.pressArrow("left");
    await app.render();
    const input = app.input as SearchInput,
      value = input.value,
      cursor = input.cursorOffset;

    // Verify actual terminal-cell layouts across split and single-panel transitions.
    for (const width of [140, 100, 99, 60, 140]) {
      app.resize(width, 30);
      await app.render();
      const field = input.field,
        preview = app.get(`${surface}-preview-pane`),
        message = app.get(`${surface}-message`);

      // Search and result hints belong only to lists; previews use their full height.
      expect(field.x + 1).toBe(app.list.x);
      expect(field.width - 2).toBe(app.list.width);
      expect(app.get("history-list-status").x).toBe(app.list.x);
      expect(preview.visible).toBe(width >= 100);
      if (preview.visible) {
        expect(field.x + field.width).toBe(preview.x);
        expect(preview.y).toBe(field.y);
        expect(preview.y + preview.height).toBe(app.list.y + app.list.height);
        const lines = app.captureCharFrame().split("\n");
        expect(lines[field.y]![preview.x]).toBe("│");
        expect(lines[message.y]![preview.x]).toBe("│");
      }
      // Compact layouts reveal the same preview surface through its configured command.
      if (width < 100) {
        app.mockInput.pressKey("o", { ctrl: true });
        await app.render();
      }
      const content = app.get(`${surface}-preview-agent-view`);
      const frame = app.captureCharFrame();

      // Removing a heading must reclaim its row without stripping the actual session UI.
      expect(preview.visible).toBe(true);
      expect(content.y).toBe(preview.y);
      expect(content.height).toBe(preview.height);
      expect(content.x).toBe(preview.x + Number(width >= 100));
      expect(content.x + content.width).toBe(
        app.get(`${surface}-dialog`).x + app.get(`${surface}-dialog`).width,
      );
      // Remove only host padding: preserve the session's native inset and full-bleed composer background.
      const transcript = app.get(`${surface}-preview`),
        composer = app.get(`${surface}-preview-agent-composer`),
        prompt = app.get(`${surface}-preview-session-prompt`);
      expect(transcript.x).toBe(content.x + horizontalInset(width));
      expect(prompt.x).toBe(transcript.x);
      expect(composer.x).toBe(content.x);
      expect(composer.x + composer.width).toBe(content.x + content.width);
      expect(frame).not.toContain("Preview ·");
      expect(frame).not.toContain("Live preview ·");
      expect(frame).not.toContain("History · radian");
      expect(field.y).toBe(app.get(`${surface}-dialog`).y);
      expect(frame).toContain("Preview line");
      expect(frame).not.toContain("Read-only preview");
      expect(app.get(`${surface}-preview-agent-composer`).visible).toBe(true);
      if (width < 100) {
        app.mockInput.pressKey("o", { ctrl: true });
        await app.render();
      }
      expect(input.value).toBe(value);
      expect(input.cursorOffset).toBe(cursor);
      expect(app.renderer.currentFocusedRenderable).toBe(input);
    }
    expect(app.view.promptDrafts["session-0"]).toBe("KEEP_AGENT_DRAFT");
    expect(app.opened).toEqual([]);
    expect(app.submitted).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(surfaces)(
  "%s list Ctrl+D/U moves half-page candidates without committing before Enter",
  async (surface) => {
    // Jump multiple candidates using actual list height and row spacing.
    const app = await mount(surface);
    try {
      await app.mockInput.typeText("candidate");
      app.mockInput.pressTab();
      await app.render();
      const step = Math.max(1, Math.floor(app.list.viewport.height / 4));
      expect(step).toBeGreaterThan(1);

      // Retain candidates at upper boundaries and commit only the final jump.
      app.mockInput.pressKey("d", { ctrl: true });
      app.mockInput.pressKey("u", { ctrl: true });
      app.mockInput.pressKey("u", { ctrl: true });
      app.mockInput.pressKey("d", { ctrl: true });
      await app.render();

      expect(app.input.value).toBe("candidate");
      expect(app.opened).toEqual([]);
      expect(app.selection.sessionId).toBe("session-0");
      expect(app.submitted).toEqual([]);
      expect(app.renderer.currentFocusedRenderable).toBe(app.list);
      const id =
        surface === "workspace"
          ? `worktree:tree-${step}`
          : surface === "history"
            ? `history:saved-${step}`
            : surface === "monitor"
              ? `monitor:session-${step}`
              : `model:${JSON.stringify(["fixture", `candidate-${step}`])}`;
      const row = app.get(id);
      let column = 0;
      const span = app.captureSpans().lines[row.y]!.spans.find((span) => {
        column += span.width;
        return column > row.x + 1;
      });
      expect(span?.bg.toInts()).toEqual(uiTheme(app.renderer).styles["ui.selection"].bg!.toInts());
      app.mockInput.pressEnter();
      await app.render();

      if (surface === "workspace") expect(app.selection.worktree?.id).toBe(`tree-${step}`);
      else if (surface === "monitor") expect(app.selection.sessionId).toBe(`session-${step}`);
      else
        expect(app.opened).toEqual([surface === "history" ? `saved-${step}` : `candidate-${step}`]);
    } finally {
      await app.close();
    }
  },
);

test.each(surfaces)(
  "%s half-page list jumps stop at the final candidate and return upward",
  async (surface) => {
    // End-of-list jumps must not create empty selections or offscreen indexes.
    const app = await mount(surface);
    try {
      app.mockInput.pressTab();
      await app.render();
      const step = Math.max(1, Math.floor(app.list.viewport.height / 4));

      app.mockInput.pressKey("END");
      app.mockInput.pressKey("d", { ctrl: true });
      app.mockInput.pressKey("u", { ctrl: true });
      app.mockInput.pressEnter();
      await app.render();

      const index = count - 1 - step;
      if (surface === "workspace") expect(app.selection.worktree?.id).toBe(`tree-${index}`);
      else if (surface === "monitor") expect(app.selection.sessionId).toBe(`session-${index}`);
      else
        expect(app.opened).toEqual([
          surface === "history" ? `saved-${index}` : `candidate-${index}`,
        ]);
      expect(app.submitted).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each(surfaces.flatMap((surface) => (["d", "u"] as const).map((key) => ({ surface, key }))))(
  "$surface search Ctrl+$key preserves queries and hands focus to lists while jumping",
  async ({ surface, key }) => {
    // Select a middle candidate and move the caret to detect deletion and filter resets.
    const app = await mount(surface);
    try {
      await app.mockInput.typeText("candidate");
      await app.render();
      for (let index = 0; index < 20; index++) {
        app.mockInput.pressKey("n", { ctrl: true });
        await app.render();
      }
      app.mockInput.pressArrow("left");
      app.mockInput.pressArrow("left");
      await app.render();
      const cursor = app.input.cursorOffset;
      const step = Math.max(1, Math.floor(app.list.viewport.height / 4));
      const selected = 20 + (key === "d" ? step : -step);

      app.mockInput.pressKey(key, { ctrl: true });
      await app.render();

      expect(app.input.value).toBe("candidate");
      expect(app.input.cursorOffset).toBe(cursor);
      expect(app.renderer.currentFocusedRenderable?.id).toBe(app.list.id);
      expect(app.opened).toEqual([]);
      expect(app.submitted).toEqual([]);
      app.mockInput.pressEnter();
      await app.render();
      if (surface === "workspace") expect(app.selection.worktree?.id).toBe(`tree-${selected}`);
      else if (surface === "monitor") expect(app.selection.sessionId).toBe(`session-${selected}`);
      else
        expect(app.opened).toEqual([
          surface === "history" ? `saved-${selected}` : `candidate-${selected}`,
        ]);
    } finally {
      await app.close();
    }
  },
);

test("Empty workspace search Ctrl+D/U continues list jumps from the current candidate", async () => {
  // Empty queries still transfer focus without resetting current candidates.
  const app = await mount("workspace");
  try {
    for (let index = 0; index < 6; index++) app.mockInput.pressKey("n", { ctrl: true });
    await app.render();

    app.mockInput.pressKey("d", { ctrl: true });
    app.mockInput.pressKey("u", { ctrl: true });
    await app.render();

    expect(app.input.value).toBe("");
    expect(app.input.cursorOffset).toBe(0);
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.list.id);
    app.mockInput.pressEnter();
    await app.render();
    expect(app.selection.worktree?.id).toBe("tree-6");
  } finally {
    await app.close();
  }
});

test("Search footers omit default candidate navigation and half-page hints", async () => {
  // Earlier interaction scenarios retain actual jumps; hide only default hints.
  const app = await mount("workspace");
  try {
    await app.mockInput.typeText("candidate");
    await app.render();

    const footer = app.captureCharFrame().split("\n")[app.renderer.height - 1]!;

    expect(footer).not.toMatch(/<C-[npd]>|Navigate|½ page/u);
    expect(footer).toContain("Help");
  } finally {
    await app.close();
  }
});

test.each(surfaces)(
  "%s search Ctrl+C clears only queries while preserving runs, drafts, and modals",
  async (surface) => {
    // Separate search cancellation from active Agents and drafts behind modals.
    const app = await mount(surface);
    try {
      await app.mockInput.typeText("candidate");
      const drafts = app.view.promptDrafts;
      const modal = app.get(
        surface === "workspace"
          ? "workspace-picker"
          : surface === "history"
            ? "session-history"
            : surface === "monitor"
              ? "session-monitor"
              : "model-picker",
      );

      app.mockInput.pressCtrlC();
      await app.render();
      expect(app.input.value).toBe("");
      app.mockInput.pressCtrlC();
      await app.render();

      expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id);
      expect(modal.visible).toBe(true);
      expect(app.opened).toEqual([]);
      expect(app.submitted).toEqual([]);
      expect(app.selection.sessionId).toBe("session-0");
      expect(app.interrupted).toEqual([]);
      expect(app.closed).toEqual([]);
      expect(app.detached).toEqual([]);
      expect(app.view.promptDrafts).toEqual(drafts);
      expect(app.view.root.isDestroyed).toBe(false);
    } finally {
      await app.close();
    }
  },
);

test.each(surfaces)("%s search Ctrl+L never aliases query clearing", async (surface) => {
  // Only Ctrl+C owns search clearing; retain no Ctrl+L compatibility alias.
  const app = await mount(surface);
  try {
    await app.mockInput.typeText("candidate");
    const cursor = app.input.cursorOffset;

    app.mockInput.pressKey("l", { ctrl: true });
    await app.render();

    expect(app.input.value).toBe("candidate");
    expect(app.input.cursorOffset).toBe(cursor);
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id);
    expect(app.opened).toEqual([]);
    expect(app.submitted).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Empty search Ctrl+C preserves selection without resetting candidates or scroll", async () => {
  // Empty queries need no global search-reset events.
  const app = await mount("workspace");
  try {
    for (let index = 0; index < 6; index++) app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    const top = app.list.scrollTop;

    app.mockInput.pressCtrlC();
    await app.render();

    expect(app.input.value).toBe("");
    expect(app.list.scrollTop).toBe(top);
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id);
    app.mockInput.pressEnter();
    await app.render();
    expect(app.selection.worktree?.id).toBe("tree-6");
    expect(app.interrupted).toEqual([]);
    expect(app.detached).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["d", "u"] as const)(
  "Search Ctrl+%s keeps jumping on repeats after focus moves to lists",
  async (key) => {
    // Focus handoff must neither duplicate events nor block intentional later repeats.
    const app = await mount("workspace");
    const raw = (event: string) => {
      const parsed = parseKeypress(event, { useKittyKeyboard: true });
      if (!parsed) throw new Error("Invalid Kitty key");
      app.renderer.keyInput.processParsedKey(parsed);
    };
    const code = key === "d" ? 100 : 117;
    try {
      await app.mockInput.typeText("candidate");
      for (let index = 0; index < 15; index++) app.mockInput.pressKey("n", { ctrl: true });
      await app.render();
      const step = Math.max(1, Math.floor(app.list.viewport.height / 4));

      raw(`\x1b[${code};5u`);
      await app.render();
      expect(app.renderer.currentFocusedRenderable?.id).toBe(app.list.id);
      raw(`\x1b[${code};5:2u`);
      await app.render();

      expect(app.input.value).toBe("candidate");
      raw(`\x1b[${code};5:3u`);
      raw(`\x1b[${code};5u`);
      raw(`\x1b[${code};5:3u`);
      await app.render();
      app.mockInput.pressEnter();
      await app.render();

      expect(app.selection.worktree?.id).toBe(`tree-${15 + (key === "d" ? 3 * step : -3 * step)}`);
      expect(app.submitted).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Compact History search jumps return from previews to result lists", async () => {
  // Search jumps target results even when compact layouts currently show only previews.
  const app = await mount("history");
  try {
    app.resize(60, 18);
    await app.render();
    await app.mockInput.typeText("candidate");
    await app.render();
    for (let index = 0; index < 10; index++) {
      app.mockInput.pressKey("n", { ctrl: true });
      await app.render();
    }
    const step = Math.max(1, Math.floor(app.list.viewport.height / 4));
    app.mockInput.pressKey("o", { ctrl: true });
    await app.render();
    expect(app.list.visible).toBe(false);
    app.mockInput.pressKey("/");
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);

    app.mockInput.pressKey("d", { ctrl: true });
    await app.render();

    expect(app.list.visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.list.id);
    expect(app.get("history-preview-pane").visible).toBe(false);
    expect(app.input.value).toBe("candidate");
    const selected = 10 + step,
      row = app.get(`history:saved-${selected}`);
    expect(row.y).toBeGreaterThanOrEqual(app.list.viewport.y);
    expect(row.y + row.height).toBeLessThanOrEqual(app.list.viewport.y + app.list.viewport.height);
    app.mockInput.pressEnter();
    await app.render();
    expect(app.opened).toEqual([`saved-${selected}`]);
  } finally {
    await app.close();
  }
});

test.each(surfaces)(
  "%s jump keys preserve input and focus lists even without matches",
  async (surface) => {
    // Empty-result jumps are neither activation nor native character deletion.
    const app = await mount(surface);
    try {
      await app.mockInput.typeText("no-matching-candidate");
      await app.render();
      const value = app.input.value,
        cursor = app.input.cursorOffset;

      app.mockInput.pressKey("d", { ctrl: true });
      app.mockInput.pressEnter();
      await app.render();

      expect(app.renderer.currentFocusedRenderable?.id).toBe(app.list.id);
      expect(app.input.value).toBe(value);
      expect(app.input.cursorOffset).toBe(cursor);
      expect(app.opened).toEqual([]);
      expect(app.submitted).toEqual([]);
      expect(app.selection.sessionId).toBe("session-0");
    } finally {
      await app.close();
    }
  },
);

test("History preview Ctrl+D/U scrolls only bodies without changing candidates", async () => {
  // Lists and previews within one modal jump within their focused region.
  const app = await mount("history");
  try {
    app.mockInput.pressKey("o", { ctrl: true });
    app.clock.advance(150);
    await app.render();
    const preview = app.get("history-preview") as ScrollBoxRenderable;
    preview.scrollTo(0);
    await app.render();
    const half = Math.max(1, Math.floor(preview.viewport.height / 2));

    app.mockInput.pressKey("d", { ctrl: true });
    await app.render();
    expect(preview.scrollTop).toBe(half);
    app.mockInput.pressKey("u", { ctrl: true });
    await app.render();

    expect(preview.scrollTop).toBe(0);
    expect(app.opened).toEqual([]);
    app.mockInput.pressKey("o", { ctrl: true });
    app.mockInput.pressEnter();
    await app.render();
    expect(app.opened).toEqual(["saved-0"]);
  } finally {
    await app.close();
  }
});

test("Detail-dialog Ctrl+D/U scrolls bodies by half a page", async () => {
  // Surfaces without candidates, such as help and notification details, jump within bodies.
  const app = await mount("workspace");
  try {
    app.mockInput.pressEscape();
    app.view.setNotice(
      Array.from({ length: 100 }, (_, index) => `Details line ${index}`).join("\n"),
      { level: "warning" },
    );
    await app.render();
    app.mockInput.pressKey(" ", { ctrl: true });
    app.mockInput.pressKey("!");
    app.mockInput.pressEnter();
    await app.render();
    const scroll = app.get("text-dialog-scroll") as ScrollBoxRenderable,
      half = Math.floor(scroll.viewport.height / 2);

    app.mockInput.pressKey("d", { ctrl: true });
    await app.render();
    expect(scroll.scrollTop).toBe(half);
    app.mockInput.pressKey("u", { ctrl: true });
    await app.render();

    expect(scroll.scrollTop).toBe(0);
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    expect(scroll.scrollTop).toBe(1);
    app.mockInput.pressKey("p", { ctrl: true });
    await app.render();
    expect(scroll.scrollTop).toBe(0);
    expect(app.submitted).toEqual([]);
  } finally {
    await app.close();
  }
});
