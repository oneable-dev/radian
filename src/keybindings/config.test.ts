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

test("세션 생성은 모든 문맥에서 leader+n만 기본으로 사용하고 Ctrl+N은 입력 소유자에 남긴다", () => {
  // 입력·빈 화면·탭 줄에서도 공통 생성 명령은 같은 시퀀스여야 한다.
  const map = defaultKeymap();

  // 힌트와 실제 단축키 구성을 함께 확인한다.
  for (const context of ["prompt", "terminal", "button", "none", "session-tabs", "terminal-tabs"] as const) {
    expect(map.hints("tab.new", context)).toBe("Ctrl+Space → n");
  }

  // 별도의 생성 키는 기본에서 제거하되 기존 탭 탐색은 그대로 유지한다.
  expect(map.hint("session.new", "session-tabs")).toBe("");
  expect(map.bound("ctrl+n", "prompt")).toBe(false); expect(map.bound("ctrl+n", "terminal")).toBe(false);
  expect(map.hints("session.next", "session-tabs")).toContain("Ctrl+n");
  expect(map.hints("terminal.tab-next", "terminal-tabs")).toContain("Ctrl+n");
});

test("방향키 바인딩은 유지하되 단축키 안내에는 대체 탐색 키만 표시한다", () => {
  // 방향키가 먼저 등록된 검색과 Git에서도 대체 키를 안내해야 한다.
  const map = defaultKeymap();

  // 안내용 조회는 실제 입력 라우팅에 쓰이는 바인딩을 변경하지 않는다.
  const searchHints = [map.hint("workspace.previous", "search"), map.hint("workspace.next", "search")];
  const listHints = map.hints("workspace.previous", "workspace");

  expect(searchHints).toEqual(["Ctrl+p", "Ctrl+n"]); expect(listHints).toBe("k/Ctrl+p");
  expect(map.hints("git.previous", "git")).toBe("k/Ctrl+p"); expect(map.hints("session.next", "session-tabs")).toBe("l/Ctrl+n");
  expect(map.bound("up", "search")).toBe(true); expect(map.bound("down", "workspace")).toBe(true);
});

test("방향키만 재지정하면 안내는 생략하되 수정키와 시퀀스는 그대로 안내한다", () => {
  // 사용자 재지정은 존중하며 Ctrl+방향키나 leader 시퀀스까지 숨기지 않는다.
  const map = expectOk(parseKeymap({ bindings: {
    "workspace.previous": [{ keys: "up", scope: "workspace" }],
    "workspace.next": [{ keys: "down", scope: "workspace" }, { keys: "ctrl+down", scope: "workspace" }, { keys: "<leader> down", scope: "workspace" }],
  } }));

  // 방향키만 있는 명령에 존재하지 않는 기본 대체 키를 안내해서는 안 된다.
  const previous = map.hint("workspace.previous", "workspace"), next = map.hints("workspace.next", "workspace");

  expect(previous).toBe(""); expect(map.hints("workspace.previous", "workspace")).toBe("");
  expect(next).toBe("Ctrl+↓/Ctrl+Space → ↓"); expect(map.hint("workspace.next", "workspace")).toBe("Ctrl+↓");
  expect(map.bound("up", "workspace")).toBe(true); expect(map.bound("ctrl+p", "workspace")).toBe(false);
});

test("화면 문자와 내부 탭 숫자·생성 키는 별도로 재지정하거나 비활성화할 수 있다", () => {
  // Shared tab commands must participate in the same validation and override path as views.
  const map = expectOk(parseKeymap({ leader: "ctrl+b", bindings: {
    "tab.select-2": ["<leader> z"], "tab.new": [], "view.editor": ["<leader> v"],
  } }));

  expect(map.hint("tab.select-2", "prompt")).toBe("Ctrl+b → z");
  expect(map.hint("tab.select-2", "terminal")).toBe("Ctrl+b → z");
  expect(map.hint("tab.new", "terminal")).toBe("");
  expect(map.hint("view.editor", "terminal")).toBe("Ctrl+b → v");
  expect(map.hint("view.terminal", "editor")).toBe("Ctrl+b → t");
  expect(map.hint("terminal.new", "terminal")).toBe("");
});

test("Enter는 후보를 반영하는 전송 경로로 보내고 Tab은 삽입 전용 경로로 보낸다", () => {
  const map = defaultKeymap();

  expect(map.hints("agent.send", "prompt")).toBe("Enter");
  expect(map.hints("agent.send", "prompt-completion")).toBe("Enter");
  expect(map.hints("completion.accept", "prompt-completion")).toBe("Tab");
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
