import { openWorkspaceSearch } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { InputRenderable, type TerminalColors } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { uiTheme } from "../../ui/theme.ts";
import { ok } from "../../result.ts";

async function mount() {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const requests: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => requests.push("new"),
    onCloseSession: () => requests.push("close"),
    onPrompt: () => {
      requests.push("prompt");

      return ok(undefined);
    },
    initialDrafts: { a1: "keep agent draft" },
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };

  openWorkspaceSearch(app);
  app.mockInput.pressTab();
  await render();

  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) {
      throw new Error(`Missing ${id}`);
    }

    return node;
  };
  const input = get("workspace-search");
  if (!(input instanceof InputRenderable)) {
    throw new Error("Missing workspace input.");
  }

  const cell = (x: number, y: number) => {
    let column = 0;

    return app.captureSpans().lines[y]!.spans.find((span) => {
      column += span.width;

      return column > x;
    })!;
  };

  return {
    ...app,
    selection,
    requests,
    view,
    render,
    get,
    input,
    cell,
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

function palette(light: boolean): TerminalColors {
  return {
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
}

test("Search popups center without reducing work areas or creating previews", async () => {
  // Use independent terminal-contained overlays instead of permanent sidebar widths.
  const app = await mount();
  try {
    const panel = app.get("workspace-sidebar");
    const field = app.get("workspace-search-box");

    expect(panel.x).toBeGreaterThan(0);
    expect(panel.y).toBeGreaterThan(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(120);
    expect(panel.y + panel.height).toBeLessThanOrEqual(24);
    expect(app.get("work-panel").width).toBe(120);
    expect(field.height).toBe(3);
    expect(app.input.height).toBe(1);
    expect(app.input.y).toBe(field.y + 1);
    expect(app.captureCharFrame()).toContain("Workspaces");
    expect(app.input.placeholder).toBe("");
    expect(app.renderer.root.findDescendantById("workspace-preview")).toBeUndefined();
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Tab and Shift+Tab cycle only popup search and results", async () => {
  // Search input must not leak into background Agent drafts.
  const app = await mount();
  try {
    app.mockInput.pressTab({ shift: true });
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    app.mockInput.pressTab();
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("workspace-tree");
    app.mockInput.pressTab();
    await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.view.promptDrafts.a1).toBe("keep agent draft");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([false, true])(
  "At brightness %j, search padding clicks focus inputs with consistent backgrounds",
  async (light) => {
    // Empty padding belongs to search input click targets.
    const app = await mount();
    try {
      const theme = uiTheme(app.renderer);
      theme.configure(palette(light));
      await app.render();

      const field = app.get("workspace-search-box");
      expect(app.cell(field.x + 1, field.y).bg.toInts()).toEqual(
        theme.styles["ui.popup"].bg!.toInts(),
      );

      await app.mockMouse.click(field.x + 1, field.y);
      await app.render();
      await app.mockInput.typeText("main");
      await app.render();

      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.input.value).toBe("main");
      expect(app.cell(app.input.x, app.input.y).bg.toInts()).toEqual(
        theme.styles["ui.popup"].bg!.toInts(),
      );
      app.mockInput.pressEnter();
      await app.render();
      expect(app.get("workspace-picker").visible).toBe(false);
      expect(app.selection.worktree?.id).toBe("demo:main");
      expect(app.requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Resize preserves query, caret, and drafts while fitting popups within compact terminals", async () => {
  // Resize must not reset editing positions in long queries.
  const app = await mount();
  try {
    openWorkspaceSearch(app);
    await app.mockInput.typeText("workspace-query-".repeat(6));
    app.mockInput.pressArrow("left");
    await app.render();

    const value = app.input.value;
    const cursor = app.input.cursorOffset;

    app.resize(60, 12);
    await app.render();

    const panel = app.get("workspace-sidebar");
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(60);
    expect(panel.y + panel.height).toBeLessThanOrEqual(12);
    expect(app.get("workspace-tree").height).toBeGreaterThan(0);
    expect(app.input.value).toBe(value);
    expect(app.input.cursorOffset).toBe(cursor);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    app.mockInput.pressCtrlC();
    await app.render();
    expect(app.input.value).toBe("");
    expect(app.input.placeholder).toBe("");
    expect(app.view.promptDrafts.a1).toBe("keep agent draft");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Cancelling and reopening resets search query/caret while preserving Agent drafts", async () => {
  // Popup queries are transient filters, unlike restored Agent drafts.
  const app = await mount();
  try {
    openWorkspaceSearch(app);
    await app.mockInput.typeText("feature");
    app.mockInput.pressArrow("left");
    await app.render();

    // Close without committing candidates, then start another search.
    app.mockInput.pressEscape();
    await app.render();
    openWorkspaceSearch(app);
    await app.render();

    // New search is empty without affecting active workspaces or conversation drafts.
    expect(app.get("workspace-picker").visible).toBe(true);
    expect(app.input.value).toBe("");
    expect(app.input.cursorOffset).toBe(0);
    expect(app.captureCharFrame()).toContain("Workspaces");
    expect(app.input.placeholder).toBe("");
    expect(app.view.promptDrafts.a1).toBe("keep agent draft");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});
