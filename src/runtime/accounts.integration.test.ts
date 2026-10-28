import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { connectRuntime } from "./client.ts";
import { daemonPaths, pidAlive, privateDirectory } from "./storage.ts";

test("Real shared daemon IPC shares account lists while preserving selections, command reservation, and secrets", async () => {
  // Insert fake accounts only into isolated daemon storage, never user authentication.
  const fixture = await createWorktreeFixture();
  const stateRoot = join(fixture.directory, "account-state");
  const directory = daemonPaths(true, stateRoot).directory;

  await privateDirectory(directory);
  await writeFile(
    join(directory, "accounts.json"),
    JSON.stringify({
      version: 1,
      revision: 1,
      selections: {},
      accounts: [
        {
          id: "account-a",
          provider: "openai",
          label: "Personal",
          credential: { type: "api_key", key: "private-ipc-fixture-key" },
        },
      ],
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "pi-auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "private-existing-ipc-key" } }),
    { mode: 0o600 },
  );

  const client = expectOk(
    await connectRuntime(fixture.repository, fixture.main, {
      offline: true,
      stateRoot,
      entry: join(import.meta.dir, "..", "index.ts"),
    }),
  );
  if (!client) {
    throw new Error("Fixture runtime missing");
  }
  try {
    const one = fixture.repository.worktrees[0]!;
    const two = fixture.repository.worktrees[1]!;
    const listed = await client.accounts({ type: "list", worktreeId: one.id });
    if (!listed.ok) {
      throw listed.error;
    }

    const catalog = listed.value;
    if (catalog.kind !== "catalog") {
      throw new Error("Expected catalog");
    }

    expect(catalog.catalog.existingAccounts).toContainEqual({
      provider: "openai",
      name: "OpenAI",
      type: "api_key",
    });
    expect(
      catalog.catalog.existingAccounts?.find((account) => account.provider === "anthropic"),
    ).toBeUndefined();

    // Workspace selection never propagates to other workspaces.
    expectOk(
      await client.accounts({
        type: "select",
        worktreeId: one.id,
        provider: "openai",
        accountId: "account-a",
        revision: catalog.catalog.revision,
      }),
    );

    const other = expectOk(await client.accounts({ type: "list", worktreeId: two.id }));
    if (other.kind !== "catalog") {
      throw new Error("Expected catalog");
    }

    // Lists, snapshots, and prompts expose no credentials and reject external-workspace requests.
    expect(other.catalog.accounts[0]?.id).toBe("account-a");
    expect(other.catalog.selections).toEqual({});
    expect(JSON.stringify(other)).not.toContain("private-ipc-fixture-key");
    expect(JSON.stringify(client.snapshot)).not.toContain("private-ipc-fixture-key");
    expect(JSON.stringify(other)).not.toContain("private-existing-ipc-key");
    expect(JSON.stringify(client.snapshot)).not.toContain("private-existing-ipc-key");
    expect(
      expectError(await client.accounts({ type: "list", worktreeId: "foreign-worktree" })).code,
    ).toBe("INVALID_INPUT");

    const session = expectOk(await client.create(one.id));
    expect(expectError(await client.prompt(session, "/accounts")).code).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(
      client.snapshot.details[session]?.sections?.some((section) => section.kind === "user"),
    ).not.toBe(true);
    expect(
      expectError(
        await client.accounts({
          type: "delete",
          worktreeId: two.id,
          accountId: "account-a",
          revision: other.catalog.revision,
        }),
      ).code,
    ).toBe("ACCOUNT_IN_USE");

    // Verified existing accounts are also reachable through the same IPC contract.
    const switched = expectOk(
      await client.accounts({
        type: "select",
        worktreeId: one.id,
        provider: "openai",
        accountId: null,
        revision: other.catalog.revision,
      }),
    );
    if (switched.kind !== "catalog") {
      throw new Error("Expected catalog");
    }

    expect(switched.catalog.selections).toEqual({});
    expect(switched.catalog.existingAccounts).toContainEqual({
      provider: "openai",
      name: "OpenAI",
      type: "api_key",
    });

    // Renaming an external connection shares only its label, not its credential or selection.
    const authBefore = await readFile(join(directory, "pi-auth.json"), "utf8");
    const renamed = expectOk(
      await client.accounts({
        type: "rename",
        worktreeId: one.id,
        provider: "openai",
        accountId: null,
        label: "ONEABLE",
        revision: switched.catalog.revision,
      }),
    );
    if (renamed.kind !== "catalog") {
      throw new Error("Expected catalog");
    }

    const shared = expectOk(await client.accounts({ type: "list", worktreeId: two.id }));
    if (shared.kind !== "catalog") {
      throw new Error("Expected catalog");
    }

    expect(shared.catalog.existingAccounts).toContainEqual({
      provider: "openai",
      name: "OpenAI",
      type: "api_key",
      label: "ONEABLE",
    });
    expect(shared.catalog.accounts[0]?.label).toBe("Personal");
    expect(shared.catalog.selections).toEqual({});
    expect(renamed.catalog.selections).toEqual({});
    expect(await readFile(join(directory, "pi-auth.json"), "utf8")).toBe(authBefore);
    expect(await readFile(join(directory, "accounts.json"), "utf8")).not.toContain(
      "private-existing-ipc-key",
    );
    expect(JSON.stringify(shared)).not.toContain("private-existing-ipc-key");
    expect(
      expectError(
        await client.accounts({
          type: "rename",
          worktreeId: one.id,
          provider: "openai",
          accountId: null,
          label: "Stale",
          revision: switched.catalog.revision,
        }),
      ).code,
    ).toBe("ACCOUNT_CONFLICT");
  } finally {
    const pid = client.snapshot.pid;
    await client.stopRuntime();
    await client.disconnect();

    const deadline = Date.now() + 8000;
    while (pidAlive(pid) && Date.now() < deadline) {
      await Bun.sleep(20);
    }

    expect(pidAlive(pid)).toBe(false);
    await fixture.cleanup();
  }
}, 20000);
