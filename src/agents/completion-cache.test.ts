import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CompletionCache } from "./completion-cache.ts";
import type { CompletionCatalog } from "./completion.ts";
import { CapabilityError } from "../errors.ts";
import { err, ok } from "../result.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";

const catalog = (revision = 0): CompletionCatalog => ({
  conversationId: "conversation",
  revision,
  items: [
    ...Array.from({ length: 150 }, (_, i) => ({
      kind: "command" as const,
      value: `command-${i}`,
      description: "Command",
    })),
    { kind: "skill", value: "skill:review-code", description: "Review code" },
  ],
});

test("Commands, skills, files, and rerenders reuse catalogs after initial preparation", async () => {
  // Prepare over 100 catalog entries and index the selected worktree once.
  const fixture = await createWorktreeFixture();
  const unexpected: unknown[] = [];
  let requests = 0;
  const cache = new CompletionCache(
    async () => {
      requests++;

      return ok(catalog());
    },
    () => "instance/conversation/0",
    (error) => unexpected.push(error),
  );
  const provider = cache.provider;
  const signal = new AbortController().signal;
  try {
    await writeFile(join(fixture.main, "last-file.ts"), "file");
    provider.prepare?.("session", fixture.main);
    expectOk(await provider("session", { kind: "command", query: "command-149" }, signal));
    expectOk(await provider("session", { kind: "file", query: "last-file" }, signal));

    // Typing and reselecting the same session do not request the catalog again.
    for (let i = 0; i < 50; i++) {
      provider.prepare?.("session", fixture.main);
      expect(
        expectOk(provider.read!("session", { kind: "command", query: "command-149" })!).items[0]
          ?.value,
      ).toBe("command-149");
      expect(
        expectOk(provider.read!("session", { kind: "skill", query: "review" })!).items[0]?.value,
      ).toBe("review-code");
      expect(
        expectOk(provider.read!("session", { kind: "file", query: "last-file" })!).items[0]?.value,
      ).toBe("last-file.ts");
    }

    // Cached executable catalogs use prefixes while files still accept basename fragments.
    expect(
      expectOk(provider.read!("session", { kind: "command", query: "mand-149" })!).items,
    ).toEqual([]);
    expect(expectOk(provider.read!("session", { kind: "skill", query: "code" })!).items).toEqual(
      [],
    );
    expect(
      expectOk(provider.read!("session", { kind: "file", query: "file.ts" })!).items.map(
        (item) => item.value,
      ),
    ).toEqual(["last-file.ts"]);
    expect(requests).toBe(1);
    expect(unexpected).toEqual([]);
    expect(
      expectError(await provider("session", { kind: "command", query: "" }, AbortSignal.abort()))
        .code,
    ).toBe("CANCELLED");
    expect(
      expectOk(provider.read!("session", { kind: "command", query: "review" })!).items,
    ).toEqual([]);
  } finally {
    cache.dispose();
    await fixture.cleanup();
  }
});

test("Catalogs reload only when resource revisions or runtime/conversation identities change", async () => {
  // Resource identity, not UI lifetime, determines cache validity.
  const fixture = await createWorktreeFixture();
  let identity = "instance/conversation/0";
  let revision = 0;
  let requests = 0;
  const cache = new CompletionCache(
    async () => {
      requests++;

      return ok(catalog(revision));
    },
    () => identity,
    (error) => {
      throw error;
    },
  );
  try {
    cache.provider.prepare?.("session", fixture.main);
    expectOk(
      await cache.provider(
        "session",
        { kind: "skill", query: "review" },
        new AbortController().signal,
      ),
    );

    // Replace stale catalogs when resources or the server change within the same tab.
    revision++;
    identity = "instance/conversation/1";
    expectOk(await cache.refresh("session"));
    expect(requests).toBe(2);
    identity = "replacement/conversation/1";
    cache.provider.prepare?.("session", fixture.main);
    expectOk(
      await cache.provider(
        "session",
        { kind: "command", query: "command-149" },
        new AbortController().signal,
      ),
    );

    expect(requests).toBe(3);
  } finally {
    cache.dispose();
    await fixture.cleanup();
  }
});

test("Late catalogs from replaced sessions never overwrite new catalogs", async () => {
  // Identity and entry ownership checks reject stale responses even if cancellation is ignored.
  const fixture = await createWorktreeFixture();
  let identity = "first";
  const first = Promise.withResolvers<ReturnType<typeof ok<CompletionCatalog>>>();
  const second = Promise.withResolvers<ReturnType<typeof ok<CompletionCatalog>>>();
  const cache = new CompletionCache(
    async () => (identity === "first" ? first.promise : second.promise),
    () => identity,
    (error) => {
      throw error;
    },
  );
  try {
    cache.provider.prepare?.("session", fixture.main);
    await Promise.resolve();

    const old = cache.provider(
      "session",
      { kind: "command", query: "" },
      new AbortController().signal,
    );

    // Prepare the new conversation before delivering the old response.
    identity = "second";
    cache.provider.prepare?.("session", fixture.main);
    await Promise.resolve();
    second.resolve(
      ok({
        conversationId: "second",
        revision: 0,
        items: [{ kind: "command", value: "fresh", description: "Fresh" }],
      }),
    );
    first.resolve(
      ok({
        conversationId: "first",
        revision: 0,
        items: [{ kind: "command", value: "stale", description: "Stale" }],
      }),
    );

    const fresh = expectOk(
      await cache.provider("session", { kind: "command", query: "" }, new AbortController().signal),
    );

    expect(expectError(await old).code).toBe("CANCELLED");
    expect(fresh.items.map((item) => item.value)).toEqual(["fresh"]);
  } finally {
    first.resolve(ok(catalog()));
    second.resolve(ok(catalog()));
    cache.dispose();
    await fixture.cleanup();
  }
});

test("Lookup cancellation preserves shared initialization and failures remain errors", async () => {
  // Closing one search with Esc must not cancel shared catalog preparation.
  const fixture = await createWorktreeFixture();
  const ready = Promise.withResolvers<ReturnType<typeof ok<CompletionCatalog>>>();
  let fail = false;
  let identity = "first";
  let requests = 0;
  const cache = new CompletionCache(
    async () => {
      requests++;

      return fail ? err(new CapabilityError("Catalog unavailable")) : ready.promise;
    },
    () => identity,
    (error) => {
      throw error;
    },
  );
  try {
    cache.provider.prepare?.("session", fixture.main);

    const abort = new AbortController();
    const query = cache.provider("session", { kind: "command", query: "" }, abort.signal);

    abort.abort();
    expect(expectError(await query).code).toBe("CANCELLED");

    ready.resolve(ok(catalog()));
    expectOk(
      await cache.provider(
        "session",
        { kind: "command", query: "command-149" },
        new AbortController().signal,
      ),
    );
    fail = true;
    identity = "second";
    cache.provider.prepare?.("session", fixture.main);

    const failed = await cache.provider(
      "session",
      { kind: "command", query: "" },
      new AbortController().signal,
    );

    expect(expectError(failed).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(requests).toBe(2);
    cache.provider.retain?.(new Set());
    expect(
      expectError(
        await cache.provider("session", { kind: "file", query: "" }, new AbortController().signal),
      ).code,
    ).toBe("SESSION_NOT_OPEN");
  } finally {
    ready.resolve(ok(catalog()));
    cache.dispose();
    await fixture.cleanup();
  }
});
