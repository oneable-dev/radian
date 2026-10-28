import { expect, test } from "bun:test";
import { InputRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";

const surfaces = [
  { command: "/model", spinner: "model-loading", body: "model-results" },
  { command: "/accounts", spinner: "accounts-loading", body: "accounts-results" },
  { command: "/history", spinner: "history-loading", body: "history-results" },
  { command: "/dashboard", spinner: "dashboard-loading", body: "dashboard-history-body" },
];

test.each(surfaces)(
  "$command centers pending data and reveals errors without waiting for spinner tails",
  async ({ command, spinner, body }) => {
    // Each surface receives the same pending read, with no prepared cache or real network work.
    const clock = new ManualClock();
    const app = await createTestRenderer({ width: 120, height: 30, clock, kittyKeyboard: true });
    const pending = Promise.withResolvers<Result<never, ExpectedError>>();
    const selection = new WorkspaceSelection(demoWorkspace());
    const view = new Workbench(app.renderer, selection, {
      onNewSession() {},
      onCloseSession() {},
      onPrompt: () => ok(undefined),
      getSessionDetails: () => ({
        conversationId: "conversation",
        status: null,
        output: "",
        error: null,
      }),
      onListModels: () => pending.promise,
      onSelectModel: async () => ok(null),
      onAccountsRequest: () => pending.promise,
      onListHistory: () => pending.promise,
      onDashboard: () => pending.promise,
    });
    const node = (id: string) => app.renderer.root.findDescendantById(id)!;
    const render = async () => {
      await app.renderOnce();
      await app.renderOnce();
    };
    try {
      await render();

      const prompt = node("session-prompt") as InputRenderable;
      prompt.focus();
      prompt.value = command;
      app.mockInput.pressEnter();
      await render();

      // Both compact and wide popups center the complete indicator inside their actual content body.
      for (const width of [120, 60]) {
        app.resize(width, 30);
        await render();

        const feedback = node(`${spinner}-feedback`);
        const viewport = app.renderer.root.findDescendantById(body) ?? node("dashboard-body");

        expect(node(spinner).visible).toBe(true);
        expect(feedback.visible).toBe(true);
        expect(feedback.x).toBe(viewport.x + Math.floor((viewport.width - feedback.width) / 2));
        expect(feedback.y).toBe(viewport.y + Math.floor((viewport.height - 1) / 2));
        expect((node(`${spinner}-message`) as TextRenderable).visible).toBe(true);
        expect(node(spinner).y).toBe(node(`${spinner}-message`).y);
        if (command !== "/dashboard") {
          const field = node(spinner.replace("-loading", "-search-field"));
          expect(viewport.y).toBe(field.y + field.height);
        }
      }

      const focus = app.renderer.currentFocusedRenderable;

      // Domain failures replace the central load immediately while the shared minimum-visible tail finishes.
      pending.resolve(err(new InputError("Fixture lookup failed")));
      await render();
      expect(app.captureCharFrame()).toContain("Fixture lookup failed");
      expect((node(`${spinner}-message`) as TextRenderable).visible).toBe(false);
      expect(node(spinner).visible).toBe(true);
      expect(app.renderer.currentFocusedRenderable).toBe(focus);
      clock.advance(500);
      await render();
      expect(node(`${spinner}-feedback`).visible).toBe(false);
    } finally {
      pending.resolve(err(new InputError("Fixture closed")));
      view.dispose();
      await app.dispose();
    }
  },
);
