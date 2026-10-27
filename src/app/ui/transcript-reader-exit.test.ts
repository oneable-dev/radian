import { expect, test } from "bun:test";
import {
  EditBufferRenderable,
  ScrollBoxRenderable,
  parseKeypress,
  type Renderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { TranscriptSection } from "../../agents/transcript.ts";
import { ok } from "../../result.ts";
import { pressLeader } from "../../testing/keys.ts";

const command =
  "git diff --check; bun run typecheck && bun test src/keybindings src/app/ui src/agents/ui src/agents/transcript-preferences.test.ts src/agents/transcript-vim.test.ts src/terminal/ui src/editor/ui src/git/ui src/ui src/runtime/work-view-preferences.test.ts src/runtime/workspace-preferences.test.ts src/app/cli-terminal.test.ts";
const sections = (): TranscriptSection[] => [
  {
    id: "error",
    kind: "thinking",
    title: "Thinking",
    text: "Error:\nWebSocket closed 1006 Connection ended",
    status: "complete",
  },
  {
    id: "edit",
    kind: "tool",
    title: "edit",
    summary: "docs/reference.md",
    text: "Modified docs",
    status: "complete",
  },
  {
    id: "note",
    kind: "assistant",
    title: "Agent",
    text: "Checking navigation and folding behavior. ".repeat(8),
    status: "complete",
  },
  { id: "command", kind: "tool", title: "bash", command, text: "RAW OUTPUT", status: "complete" },
];
function descendants(node: Renderable): Renderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child)]);
}
async function mount(working = false) {
  const app = await createTestRenderer({
    width: 200,
    height: 21,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const repositories = demoWorkspace().map((repo) => ({
    ...repo,
    worktrees: repo.worktrees.map((tree) => ({
      ...tree,
      sessions: tree.sessions.map((session) => ({ ...session, subagents: [] })),
    })),
  }));
  const selection = new WorkspaceSelection(repositories);
  let current = sections();
  const sent: string[] = [],
    interrupted: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {},
    onCloseSession() {},
    initialDrafts: { a1: "Unsent prompt" },
    onPrompt: (_id, text) => {
      sent.push(text);
      return ok(undefined);
    },
    onInterrupt: async (id) => {
      interrupted.push(id);
      return ok(undefined);
    },
    getSessionDetails: () => ({
      status: working ? "working" : "complete",
      error: null,
      output: "",
      sections: current,
    }),
  });
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  await render();
  const scroll = app.renderer.root.findDescendantById("session-transcript");
  const prompt = app.renderer.root.findDescendantById("session-prompt");
  if (!(scroll instanceof ScrollBoxRenderable) || !(prompt instanceof EditBufferRenderable))
    throw new Error("Missing Agent layout");
  prompt.focus();
  prompt.cursorOffset = 4;
  const header = () =>
    descendants(app.renderer.root)
      .filter(
        (node): node is EditBufferRenderable =>
          node instanceof EditBufferRenderable && node.plainText.startsWith("$ git diff"),
      )
      .at(-1)!;
  return {
    ...app,
    selection,
    view,
    scroll,
    prompt,
    header,
    sent,
    interrupted,
    render,
    state: () => view.workViewPreferences.agentViews?.a1,
    bottom: () => Math.max(0, scroll.scrollHeight - scroll.viewport.height),
    async read() {
      pressLeader(app, "[");
      app.mockInput.pressKey("HOME");
      await render();
    },
    async clipHeader() {
      const node = header();
      // Put only the first wrapped row at the viewport edge, like a paused live conversation.
      scroll.scrollTo(scroll.scrollTop + node.y - scroll.viewport.y - (scroll.viewport.height - 1));
      await render();
    },
    async update(next: TranscriptSection[]) {
      current = next;
      selection.replaceSnapshot(repositories);
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Explicit reader exit reveals the entire wrapped tool header and resumes following", async () => {
  // Reproduce the screenshot geometry without treating a connection-error string as a renderer failure.
  const app = await mount();
  try {
    await app.read();
    await app.clipHeader();
    const node = app.header(),
      edge = () => app.scroll.viewport.y + app.scroll.viewport.height;
    expect(node.virtualLineCount).toBeGreaterThan(1);
    expect(node.height).toBe(node.virtualLineCount);
    expect(node.y).toBeLessThan(edge());
    expect(node.y + node.height).toBeGreaterThan(edge());
    expect(app.state()?.follow).toBe(false);

    app.mockInput.pressEscape();
    await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.state()?.follow).toBe(true);
    expect(app.scroll.scrollTop).toBe(app.bottom());
    expect(node.y + node.height).toBeLessThanOrEqual(edge());
    expect(app.captureCharFrame()).toContain("src/app/cli-terminal.test.ts (<C-o> to expand)");
    expect(app.view.promptDrafts.a1).toBe("Unsent prompt");
    expect(app.prompt.cursorOffset).toBe(4);
    expect(app.sent).toEqual([]);
    expect(app.interrupted).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Visual/Text back steps preserve historical reading until the final exit", async () => {
  // Cancelling a selection or returning to Sections is not the same as leaving the reader.
  const app = await mount();
  try {
    await app.read();
    app.mockInput.pressEnter();
    app.mockInput.pressKey("v");
    await app.render();
    const position = app.scroll.scrollTop,
      selected = app.state()?.selectedId;
    app.mockInput.pressEscape();
    await app.render();
    expect(app.state()?.mode).toBe("text");
    expect(app.state()?.follow).toBe(false);
    expect(app.scroll.scrollTop).toBe(position);
    expect(app.state()?.selectedId).toBe(selected);
    app.mockInput.pressEscape();
    await app.render();
    expect(app.state()?.mode).toBe("sections");
    expect(app.state()?.follow).toBe(false);
    expect(app.scroll.scrollTop).toBe(position);

    app.mockInput.pressEscape();
    await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.state()?.follow).toBe(true);
    expect(app.scroll.scrollTop).toBe(app.bottom());
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Popup cancellation and ordinary prompt focus do not reset deliberately paused viewports", async () => {
  // Preserve intentional wheel reading and popup restoration instead of resuming on every focus event.
  const app = await mount();
  try {
    await app.read();
    await app.clipHeader();
    const position = app.scroll.scrollTop;
    pressLeader(app, "b");
    await app.render();
    app.mockInput.pressEscape();
    await app.render();
    expect(app.state()?.follow).toBe(false);
    expect(app.scroll.scrollTop).toBe(position);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("session-transcript");

    app.prompt.focus();
    await app.render();
    pressLeader(app, "b");
    await app.render();
    app.mockInput.pressEscape();
    await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.scroll.scrollTop).toBe(position);
    expect(app.state()?.follow).toBe(false);
    expect(app.view.promptDrafts.a1).toBe("Unsent prompt");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Following after explicit exit tracks new wrapped commands through terminal resizing", async () => {
  // Resume the scroll model so future output, not only the current screenshot, remains visible.
  const app = await mount();
  try {
    await app.read();
    await app.clipHeader();
    app.mockInput.pressEscape();
    await app.render();
    await app.update([
      ...sections(),
      {
        id: "new-command",
        kind: "tool",
        title: "bash",
        command: `${command} src/new-command-tail.test.ts`,
        text: "New output",
        status: "streaming",
      },
    ]);
    for (const width of [120, 60, 200]) {
      app.resize(width, 26);
      await app.render();
      const header = app.header();
      expect(app.state()?.follow).toBe(true);
      expect(app.scroll.scrollTop).toBe(app.bottom());
      expect(header.height).toBe(header.virtualLineCount);
      expect(header.y + header.height).toBeLessThanOrEqual(
        app.scroll.viewport.y + app.scroll.viewport.height,
      );
    }
    expect(app.captureCharFrame()).toContain("src/new-command-tail.test.ts");
    expect(app.view.promptDrafts.a1).toBe("Unsent prompt");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Explicit exit releases an owned mouse selection before resuming live output", async () => {
  // A native selection must not immediately re-pause the reader after its explicit exit.
  const app = await mount();
  try {
    const lines = app.captureCharFrame().split("\n"),
      y = lines.findIndex((line) => line.includes("Checking navigation"));
    const x = lines[y]!.indexOf("Checking navigation");
    expect(y).toBeGreaterThanOrEqual(0);
    await app.mockMouse.drag(x, y, x + 5, y);
    await app.render();
    expect(app.renderer.getSelection()?.isActive).toBe(true);
    expect(app.state()?.follow).toBe(false);
    pressLeader(app, "[");
    await app.render();
    app.mockInput.pressEscape();
    await app.render();

    expect(app.renderer.getSelection()?.isActive ?? false).toBe(false);
    expect(app.state()?.follow).toBe(true);
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.scroll.scrollTop).toBe(app.bottom());
    expect(app.view.promptDrafts.a1).toBe("Unsent prompt");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Held Esc after reader exit never becomes an Agent interruption", async () => {
  // One physical exit must not replay in the newly focused prompt while the Agent is working.
  const app = await mount(true);
  const raw = (sequence: string) => {
    const key = parseKeypress(sequence, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid Kitty key");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    await app.read();
    raw("\x1b[27u");
    raw("\x1b[27;1:2u");
    await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    expect(app.state()?.follow).toBe(true);
    expect(app.interrupted).toEqual([]);
    expect(app.sent).toEqual([]);
    expect(app.view.promptDrafts.a1).toBe("Unsent prompt");
    raw("\x1b[27;1:3u");
  } finally {
    await app.close();
  }
});
