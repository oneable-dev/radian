import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { EditBufferRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createWorktreeFixture } from "../../testing/worktree-fixture.ts";
import { fetchSnapshot } from "../../runtime/client.ts";
import { connectRuntime } from "../../runtime/lifecycle.ts";
import { restoreWorkViews, saveWorkViews } from "../../runtime/work-view-preferences.ts";
import { RuntimeStore } from "../../runtime/storage.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";
import { expectOk } from "../../testing/results.ts";
import { ok } from "../../result.ts";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("Transcript runtime observation timed out");
    }

    await Bun.sleep(10);
  }
}

test("Real SDK/IPC folding, selection, and cursors restore the same run and source after TUI reconnection", async () => {
  // The daemon, SDK read tool, wire validation and native rendering are real; only copying is stubbed.
  const fixture = await createWorktreeFixture();
  const options = {
    offline: true,
    stateRoot: join(fixture.directory, "state"),
  };

  async function mount() {
    const client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
    if (!client) {
      throw new Error("Missing runtime");
    }

    const worktree = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
    let id = client.snapshot.repositories[0]?.worktrees.find((tree) => tree.id === worktree.id)
      ?.sessions[0]?.id;
    if (!id) {
      id = expectOk(await client.create(worktree.id));
      expectOk(await client.prompt(id, "read"));
      await until(() => client.snapshot.details[id!]?.status === "complete");
      expectOk(
        await client.savePreferences({
          ...client.snapshot.preferences,
          selection: { worktreeId: worktree.id, sessions: { [worktree.id]: id } },
          drafts: { [id]: "warm draft" },
        }),
      );
      await until(() => client.snapshot.preferences.drafts[id!] === "warm draft");
    }

    const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
    const selection = new WorkspaceSelection(client.snapshot.repositories);
    const preferences = structuredClone(client.snapshot.preferences);

    selection.restore(preferences.selection);

    let pending = Promise.resolve();
    const copies: string[] = [];
    const view = new Workbench(app.renderer, selection, {
      onNewSession: () => {},
      onCloseSession: () => {},
      onPrompt: (id, text) => client.prompt(id, text),
      getSessionDetails: (id) => client.snapshot.details[id] ?? null,
      initialDrafts: preferences.drafts,
      initialWorkViews: restoreWorkViews(preferences),
      onWorkViewsChange: (state) => {
        saveWorkViews(preferences, state);
        const copy = structuredClone(preferences);
        pending = pending.then(async () => {
          expectOk(await client.savePreferences(copy));
        });
      },
      onCopyTranscript: async (text) => {
        copies.push(text);

        return ok("Copied to clipboard");
      },
    });
    const unsubscribe = client.subscribe(() =>
      selection.replaceSnapshot(client.snapshot.repositories),
    );
    const render = async () => {
      await app.renderOnce();
      await app.renderOnce();
    };

    await render();

    return {
      ...app,
      client,
      view,
      id,
      copies,
      render,
      async close() {
        unsubscribe();
        view.dispose();
        await pending;
        await client.disconnect();
        await app.dispose();
      },
    };
  }

  let app: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    app = await mount();
    expect(app.client.snapshot.capabilities).toContain("agent-transcript");

    const pid = app.client.snapshot.pid;
    const id = app.id;
    const sections = app.client.snapshot.details[id]!.sections!;
    const toolIndex = sections.findIndex((section) => section.kind === "tool");

    expect(toolIndex).toBeGreaterThan(0);
    await until(
      async () =>
        !!expectOk(
          await new RuntimeStore(app!.client.paths).load(fixture.repository.id),
        )?.records.some((record) => record.id === id && record.sessionFile),
    );

    const manifest = expectOk(await new RuntimeStore(app.client.paths).load(fixture.repository.id));
    if (!manifest) {
      throw new Error("Missing runtime manifest");
    }

    const file = manifest.records.find((record) => record.id === id)!.sessionFile!;
    const originalHistory = await Bun.file(file).text();

    pressLeader(app, "[");
    app.mockInput.pressKey("HOME");
    for (let index = 0; index < toolIndex; index++) {
      app.mockInput.pressKey("j");
    }

    app.mockInput.pressKey("o", { ctrl: true });
    app.mockInput.pressEnter();
    app.mockInput.pressKey("v");
    app.mockInput.pressKey("l");
    app.mockInput.pressKey("y");
    await app.render();
    app.mockInput.pressKey("l");
    await app.render();
    expect(app.copies).toEqual(["Ar"]);
    expect(app.view.workViewPreferences.agentViews?.[id]?.cursors[sections[toolIndex]!.id]).toBe(2);
    app.mockInput.pressKey("v", { shift: true });
    await app.render();
    expect((app.renderer.currentFocusedRenderable as EditBufferRenderable).getSelectedText()).toBe(
      "Arguments:\n",
    );
    await app.close();
    app = undefined;

    // A new UI uses serialized preferences and the same live SDK section IDs, not prior renderables.
    app = await mount();
    pressLeader(app, "[");
    await app.render();

    expect(app.client.snapshot.pid).toBe(pid);
    expect(app.id).toBe(id);
    expect(app.view.workViewPreferences.agentViews?.[id]?.selectedId).toBe(sections[toolIndex]!.id);
    expect(app.view.workViewPreferences.agentViews?.[id]?.folded[sections[toolIndex]!.id]).toBe(
      false,
    );
    expect((app.renderer.currentFocusedRenderable as EditBufferRenderable).cursorOffset).toBe(2);
    expect(app.view.workViewPreferences.agentViews?.[id]?.linewise).toBe(true);
    expect((app.renderer.currentFocusedRenderable as EditBufferRenderable).getSelectedText()).toBe(
      "Arguments:\n",
    );
    expect(app.view.promptDrafts[id]).toBe("warm draft");
    expect(await Bun.file(file).text()).toBe(originalHistory);

    // Folded text focus also survives a real IPC preference round-trip, independently of body position.
    app.mockInput.pressKey("o", { ctrl: true });
    app.mockInput.pressEnter();
    app.mockInput.pressKey("l");
    await app.render();
    expect(
      app.view.workViewPreferences.agentViews?.[id]?.headingCursors?.[sections[toolIndex]!.id],
    ).toBe(1);
    await app.close();
    app = undefined;
    app = await mount();
    pressLeader(app, "[");
    await app.render();

    const heading = app.renderer.currentFocusedRenderable as EditBufferRenderable;
    expect(heading.plainText.startsWith("[read] ")).toBe(true);
    expect(heading.plainText).not.toContain(" · complete");
    expect(heading.cursorOffset).toBe(1);
    expect(app.view.workViewPreferences.agentViews?.[id]?.cursors[sections[toolIndex]!.id]).toBe(2);
    expect(app.renderer.getCursorState().visible).toBe(true);
    expect(app.client.snapshot.pid).toBe(pid);
    expect(await Bun.file(file).text()).toBe(originalHistory);
  } finally {
    await app?.close();

    const admin = expectOk(
      await connectRuntime(fixture.repository, fixture.main, { ...options, start: false }),
    );
    if (admin) {
      expectOk(await admin.stopRuntime());
      await admin.disconnect();
      await until(async () => !expectOk(await fetchSnapshot(admin.paths)));
    }

    await fixture.cleanup();
  }
}, 25000);
