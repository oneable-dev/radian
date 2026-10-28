import { pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { CompletionCache } from "../../agents/completion-cache.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { fetchSnapshot, type RuntimeClient } from "../../runtime/client.ts";
import { connectRuntime } from "../../runtime/lifecycle.ts";
import { runtimePaths } from "../../runtime/storage.ts";
import { createWorktreeFixture } from "../../testing/worktree-fixture.ts";
import { expectOk } from "../../testing/results.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("Catalog runtime observation timed out");
    }

    await Bun.sleep(15);
  }
}

test("Real UI/IPC/SDK reuse full catalogs across reload, file moves, and dollar invocation", async () => {
  // Use isolated worktrees, Unix sockets, and offline SDK instead of user runtimes/models.
  const fixture = await createWorktreeFixture();
  const options = {
    offline: true,
    stateRoot: join(fixture.directory, "state"),
  };
  const paths = runtimePaths(fixture.repository.id, true, options.stateRoot);
  const extensions = join(paths.directory, "offline-agent", "extensions");
  const skills = join(fixture.directory, "skills");
  let client: RuntimeClient | null = null;
  let app: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
  let cache: CompletionCache | undefined;
  let view: Workbench | undefined;
  let unsubscribe: (() => void) | undefined;
  const unexpected: unknown[] = [];
  const sent: string[] = [];
  let catalogs = 0;
  try {
    await mkdir(extensions, { recursive: true });
    await mkdir(skills);
    await writeFile(
      join(extensions, "catalog.ts"),
      `export default function(pi) {
      for (let i = 0; i < 150; i++) pi.registerCommand("catalog-" + i, { description: "Catalog marker " + i, handler: async () => {} });
      pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(skills)}] }));
    }`,
    );
    client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
    if (!client) {
      throw new Error("Missing fixture runtime");
    }

    const runtime = client;
    const main = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
    const id = expectOk(await runtime.create(main.id));

    await until(() => !!runtime.snapshot.details[id]?.conversationId);

    const originalConversation = runtime.snapshot.details[id]!.conversationId;
    expect(expectOk(await runtime.catalog(id)).items.length).toBeGreaterThan(150);
    app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });

    const renderer = app;
    const selection = new WorkspaceSelection(runtime.snapshot.repositories);

    cache = new CompletionCache(
      (sessionId, signal) => {
        catalogs++;

        return runtime.catalog(sessionId, signal);
      },
      (sessionId) => {
        const state = runtime.snapshot.details[sessionId];

        return JSON.stringify([
          runtime.snapshot.instance,
          state?.conversationId,
          state?.resourceRevision ?? 0,
        ]);
      },
      (error) => unexpected.push(error),
    );

    const completions = cache;
    view = new Workbench(renderer.renderer, selection, {
      onNewSession() {},
      onCloseSession() {},
      onComplete: completions.provider,
      onPrompt: async (sessionId, text) => {
        sent.push(text);
        const result = await runtime.prompt(sessionId, text);

        return result.ok && text === "/reload" ? completions.refresh(sessionId) : result;
      },
      getSessionDetails: (sessionId) => runtime.snapshot.details[sessionId] ?? null,
    });
    unsubscribe = runtime.subscribe(() => selection.replaceSnapshot(runtime.snapshot.repositories));
    selection.selectSession(main.id, id);
    await renderer.renderOnce();
    pressLeader(renderer, "a");

    const input = renderer.renderer.root.findDescendantById("session-prompt");
    if (!(input instanceof PromptInput)) {
      throw new Error("Missing prompt");
    }

    const visible = (text: string) =>
      until(async () => {
        await renderer.renderOnce();

        return renderer.captureCharFrame().includes(text);
      });
    await until(
      () => completions.provider.read?.(id, { kind: "command", query: "catalog-149" })?.ok === true,
    );

    // Search past the hundredth command without extra lookups during repeated typing.
    await renderer.mockInput.typeText("/catalog-149");
    await visible("Catalog marker 149");
    expect(catalogs).toBe(1);
    expect(runtime.snapshot.details[id]?.output).toBe("");
    expect(renderer.renderer.root.findDescendantById("completion-loading")!.visible).toBe(false);
    input.value = "/catalog-14";
    await renderer.renderOnce();
    input.value = "/catalog-149";
    await renderer.renderOnce();
    expect(catalogs).toBe(1);
    expect(sent).toEqual([]);

    // New resources appear in real SDK and UI catalogs together after /reload.
    await mkdir(join(skills, "new-skill"));
    await writeFile(
      join(skills, "new-skill", "SKILL.md"),
      "---\nname: new-skill\ndescription: Fresh skill marker\n---\nNEW_SKILL_INSTRUCTIONS\n",
    );
    input.value = "/reload";
    await renderer.renderOnce();
    renderer.mockInput.pressEnter();
    await until(async () => {
      await renderer.renderOnce();

      return input.value === "" && runtime.snapshot.details[id]?.resourceRevision === 1;
    });
    expect(catalogs).toBe(2);
    expect(runtime.snapshot.details[id]?.conversationId).toBe(originalConversation);
    expect(runtime.snapshot.details[id]?.output).toBe("");

    // Server revision checks reject another UI's stale catalog commands before model delivery.
    const stale = await fetch("http://localhost/command", {
      unix: paths.socket,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Radian-Instance": runtime.snapshot.instance,
      },
      body: JSON.stringify({
        type: "prompt",
        sessionId: id,
        conversationId: originalConversation,
        resourceRevision: 0,
        text: "/catalog-149",
      }),
    });
    expect(stale.status).toBe(409);
    input.value = "$new";
    await visible("Fresh skill marker");
    renderer.mockInput.pressTab();
    await renderer.renderOnce();
    expect(input.value).toBe("$new-skill ");
    expect(sent).toEqual(["/reload"]);

    // File watchers update new and moved paths while preserving open queries.
    input.value = "@fresh-path";
    await renderer.renderOnce();
    await writeFile(join(fixture.main, "fresh-path.ts"), "file");
    await visible("fresh-path.ts");
    await rename(join(fixture.main, "fresh-path.ts"), join(fixture.main, "renamed-path.ts"));
    input.value = "@renamed-path";
    await visible("renamed-path.ts");
    renderer.mockInput.pressTab();
    await renderer.renderOnce();
    expect(input.submission.text).toBe(
      `@${JSON.stringify(join(fixture.main, "renamed-path.ts"))} `,
    );
    expect(catalogs).toBe(2);
    expect(sent).toEqual(["/reload"]);

    // Dollar choices reach real server skill expansion, not merely display decoration.
    input.value = "$new-skill inspect this";
    await renderer.renderOnce();
    renderer.mockInput.pressEnter();
    await until(
      () =>
        runtime.snapshot.details[id]?.status === "complete" &&
        !!runtime.snapshot.details[id]?.sections?.some(
          (section) => section.skillName === "new-skill",
        ),
    );
    expect(sent).toEqual(["/reload", "$new-skill inspect this"]);
    expect(unexpected).toEqual([]);
  } finally {
    unsubscribe?.();
    view?.dispose();
    cache?.dispose();
    await app?.dispose();
    if (client) {
      expectOk(await client.stopRuntime());
      await client.disconnect();
      await until(async () => !expectOk(await fetchSnapshot(paths)));
    }

    await fixture.cleanup();
  }
}, 30000);
