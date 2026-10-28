import { expect, test } from "bun:test";
import type { Renderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Button } from "../../ui/button.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import { emptyDashboard } from "../../agents/dashboard.ts";
import { ok } from "../../result.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

const surfaces = [
  { name: "Workspace", panel: "workspace-sidebar", leader: "b" },
  { name: "History", panel: "history-dialog", leader: "h" },
  { name: "Monitor", panel: "monitor-dialog", leader: "s" },
  { name: "Usage", panel: "dashboard-panel", leader: "u" },
  { name: "Model", panel: "model-dialog", command: "/model" },
  { name: "Accounts", panel: "accounts-dialog", command: "/accounts" },
  { name: "Help", panel: "text-dialog-panel", help: true },
] as const;
const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)];
const within = (node: Renderable | null, parent: Renderable): boolean => {
  for (let current = node; current; current = current.parent as Renderable | null) {
    if (current === parent) {
      return true;
    }
  }

  return false;
};

test.each(surfaces)(
  "$name popups trap focus and restore input with Esc without popup chrome buttons",
  async (surface) => {
    // Use real Workbench and replace only external lookups; compact layouts share command contracts.
    const app = await createTestRenderer({
      width: 120,
      height: 30,
      kittyKeyboard: true,
      clock: new ManualClock(),
    });
    const sent: string[] = [];
    const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), {
      onNewSession() {},
      onCloseSession() {},
      onPrompt: (_id, text) => {
        sent.push(text);

        return ok(undefined);
      },
      getSessionDetails: () => ({
        conversationId: "fixture",
        status: "complete",
        error: null,
        output: "Retained output",
      }),
      onListHistory: async () => ok([]),
      onDashboard: async (days) => ok(emptyDashboard(days)),
      onListModels: async () =>
        ok({
          conversationId: "fixture",
          current: { provider: "fixture", id: "model" },
          effort: "off",
          models: [
            {
              provider: "fixture",
              id: "model",
              name: "Fixture model",
              images: false,
              contextWindow: 64000,
              reasoning: false,
              efforts: ["off"],
              effort: "off",
            },
          ],
        }),
      onSelectModel: async () => ok(null),
      onAccountsRequest: async (request) =>
        ok({
          kind: "catalog",
          catalog: {
            revision: 1,
            worktreeId: request.worktreeId,
            accounts: [],
            providers: [],
            selections: {},
          },
        }),
    });
    const get = (id: string) => {
      const node = app.renderer.root.findDescendantById(id);
      if (!node) {
        throw new Error(`Missing ${id}`);
      }

      return node;
    };
    const render = async () => {
      for (let i = 0; i < 8; i++) {
        await Promise.resolve();
      }

      await app.renderOnce();
      await app.renderOnce();
    };
    try {
      await render();

      const input = get("session-prompt");
      if (!(input instanceof PromptInput)) {
        throw new Error("Missing prompt");
      }

      input.focus();
      input.value = "Retained draft";
      if ("command" in surface) {
        input.value = surface.command;
        app.mockInput.pressEnter();
      } else if ("leader" in surface) {
        app.mockInput.pressKey(" ", { ctrl: true });
        app.mockInput.pressKey(surface.leader);
      } else {
        app.mockInput.pressKey("F1");
      }

      await render();

      const draft = input.draft;

      // Resize and Tab direction changes navigate content, search, and state choices instead of buttons.
      for (const [width, height] of [
        [120, 30],
        [60, 16],
      ] as const) {
        app.resize(width, height);
        await render();

        const panel = get(surface.panel);
        expect(panel.visible).toBe(true);
        expect(
          app
            .captureCharFrame()
            .split("\n")
            [panel.y]?.slice(panel.x, panel.x + panel.width),
        ).not.toContain("×");

        // A faithful session preview includes inert tab close glyphs, not popup close controls.
        const buttons = walk(panel).filter((node): node is Button => node instanceof Button);
        const previewClose = (node: Button) => node.id.startsWith("history-preview-close-session:");

        expect(
          buttons.filter((node) => !node.id.startsWith("model-effort:") && !previewClose(node)),
        ).toEqual([]);
        for (const button of buttons.filter(previewClose)) {
          expect(button.focusable).toBe(false);
        }
        for (let i = 0; i < 4; i++) {
          app.mockInput.pressTab({ shift: i % 2 === 1 });
          await render();
          expect(within(app.renderer.currentFocusedRenderable, panel)).toBe(true);
        }
      }

      app.mockInput.pressEscape();
      await render();

      // Closing restores original input ownership without submission or editing.
      expect(app.renderer.currentFocusedRenderable).toBe(input);
      expect(input.draft).toEqual(draft);
      expect(get(surface.panel).parent?.visible).toBe(false);
      expect(sent).toEqual([]);
    } finally {
      view.dispose();
      await app.dispose();
    }
  },
);
