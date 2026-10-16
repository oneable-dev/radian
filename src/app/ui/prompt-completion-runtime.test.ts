import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { createWorktreeFixture } from "../../testing/worktree-fixture.ts";
import { connectRuntime, fetchSnapshot } from "../../runtime/client.ts";
import { runtimePaths } from "../../runtime/storage.ts";
import { expectOk } from "../../testing/results.ts";

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Completion runtime observation timed out"); await Bun.sleep(15); }
}

test("실제 UI·Unix IPC·SDK 자동완성은 첫 Enter에서 삽입만 하고 다음 Enter에서만 명령을 실행한다", async () => {
  // Real native rendering and a separate offline SDK process; no external provider or user service is touched.
  const fixture = await createWorktreeFixture();
  const options = { offline: true, stateRoot: join(fixture.directory, "state"), entry: join(import.meta.dir, "..", "..", "index.ts") };
  const paths = runtimePaths(fixture.repository.id, true, options.stateRoot);
  const extensions = join(paths.directory, "offline-agent", "extensions"); await mkdir(extensions, { recursive: true });
  await writeFile(join(extensions, "probe.ts"), `export default function (pi) {
    pi.registerCommand("completion-probe", { description: "Runtime completion marker", handler: async () => { pi.sendMessage({ customType: "completion-probe", content: "COMMAND_PROBE_EXECUTED", display: true }); } });
  }`);
  const client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
  if (!client) throw new Error("Missing fixture runtime");
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const main = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
  const id = expectOk(await client.create(main.id));
  const selection = new WorkspaceSelection(client.snapshot.repositories);
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {},
    onPrompt: (sessionId, text) => client.prompt(sessionId, text), onComplete: (sessionId, query, signal) => client.complete(sessionId, query, signal),
    getSessionDetails: (sessionId) => client.snapshot.details[sessionId] ?? null,
  });
  const unsubscribe = client.subscribe(() => selection.replaceSnapshot(client.snapshot.repositories));
  const visible = (text: string) => until(async () => { await app.renderOnce(); return app.captureCharFrame().includes(text); });
  try {
    await until(() => selection.snapshot[0]?.worktrees.some((tree) => tree.sessions.some((session) => session.id === id)) ?? false);
    selection.selectSession(main.id, id); await app.renderOnce(); app.mockInput.pressKey("e", { ctrl: true });
    const input = app.renderer.root.findDescendantById("session-prompt") as InputRenderable;
    await app.mockInput.typeText("@work"); await visible("workspace.txt");
    app.mockInput.pressEnter(); await app.renderOnce();
    expect(input.value).toBe("@workspace.txt "); expect(client.snapshot.details[id]?.output).toBe("");

    input.value = ""; await app.mockInput.typeText("/completion-pro"); await visible("Runtime completion marker");
    app.mockInput.pressEnter(); await app.renderOnce();
    expect(input.value).toBe("/completion-probe "); expect(app.captureCharFrame()).not.toContain("COMMAND_PROBE_EXECUTED");
    app.mockInput.pressEnter(); await visible("COMMAND_PROBE_EXECUTED");
    expect(input.value).toBe(""); expect(client.snapshot.details[id]?.status).not.toBe("working");
  } finally {
    unsubscribe(); view.dispose(); await app.dispose();
    expectOk(await client.stopRuntime()); await client.disconnect();
    await until(async () => !expectOk(await fetchSnapshot(paths))); await fixture.cleanup();
  }
}, 20000);
