import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { WorkspaceView, type WorkspaceActions } from "./workspace.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { ConnectionError, InputError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

async function mount(onPrompt: NonNullable<WorkspaceActions["onPrompt"]>) {
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const selection = new WorkspaceSelection(demoWorkspace());
  const view = new WorkspaceView(app.renderer, selection, {
    onNewSession: () => {}, onCloseSession: () => {}, onPrompt,
    getSessionDetails: () => ({ status: "working", output: "Existing run", error: null }),
  });
  await app.renderOnce();
  app.mockInput.pressKey("e", { ctrl: true });
  return { ...app, selection, view, async close() { view.dispose(); await app.dispose(); } };
}

test("수락 전 연속 Enter는 중복 전송하지 않고 거절된 초안을 보존한다", async () => {
  // A delayed transport result makes input acceptance independent from the existing run.
  const pending = Promise.withResolvers<Result<void, ExpectedError>>();
  const sent: string[] = [];
  const app = await mount((_id, text) => { sent.push(text); return pending.promise; });
  try {
    await app.mockInput.typeText("review this");
    app.mockInput.pressEnter(); app.mockInput.pressEnter();
    await app.renderOnce();
    expect(app.view.promptDrafts.a1).toBe("review this");

    // Rejection preserves the only copy of the user's input.
    pending.resolve(err(new InputError("Rejected before acceptance")));
    await app.waitForFrame((frame) => frame.includes("Rejected before acceptance"));
    expect(sent).toEqual(["review this"]);
    expect(app.view.promptDrafts.a1).toBe("review this");
    expect(app.captureCharFrame()).toContain("Rejected before acceptance");
  } finally { await app.close(); }
});

test("전송 수락은 대기 중 새로 작성한 입력을 지우지 않는다", async () => {
  // A user can keep typing while an earlier prompt is being admitted.
  const pending = Promise.withResolvers<Result<void, ExpectedError>>();
  const app = await mount(() => pending.promise);
  try {
    await app.mockInput.typeText("first"); app.mockInput.pressEnter();
    await app.mockInput.typeText(" plus next");

    // Acceptance belongs to the captured prompt, not whatever the editor now contains.
    pending.resolve(ok(undefined)); await app.renderOnce();
    expect(app.view.promptDrafts.a1).toBe("first plus next");
    expect(app.captureCharFrame()).toContain("first plus next");
  } finally { await app.close(); }
});

test("전송 결과 불확실성은 입력을 보존하고 snapshot 갱신으로 재전송하지 않는다", async () => {
  // A timeout cannot prove whether the remote runtime accepted the request.
  let calls = 0;
  const app = await mount(() => { calls++; return err(new ConnectionError("CONNECTION_TIMEOUT", "Action outcome is unknown")); });
  try {
    await app.mockInput.typeText("do not replay"); app.mockInput.pressEnter(); await app.renderOnce();

    // A reconnect-style display update is not another user submission.
    app.selection.replaceSnapshot(app.selection.snapshot); await app.renderOnce();
    expect(calls).toBe(1);
    expect(app.view.promptDrafts.a1).toBe("do not replay");
    expect(app.captureCharFrame()).toContain("outcome is unknown");
  } finally { await app.close(); }
});
