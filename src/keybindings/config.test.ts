import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultKeymap, loadKeymap, parseKeymap } from "./config.ts";
import { expectError, expectOk } from "../testing/results.ts";

test("기본 leader는 Ctrl+Space이며 Ctrl+C를 앱 종료에 할당하지 않는다", () => {
  const map = defaultKeymap();
  expect(map.hint("app.detach", "terminal")).toBe("Ctrl+Space → c");
  expect(map.bindings.some((binding) => binding.command === "app.detach" && binding.keys.includes("ctrl+c"))).toBe(false);
  expect(map.hint("focus.search", "editor")).toBe("Ctrl+Space → f");
  expect(map.hint("focus.search", "search")).toBe("Ctrl+f");
  expect(map.hint("sidebar.toggle", "workspace")).toBe("Ctrl+Space → b");
  expect(map.hint("sidebar.toggle", "editor")).toBe("Ctrl+Space → b");
  expect(map.bound("ctrl+b", "prompt")).toBe(false);
});

test("키 설정은 scoped 기본값을 바꾸거나 비활성화하고 실제 힌트에 반영한다", () => {
  const map = expectOk(parseKeymap({ leader: "ctrl+b", bindings: {
    "session.new": [{ keys: "s", scope: "workspace" }], "session.close": [],
    "app.detach": ["<leader> q"],
  } }));
  expect(map.hint("session.new", "workspace")).toBe("s");
  expect(map.hint("session.new", "prompt")).toBe("");
  expect(map.hint("session.close", "workspace")).toBe("");
  expect(map.hint("app.detach", "editor")).toBe("Ctrl+b → q");
});

test.each([
  { leader: "" }, { leader: "ctrl+unknown" }, { timeoutMs: 0 }, { bindings: { "unknown.action": [] } },
  { bindings: { "app.detach": null } }, { bindings: { "app.detach": [{ keys: "x", scope: "unknown" }] } },
  { bindings: { "app.detach": ["ctrl+f"] } }, { bindings: { "app.detach": ["ctrl+space"] } },
])("잘못된 설정과 겹치는 prefix는 조용한 기본값 복구 대신 오류를 반환한다: %j", (config) => {
  expect(expectError(parseKeymap(config)).code).toBe("INVALID_INPUT");
});

test("명시한 설정 파일을 읽고 파일 누락과 손상된 JSON을 구분한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-keys-")); const path = join(directory, "keys.json");
  try {
    expect(expectError(await loadKeymap(path)).code).toBe("STORAGE_FAILED");
    await writeFile(path, "{"); expect(expectError(await loadKeymap(path)).code).toBe("INVALID_INPUT");
    await writeFile(path, JSON.stringify({ leader: "ctrl+b" }));
    expect(expectOk(await loadKeymap(path)).hint("app.detach", "none")).toBe("Ctrl+b → c");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
