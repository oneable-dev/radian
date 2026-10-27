import { expect, test } from "bun:test";
import { TextRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import { ok } from "../../result.ts";
import { spinnerFrames } from "../../icons.ts";

function visibleText(node: Renderable): string {
  if (!node.visible) return "";
  return (
    (node instanceof TextRenderable ? node.plainText : "") +
    node.getChildren().map(visibleText).join("")
  );
}
const loadingGlyphs = new RegExp(`[${spinnerFrames.join("")}▶▷]`, "u");

test.each([
  ["/model", "model-picker"],
  ["/history", "session-history"],
] as const)(
  "%s opens only popups without starting prompt or Fast-tab loading",
  async (command, modalId) => {
    // Query commands must not create run state even in idle Fast sessions.
    const clock = new ManualClock(),
      app = await createTestRenderer({ width: 120, height: 28, kittyKeyboard: true, clock });
    const repositories = demoWorkspace().map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.map((tree) => ({
        ...tree,
        sessions: tree.sessions.map((session) => ({ ...session, status: null, subagents: [] })),
      })),
    }));
    const selection = new WorkspaceSelection(repositories),
      sent: string[] = [];
    const view = new Workbench(app.renderer, selection, {
      onNewSession() {},
      onCloseSession() {},
      onPrompt: (_id, text) => {
        sent.push(text);
        return ok(undefined);
      },
      getSessionDetails: () => ({
        conversationId: "conversation",
        status: null,
        output: "",
        error: null,
        telemetry: {
          provider: "openai-codex",
          model: "fixture",
          effort: "high",
          fast: true,
          context: null,
          weekly: null,
        },
      }),
      onListModels: async (_id, conversationId) =>
        ok({ conversationId, current: null, effort: "off", models: [] }),
      onSelectModel: async () => ok(null),
      onListHistory: async () => ok([]),
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
    try {
      await render();
      const prompt = get("session-prompt");
      if (!(prompt instanceof PromptInput)) throw new Error("Missing Agent input");
      prompt.focus();
      prompt.value = command;

      // Enter and subsequent animation ticks must not create background activity.
      app.mockInput.pressEnter();
      await render();
      clock.advance(80);
      await render();

      // Distinguish modal data loading from Agent run loading.
      expect(get(modalId).visible).toBe(true);
      expect(prompt.value).toBe("");
      expect(sent).toEqual([]);
      expect(get("agent-run-loading").visible).toBe(false);
      expect(get("transcript-status-row").visible).toBe(false);
      const tab = get(`session:${selection.worktree!.id}:${selection.sessionId}`);
      expect(visibleText(tab)).not.toMatch(loadingGlyphs);
      app.mockInput.pressEscape();
      await render();
      expect(get("agent-run-loading").visible).toBe(false);
      expect(visibleText(tab)).not.toMatch(loadingGlyphs);
    } finally {
      view.dispose();
      await app.dispose();
    }
  },
);
