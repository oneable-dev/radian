import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { connectRuntime } from "./client.ts";
import { daemonPaths, pidAlive, privateDirectory } from "./storage.ts";

test("실제 공용 데몬 IPC는 계정 목록을 공유하고 작업 공간 선택·명령 예약·비밀정보 경계를 유지한다", async () => {
  // 격리한 테스트 데몬의 저장소에만 가짜 계정을 넣으며 사용자 인증에는 접근하지 않는다.
  const fixture = await createWorktreeFixture(), stateRoot = join(fixture.directory, "account-state");
  const directory = daemonPaths(true, stateRoot).directory; await privateDirectory(directory);
  await writeFile(join(directory, "accounts.json"), JSON.stringify({ version: 1, revision: 1, selections: {}, accounts: [
    { id: "account-a", provider: "openai", label: "Personal", credential: { type: "api_key", key: "private-ipc-fixture-key" } },
  ] }), { mode: 0o600 });
  await writeFile(join(directory, "pi-auth.json"), JSON.stringify({ openai: { type: "api_key", key: "private-existing-ipc-key" } }), { mode: 0o600 });
  const client = expectOk(await connectRuntime(fixture.repository, fixture.main, { offline: true, stateRoot, entry: join(import.meta.dir, "..", "index.ts") }));
  if (!client) throw new Error("Fixture runtime missing");
  try {
    const one = fixture.repository.worktrees[0]!, two = fixture.repository.worktrees[1]!;
    const listed = await client.accounts({ type: "list", worktreeId: one.id }); if (!listed.ok) throw listed.error;
    const catalog = listed.value; if (catalog.kind !== "catalog") throw new Error("Expected catalog");
    expect(catalog.catalog.existingAccounts).toContainEqual({ provider: "openai", name: "OpenAI", type: "api_key" });
    expect(catalog.catalog.existingAccounts?.find(account => account.provider === "anthropic")).toBeUndefined();

    // 한 작업 공간에서 선택한 계정을 다른 작업 공간의 선택에 전파하지 않는다.
    expectOk(await client.accounts({ type: "select", worktreeId: one.id, provider: "openai", accountId: "account-a", revision: catalog.catalog.revision }));
    const other = expectOk(await client.accounts({ type: "list", worktreeId: two.id })); if (other.kind !== "catalog") throw new Error("Expected catalog");

    // 인증 자체는 목록·스냅샷·세션 프롬프트로 노출하지 않으며 외부 작업 공간 요청도 거절한다.
    expect(other.catalog.accounts[0]?.id).toBe("account-a"); expect(other.catalog.selections).toEqual({});
    expect(JSON.stringify(other)).not.toContain("private-ipc-fixture-key"); expect(JSON.stringify(client.snapshot)).not.toContain("private-ipc-fixture-key");
    expect(JSON.stringify(other)).not.toContain("private-existing-ipc-key"); expect(JSON.stringify(client.snapshot)).not.toContain("private-existing-ipc-key");
    expect(expectError(await client.accounts({ type: "list", worktreeId: "foreign-worktree" })).code).toBe("INVALID_INPUT");
    const session = expectOk(await client.create(one.id));
    expect(expectError(await client.prompt(session, "/accounts")).code).toBe("UNSUPPORTED_CAPABILITY");
    expect(client.snapshot.details[session]?.sections?.some(section => section.kind === "user")).not.toBe(true);
    expect(expectError(await client.accounts({ type: "delete", worktreeId: two.id, accountId: "account-a", revision: other.catalog.revision })).code).toBe("ACCOUNT_IN_USE");

    // 연결이 확인된 기존 계정으로도 같은 IPC 계약을 통해 돌아갈 수 있다.
    const switched = expectOk(await client.accounts({ type: "select", worktreeId: one.id, provider: "openai", accountId: null, revision: other.catalog.revision }));
    if (switched.kind !== "catalog") throw new Error("Expected catalog");
    expect(switched.catalog.selections).toEqual({});
    expect(switched.catalog.existingAccounts).toContainEqual({ provider: "openai", name: "OpenAI", type: "api_key" });
  } finally {
    const pid = client.snapshot.pid; await client.stopRuntime(); await client.disconnect();
    const deadline = Date.now() + 8000; while (pidAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
    expect(pidAlive(pid)).toBe(false); await fixture.cleanup();
  }
}, 20000);
