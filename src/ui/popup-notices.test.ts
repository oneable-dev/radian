import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { AccountsPanel } from "../accounts/panel.ts";
import { SessionHistoryPanel } from "../agents/ui/history-panel.ts";
import { ModelPicker } from "../agents/ui/model-picker.ts";
import type { ModelCatalog } from "../agents/model-selection.ts";
import { InputError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { demoWorkspace } from "../workspace/demo.ts";

test.each(["models", "accounts", "history"] as const)(
  "%s reports cached lookup failures once instead of restoring a status row on every update",
  async (surface) => {
    // Prepared failures can be replayed by unrelated workbench updates without a new user action.
    const app = await createTestRenderer({ width: 100, height: 24, clock: new ManualClock() });
    const notices: string[] = [];
    const failure = err(new InputError("Fixture lookup failed"));
    const common = {
      cached: () => failure,
      notice: (text: string) => {
        notices.push(text);
      },
      changed() {},
      fallback() {},
      keyHint: () => "",
    };
    const tree = demoWorkspace()[0]!.worktrees[0]!;
    let popup: ModelPicker | AccountsPanel | SessionHistoryPanel;
    let show: () => void;
    if (surface === "models") {
      const models = new ModelPicker(app.renderer, common);
      popup = models;
      show = () => models.show({ sessionId: "session", conversationId: "conversation" });
    } else if (surface === "accounts") {
      const accounts = new AccountsPanel(app.renderer, common);
      popup = accounts;
      show = () => accounts.show(tree.id);
    } else {
      const history = new SessionHistoryPanel(app.renderer, {
        ...common,
        onError: common.notice,
        onOpened() {},
      });
      popup = history;
      show = () => history.show(tree);
    }
    app.renderer.root.add(popup.root);
    try {
      // One initial failure is observable through the shared notice boundary, not repeated background updates.
      show();
      for (let update = 0; update < 3; update++) {
        popup.updateData();
        await app.renderOnce();
      }
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("Fixture lookup failed");
      expect(app.captureCharFrame()).not.toMatch(/Loading|No saved sessions|No available models/u);

      // Reopening is an explicit attempt and must report the still-failing lookup again.
      popup.hide(false);
      show();
      expect(notices).toHaveLength(2);
    } finally {
      popup.dispose();
      await app.dispose();
    }
  },
);

test("Model application keeps candidates visible with title-only activity and notifies rejected changes", async () => {
  // A prepared catalog opens without loading, and only the explicit model change remains pending.
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 100, height: 24, clock });
  const pending = Promise.withResolvers<Result<string | null, ExpectedError>>();
  const notices: string[] = [];
  const catalog: ModelCatalog = {
    conversationId: "conversation",
    current: null,
    effort: "off",
    models: [
      {
        provider: "fixture",
        id: "model",
        name: "Ready model",
        contextWindow: 1000,
        images: false,
        reasoning: false,
        effort: "off",
        efforts: ["off"],
      },
    ],
  };
  let calls = 0;
  const picker = new ModelPicker(app.renderer, {
    cached: () => ok(catalog),
    select: () => {
      calls++;
      return pending.promise;
    },
    notice: (text) => {
      notices.push(text);
    },
    changed() {},
    fallback() {},
    keyHint: () => "",
  });
  app.renderer.root.add(picker.root);
  const render = async () => {
    await app.renderOnce();
    await app.renderOnce();
  };
  try {
    picker.show({ sessionId: "session", conversationId: "conversation" });
    await render();
    expect(app.captureCharFrame()).not.toContain("⠋");

    // Repeated acceptance cannot submit another action while the first change is still settling.
    picker.command("model.select");
    picker.command("model.select");
    await render();
    expect(calls).toBe(1);
    expect(picker.changing).toBe(true);
    expect(app.captureCharFrame()).toContain(" ⠋ Models ");
    expect(app.captureCharFrame()).toContain("Ready model");
    expect(app.captureCharFrame()).not.toContain("Applying model");
    expect(picker.list.y).toBe(picker.search.field.y + picker.search.field.height);

    // Rejection leaves the candidate available for retry and reports the failure through shared notices.
    pending.resolve(err(new InputError("Model change rejected")));
    await render();
    expect(notices).toEqual(["[INVALID_INPUT] Model change rejected"]);
    expect(picker.changing).toBe(false);
    expect(picker.visible).toBe(true);
    expect(app.captureCharFrame()).toContain("Ready model");
    clock.advance(500);
    await render();
    expect(picker.search.field.title).toBe(" Models ");
  } finally {
    pending.resolve(err(new InputError("Fixture closed")));
    picker.dispose();
    await app.dispose();
  }
});
