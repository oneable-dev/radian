import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { connectRuntime } from "./client.ts";
import { pidAlive } from "./storage.ts";

// Use only isolated services created here, never user credentials or services.
test("Real model-selection IPC preserves conversation/authentication runtimes without command-induced model requests", async () => {
  const fixture = await createWorktreeFixture();
  const connected = expectOk(
    await connectRuntime(fixture.repository, fixture.main, {
      offline: true,
      stateRoot: join(fixture.directory, "state"),
      entry: join(import.meta.dir, "..", "index.ts"),
    }),
  );
  if (!connected) {
    throw new Error("Missing fixture runtime");
  }
  try {
    const tree = fixture.repository.worktrees.find((tree) => tree.path === fixture.main)!;
    const session = expectOk(await connected.create(tree.id));

    // Query catalogs using conversation IDs supplied by session-creation snapshots.
    await new Promise<void>((resolve, reject) => {
      if (connected.snapshot.details[session]?.conversationId) {
        resolve();

        return;
      }

      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Missing session snapshot"));
      }, 8000);
      const unsubscribe = connected.subscribe(() => {
        if (!connected.snapshot.details[session]?.conversationId) {
          return;
        }

        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });

    const conversation = connected.snapshot.details[session]!.conversationId!;
    expect(connected.snapshot.capabilities).toContain("model-selection");
    expect(connected.snapshot.capabilities).toContain("model-effort");

    const catalog = expectOk(await connected.models(session, conversation));
    expect(catalog.current).toEqual({ provider: "radian-offline", id: "fixture" });
    expect(
      catalog.models.some((model) => model.provider === "radian-offline" && model.id === "fixture"),
    ).toBe(true);
    expect(catalog.effort).toBe("off");
    expect(
      catalog.models.find((model) => model.provider === "radian-offline" && model.id === "fixture")!
        .efforts,
    ).toEqual(["off"]);
    expectOk(
      await connected.selectModel(
        session,
        conversation,
        { provider: "radian-offline", id: "fixture" },
        "off",
      ),
    );
    expect(
      expectError(
        await connected.selectModel(
          session,
          conversation,
          { provider: "radian-offline", id: "fixture" },
          "high",
        ),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(
      expectError(
        await connected.selectModel(session, "old-conversation", {
          provider: "radian-offline",
          id: "fixture",
        }),
      ).code,
    ).toBe("SESSION_CONFLICT");
    expect(
      expectError(
        await connected.selectModel(session, conversation, { provider: "missing", id: "fixture" }),
      ).code,
    ).toBe("MODEL_UNAVAILABLE");
    expect(expectError(await connected.prompt(session, "/model")).code).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(
      connected.snapshot.details[session]!.sections?.some((section) => section.kind === "user"),
    ).toBe(false);
  } finally {
    const pid = connected.snapshot.pid;
    await connected.stopRuntime();
    await connected.disconnect();

    const deadline = Date.now() + 8000;
    while (pidAlive(pid) && Date.now() < deadline) {
      await Bun.sleep(20);
    }

    expect(pidAlive(pid)).toBe(false);
    await fixture.cleanup();
  }
}, 20000);
