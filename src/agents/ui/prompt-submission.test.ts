import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "../../app/ui/workbench.ts";
import { WorkspaceSelection } from "../../app/workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { ConnectionError, InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";

async function mount(onPrompt: NonNullable<WorkbenchActions["onPrompt"]>) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    onPrompt,
    getSessionDetails: () => ({ status: "working", output: "Existing run", error: null }),
  });

  await app.renderOnce();
  pressLeader(app, "a");

  return {
    ...app,
    selection,
    view,
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Repeated Enter before acceptance never duplicates submissions and rejection preserves drafts", async () => {
  // A delayed transport result makes input acceptance independent from the existing run.
  const pending = Promise.withResolvers<Result<void, ExpectedError>>();
  const sent: string[] = [];
  const app = await mount((_id, text) => {
    sent.push(text);

    return pending.promise;
  });
  try {
    await app.mockInput.typeText("review this");
    app.mockInput.pressEnter();
    app.mockInput.pressEnter();
    await app.renderOnce();
    expect(app.view.promptDrafts.a1).toBe("review this");

    // Rejection preserves the only copy of the user's input.
    pending.resolve(err(new InputError("Rejected before acceptance")));
    await app.waitForFrame((frame) => frame.includes("Rejected before acceptance"));
    expect(sent).toEqual(["review this"]);
    expect(app.view.promptDrafts.a1).toBe("review this");
    expect(app.captureCharFrame()).toContain("Rejected before acceptance");
  } finally {
    await app.close();
  }
});

test("Accepted submissions never clear input written while awaiting acceptance", async () => {
  // A user can keep typing while an earlier prompt is being admitted.
  const pending = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount(() => pending.promise);
  try {
    await app.mockInput.typeText("first");
    app.mockInput.pressEnter();
    await app.mockInput.typeText(" plus next");

    // Acceptance belongs to the captured prompt, not whatever the editor now contains.
    pending.resolve(ok(undefined));
    await app.renderOnce();
    expect(app.view.promptDrafts.a1).toBe("first plus next");
    expect(app.captureCharFrame()).toContain("first plus next");
  } finally {
    await app.close();
  }
});

test("Uncertain submission outcomes preserve input and snapshot refreshes never resend", async () => {
  // A timeout cannot prove whether the remote runtime accepted the request.
  let calls = 0;
  const app = await mount(() => {
    calls++;

    return err(new ConnectionError("CONNECTION_TIMEOUT", "Action outcome is unknown"));
  });
  try {
    await app.mockInput.typeText("do not replay");
    app.mockInput.pressEnter();
    await app.renderOnce();

    // A reconnect-style display update is not another user submission.
    app.selection.replaceSnapshot(app.selection.snapshot);
    await app.renderOnce();
    expect(calls).toBe(1);
    expect(app.view.promptDrafts.a1).toBe("do not replay");
    expect(app.captureCharFrame()).toContain("outcome is unknown");
  } finally {
    await app.close();
  }
});
