import { openWorkspaceSearch, pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { ok } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const app = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const sent: string[] = [];
  const copies: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    onPrompt: (_id, text) => {
      sent.push(text);

      return ok(undefined);
    },
    getSessionDetails: () => ({ status: null, error: null, output: "Transcript" }),
    initialDrafts: { a1: "untouched draft" },
    onCopyTranscript: async (text) => {
      copies.push(text);

      return ok("Copied fixture");
    },
    ...actions,
  });
  const render = async () => {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }

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
  pressLeader(app, "a");
  await render();

  const prompt = get("session-prompt") as PromptInput;

  return {
    ...app,
    view,
    selection,
    sent,
    copies,
    prompt,
    render,
    get,
    async click(id: string) {
      const n = get(id);
      await app.mockMouse.click(n.x + 1, n.y);
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Help shows contextual/shared keys and restores input draft, caret, and focus on close", async () => {
  const app = await mount();
  try {
    app.mockInput.pressArrow("left");

    const cursor = app.prompt.cursorOffset;
    app.mockInput.pressKey("F1");
    await app.render();
    expect(app.get("text-dialog").visible).toBe(true);
    expect(app.captureCharFrame()).toContain("Current context: prompt");
    app.mockInput.pressKey("y");
    await app.render();
    expect(app.copies[0]).toContain("Application shortcuts");
    expect(app.copies[0]).toContain("<S-CR>");
    expect(app.copies[0]).toContain("<leader>b");

    // Global focus commands elsewhere must not manipulate editors behind open modals.
    openWorkspaceSearch(app);
    await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("text-dialog-scroll");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.prompt.cursorOffset).toBe(cursor);
    expect(app.prompt.value).toBe("untouched draft");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([false, true])(
  "Light theme %s shares Normal across popup bodies and borders without dimming surrounding content",
  async (light) => {
    // A normal-surface override must be shared by the popup, not just the underlying workbench.
    const app = await mount();
    const theme = uiTheme(app.renderer);
    const palette = {
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
    const normal = light ? "#F1F2F3" : "#182028";
    const background = (x: number, y: number) => {
      let column = 0;

      return app.captureSpans().lines[y]!.spans.find((span) => {
        column += span.width;

        return column > x;
      })!.bg;
    };
    try {
      theme.configure(palette, { styles: { "ui.text": { bg: normal } } });
      await app.render();

      const outside = background(0, 0).toInts();

      // Opening Help preserves the existing frame and leaves uncovered content at its original brightness.
      app.mockInput.pressKey("F1");
      await app.render();

      const panel = app.get("text-dialog-panel");
      const frame = app.captureCharFrame();
      const geometry = [panel.x, panel.y, panel.width, panel.height];

      expect(background(0, 0).toInts()).toEqual(outside);
      for (const x of [panel.x, panel.x + Math.floor(panel.width / 2), panel.x + panel.width - 1]) {
        expect(background(x, panel.y).toInts()).toEqual(outside);
        expect(background(x, panel.y + panel.height - 1).toInts()).toEqual(outside);
      }

      expect(background(panel.x + 1, panel.y + 1).toInts()).toEqual(outside);
      expect(frame.split("\n")[panel.y]!.slice(panel.x, panel.x + panel.width)).toBe(
        "╭" + "─".repeat(panel.width - 2) + "╮",
      );

      expect(
        frame.split("\n")[panel.y + panel.height - 1]!.slice(panel.x, panel.x + panel.width),
      ).toBe("╰" + "─".repeat(panel.width - 2) + "╯");

      // Explicit popup colors affect the enclosed body, never the surface outside the border line.
      theme.configure(palette, {
        styles: { "ui.text": { bg: normal }, "ui.popup": { bg: light ? "#DDEEFF" : "#112233" } },
      });
      await app.render();
      expect(background(panel.x, panel.y).toInts()).toEqual(outside);
      expect(background(panel.x + 1, panel.y + 1).toInts()).toEqual(
        theme.styles["ui.popup"].bg!.toInts(),
      );
      expect(background(0, 0).toInts()).toEqual(outside);
      expect([panel.x, panel.y, panel.width, panel.height]).toEqual(geometry);
      expect(app.captureCharFrame()).toBe(frame);
      app.mockInput.pressEscape();
      await app.render();
      expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
      expect(app.prompt.value).toBe("untouched draft");
    } finally {
      await app.close();
    }
  },
);

test("Workspace popup preserves colored code outside its bounds and shares surfaces inside", async () => {
  // Match the reported screenshot: the frame crosses code blocks with backgrounds unlike Normal.
  const app = await mount();
  const theme = uiTheme(app.renderer);
  const underlay = new BoxRenderable(app.renderer, {
    position: "absolute",
    width: "100%",
    height: "100%",
    zIndex: 4800,
  });
  for (const [index, color] of ["#253240", "#363126"].entries()) {
    const block = new BoxRenderable(app.renderer, {
      position: "absolute",
      top: index * 14,
      width: "100%",
      height: 14,
      backgroundColor: color,
    });
    block.add(
      new TextRenderable(app.renderer, {
        content: Array.from({ length: 14 }, () => "CODE_PATTERN ".repeat(10)).join("\n"),
        width: "100%",
      }),
    );
    underlay.add(block);
  }

  app.view.root.add(underlay);

  const background = (x: number, y: number, frame: ReturnType<typeof app.captureSpans>) => {
    let column = 0;

    return frame.lines[y]!.spans.find((span) => {
      column += span.width;

      return column > x;
    })!.bg;
  };
  try {
    await app.render();

    const before = app.captureSpans();

    // Open the real Workspace popup rather than a synthetic frame over a uniform background.
    openWorkspaceSearch(app);
    await app.render();

    // The borderless outer surface fills its bounds; uncovered code keeps its original colors.
    const panel = app.get("workspace-sidebar");
    const search = app.get("workspace-search-box");
    const after = app.captureSpans();
    const lines = app.captureCharFrame().split("\n");
    for (let y = panel.y; y < panel.y + panel.height; y++) {
      for (const x of [panel.x - 1, panel.x + panel.width]) {
        expect(background(x, y, after).toInts()).toEqual(background(x, y, before).toInts());
        expect(background(x, y, after).intent).toBe(background(x, y, before).intent);
      }
      for (const x of [panel.x, panel.x + panel.width - 1]) {
        expect(background(x, y, after).toInts()).toEqual(theme.styles["ui.popup"].bg!.toInts());
      }
    }

    const top = lines[search.y]!.slice(search.x, search.x + search.width);
    expect(top).toStartWith("╭");
    expect(top).toEndWith("╮");
    expect(top).toContain("Workspaces");
    expect(lines[panel.y + panel.height - 1]!.slice(panel.x, panel.x + panel.width)).not.toContain(
      "─",
    );
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.prompt.value).toBe("untouched draft");
  } finally {
    await app.close();
  }
});

test("Footer Help clicks remember original focus and retain compact entry points", async () => {
  const app = await mount();
  try {
    // Abbreviated Help shortcuts retain Neovim notation in compact layouts.
    app.resize(60, 16);
    await app.render();
    expect(app.get("footer-help").visible).toBe(true);
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("<F1>");
    await app.click("footer-help");
    expect(app.get("text-dialog").visible).toBe(true);
    app.mockInput.pressEscape();
    await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.prompt.value).toBe("untouched draft");
  } finally {
    await app.close();
  }
});

test("Notifications leave footer height stable and Messages reads/copies untruncated source", async () => {
  const app = await mount();
  try {
    const footer = app.get("app-footer");
    expect(footer.height).toBe(1);

    const message =
      "[CONNECTION_FAILED] Temporary connection failure\n" +
      "Detailed cause. ".repeat(200) +
      "\nRecovery: reconnect after saving your work.";
    app.view.setNotice(message, { level: "error" });
    await app.render();
    expect(footer.height).toBe(1);
    expect(app.renderer.root.findDescendantById("footer-notice")).toBeUndefined();
    expect(app.captureCharFrame()).toContain("Temporary connection");
    expect(app.captureCharFrame()).not.toContain("Detailed cause.");
    expect(app.captureCharFrame()).toContain("CODE / radian");
    pressLeader(app, "!");
    app.mockInput.pressEnter();
    app.mockInput.pressKey("y");
    await app.render();

    expect(app.copies).toEqual([message]);
    expect(app.get("text-dialog").visible).toBe(true);
    app.mockInput.pressEscape();
    await app.render();
    expect(app.get("messages").visible).toBe(true);
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    app.view.setNotice("");
    await app.render();
    expect(footer.height).toBe(1);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Help reflects overrides and blocks asynchronous focus restoration outside modals", async () => {
  const keymap = expectOk(
    parseKeymap({
      leader: "ctrl+b",
      bindings: {
        "app.help": [{ keys: "f2", scope: "app" }],
        "app.detach": ["<leader> q"],
        "view.chat": [],
      },
    }),
  );
  const app = await mount({ keymap, onDetach: () => {} });
  try {
    // Show actual remapped keys separately while command lists retain logical leaders.
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("<F2> Help");
    app.mockInput.pressKey("F2");
    await app.render();
    app.mockInput.pressKey("y");
    await app.render();
    expect(app.copies[0]).toContain("<leader>: <C-b>");
    expect(app.copies[0]).toContain("<leader>q");
    expect(app.copies[0]).not.toContain("<leader>d");
    app.prompt.focus();
    await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("text-dialog-scroll");

    const visited = new Set<string>();
    for (let i = 0; i < 6; i++) {
      app.mockInput.pressTab();
      await app.render();
      visited.add(app.renderer.currentFocusedRenderable?.id ?? "none");
    }

    expect([...visited]).toEqual(["text-dialog-scroll"]);
    for (const id of ["text-dialog-copy", "text-dialog-close", "text-dialog-remove"]) {
      expect(app.renderer.root.findDescendantById(id)).toBeUndefined();
    }

    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
  } finally {
    await app.close();
  }
});
