import { expect, test } from "bun:test";
import { InputRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";

const surfaces = [
  { command: "/model", spinner: "model-loading", body: "model-results", title: "Models" },
  {
    command: "/accounts",
    spinner: "accounts-loading",
    body: "accounts-results",
    title: "Accounts",
  },
  { command: "/history", spinner: "history-loading", body: "history-results", title: "History" },
  { command: "/dashboard", spinner: "dashboard-loading", body: "dashboard-history-body" },
];

test.each(surfaces)(
  "$command keeps pending feedback in its owning surface and reports failures immediately",
  async ({ command, spinner, body, title }) => {
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

      // Searchable popups keep activity beside their title, without loading prose or a status row.
      for (const width of [120, 60]) {
        app.resize(width, 30);
        await render();

        const feedback = node(`${spinner}-feedback`);
        const viewport = app.renderer.root.findDescendantById(body) ?? node("dashboard-body");

        expect(node(spinner).visible).toBe(true);
        expect(feedback.visible).toBe(true);
        if (title) {
          const field = node(spinner.replace("-loading", "-search-field"));
          const frame = app.captureCharFrame();
          const glyph = (node(spinner) as TextRenderable).plainText;
          expect(feedback.y).toBe(field.y);
          expect(frame.split("\n")[field.y]).toContain(` ${title} ${glyph} `);
          expect(frame).not.toMatch(/Loading (available models|accounts|saved sessions)/u);
          expect((node(`${spinner}-message`) as TextRenderable).visible).toBe(false);
          expect(viewport.y).toBe(field.y + field.height);
        } else {
          expect(feedback.x).toBe(viewport.x + Math.floor((viewport.width - feedback.width) / 2));
          expect(feedback.y).toBe(viewport.y + Math.floor((viewport.height - 1) / 2));
          expect((node(`${spinner}-message`) as TextRenderable).visible).toBe(true);
        }
      }

      const focus = app.renderer.currentFocusedRenderable;

      // Domain failures reach the shared notification immediately, without waiting for the spinner tail.
      pending.resolve(err(new InputError("Lookup failed")));
      await render();
      expect(app.captureCharFrame()).toContain("Lookup failed");
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
