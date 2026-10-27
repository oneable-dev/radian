import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { tinyPng } from "../testing/image.ts";
import { fixtureMessage } from "../testing/offline-runtime.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { SessionTranscript } from "../agents/transcript.ts";
import { imageNamesEntryType } from "../agents/transcript-images.ts";
import { connectRuntime, fetchSnapshot, type RuntimeClient } from "./client.ts";
import { emptyPreferences, protocolVersion } from "./protocol.ts";
import { RuntimeStore, runtimePaths, privateDirectory } from "./storage.ts";

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Image runtime observation timed out");
    await Bun.sleep(15);
  }
}

test("Real Unix IPC exposes no originals in snapshots and explicitly reads only selected-conversation images", async () => {
  // Seed a finalized SDK history, then start only a private offline runtime. No provider or user runtime is used.
  const fixture = await createWorktreeFixture(),
    options = {
      offline: true,
      stateRoot: join(fixture.directory, "state"),
      entry: join(import.meta.dir, "..", "index.ts"),
    };
  const main = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
  const paths = runtimePaths(fixture.repository.id, true, options.stateRoot),
    id = "image-session";
  let client: RuntimeClient | null = null;
  try {
    const manager = SessionManager.create(fixture.main, join(fixture.directory, "sessions"));
    const block = {
      type: "image" as const,
      mimeType: "image/png",
      data: tinyPng().toString("base64"),
    };
    const transcript = new SessionTranscript([]);
    manager.appendCustomEntry(
      imageNamesEntryType,
      transcript.rememberImages([block], ["/private/screens/screenshot.png"]),
    );
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[Image #1] Inspect this" }, block],
      timestamp: 1,
    });
    manager.appendMessage({
      ...fixtureMessage("openai-completions", "radian-offline", "fixture"),
      content: [{ type: "text", text: "Fixture answer" }],
    });
    await privateDirectory(paths.directory);
    expectOk(
      await new RuntimeStore(paths).save({
        version: protocolVersion,
        repositoryId: fixture.repository.id,
        repositories: [fixture.repository],
        preferences: structuredClone(emptyPreferences),
        records: [
          {
            id,
            name: "Image fixture",
            worktreeId: main.id,
            sessionFile: manager.getSessionFile()!,
            state: { status: "complete", output: "Fixture answer", error: null },
            subagents: [],
          },
        ],
      }),
    );
    client = expectOk(await connectRuntime(fixture.repository, fixture.main, options));
    if (!client) throw new Error("Missing fixture runtime");
    const descriptor = client.snapshot.details[id]?.sections?.find(
      (section) => section.image,
    )?.image;
    expect(descriptor?.name).toBe("screenshot.png");
    expect(JSON.stringify(client.snapshot)).not.toContain(block.data);

    const pixels = expectOk(await client.image(id, descriptor!.id));
    expect(pixels).toEqual(tinyPng());
    expect(client.snapshot.details[id]?.status).toBe("complete");
    const other = expectOk(await client.create(main.id));
    expect(expectError(await client.image(other, descriptor!.id)).code).toBe("INVALID_INPUT");
    expect(expectError(await client.image(id, descriptor!.id, AbortSignal.abort())).code).toBe(
      "CANCELLED",
    );
    const wrongInstance = await fetch(
      `http://localhost/images?${new URLSearchParams({ sessionId: id, imageId: descriptor!.id }).toString()}`,
      { unix: paths.socket, headers: { "X-Radian-Instance": "stale" } },
    );
    expect(wrongInstance.status).toBe(422);
    await wrongInstance.body?.cancel();
    const arbitraryPath = await fetch(
      "http://localhost/images?sessionId=image-session&imageId=..%2Fprivate.png",
      { unix: paths.socket, headers: { "X-Radian-Instance": client.snapshot.instance } },
    );
    expect(arbitraryPath.status).toBe(400);
    await arbitraryPath.body?.cancel();
  } finally {
    if (client) {
      expectOk(await client.stopRuntime());
      await client.disconnect();
      await until(async () => !expectOk(await fetchSnapshot(paths)));
    }
    await fixture.cleanup();
  }
}, 20000);
