import { expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createTestRenderer } from "@opentui/core/testing";
import { join } from "node:path";
import { GitRepository } from "../git/repository.ts";
import { SessionRegistry } from "../sessions/session-registry.ts";
import { piSessionFactory } from "../sessions/pi-session-adapter.ts";
import { offlineRuntime, fixtureMessage } from "../testing/offline-runtime.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectOk } from "../testing/results.ts";
import { WorkspaceSelection } from "../workspace/selection.ts";
import { ok, type Result } from "../result.ts";
import type { ExpectedError } from "../errors.ts";
import { WorkspaceView } from "./workspace.ts";

test("실제 Git 커밋의 a 요청은 같은 SDK 세션에 대기하고 Git 화면과 Agent 초안을 유지한다", async () => {
  // Only provider output is controlled: repository, Git process, SDK queue and TUI are real.
  const fixture = await createWorktreeFixture();
  const options = await offlineRuntime(join(fixture.directory, "agent"));
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const modelInputs: string[] = [];
  const registry = new SessionRegistry([fixture.repository], piSessionFactory({ ...options, streamFn: (model, context, request) => {
    const user = context.messages.findLast((message) => message.role === "user");
    const text = user?.role === "user" ? typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
    modelInputs.push(text);
    if (text !== "hold initial response") return options.streamFn!(model, context, request);
    const stream = createAssistantMessageEventStream(), message = fixtureMessage(model.api, model.provider, model.id);
    stream.push({ type: "start", partial: message }); started.resolve();
    const finish = () => { message.content = [{ type: "text", text: "Initial response finished" }]; stream.push({ type: "done", reason: "stop", message }); stream.end(); };
    void release.promise.then(finish);
    return stream;
  } }));
  const app = await createTestRenderer({ width: 180, height: 32, kittyKeyboard: true });
  const selection = new WorkspaceSelection(registry.snapshot);
  const unsubscribe = registry.subscribe(() => selection.replaceSnapshot(registry.snapshot));
  let view: WorkspaceView | undefined;
  try {
    const worktree = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
    const id = expectOk(await registry.create(worktree.id));
    const running = registry.prompt(id, "hold initial response"); await started.promise;
    const source = new GitRepository(fixture.main);
    const snapshot = expectOk(await source.load(null, 300, new AbortController().signal));
    const selected = snapshot.commits[0]!;
    const submit = (session: string, text: string) => {
      const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
      void registry.prompt(session, text, () => accepted.resolve(ok(undefined))).then(accepted.resolve, accepted.reject);
      return accepted.promise;
    };
    view = new WorkspaceView(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {}, onPrompt: submit,
      initialDrafts: { [id]: "Unsent Agent draft" }, getSessionDetails: (session) => registry.details(session),
      git: { source: () => source, createSession: (tree) => registry.create(tree), prompt: submit, copy: async () => ok("unused") } });
    await app.renderOnce();
    const click = async (text: string) => {
      const lines = app.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes(text)), x = lines[y]?.indexOf(text) ?? -1;
      if (x < 0) throw new Error(`Missing ${text}\n${app.captureCharFrame()}`);
      await app.mockMouse.click(x + 1, y); await app.renderOnce();
    };
    await click("Git"); await app.waitForFrame((frame) => frame.includes(selected.subject)); await click(selected.subject);

    // Admission must finish while the original response remains deliberately held.
    app.mockInput.pressKey("a"); await app.renderOnce(); await app.mockInput.typeText("Review selected commit"); app.mockInput.pressEnter();
    await app.waitFor(() => app.renderer.currentFocusedRenderable?.id === "git-history");
    expect(modelInputs).toEqual(["hold initial response"]);
    expect(registry.details(id)?.status).toBe("working");
    expect(view.workViewPreferences.active[worktree.id]).toBe("git"); expect(view.promptDrafts[id]).toBe("Unsent Agent draft");
    release.resolve(); expectOk(await running);

    // Pi consumes the exact hash-only context on the original session's next response.
    expect(modelInputs[1]).toBe(`Review selected commit\n\nGit context (quoted data):\n${JSON.stringify(selected.oid)}`);
    expect(registry.snapshot[0]!.worktrees.find((tree) => tree.id === worktree.id)!.sessions).toHaveLength(1);
    expect(view.workViewPreferences.active[worktree.id]).toBe("git");
  } finally {
    release.resolve(); view?.dispose(); unsubscribe(); await registry.shutdown(); await app.dispose(); await fixture.cleanup();
  }
});
