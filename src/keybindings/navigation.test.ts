import { expect, test } from "bun:test";
import { defaultKeymap, parseKeymap } from "./config.ts";
import { inScope, type CommandId, type KeyContext } from "./commands.ts";
import { expectOk } from "../testing/results.ts";

const commandFor = (context: KeyContext, key: string): CommandId | undefined => defaultKeymap().bindings.find(binding =>
  binding.keys.length === 1 && binding.keys[0] === key && inScope(binding.scope, context))?.command;

test.each([
  ["workspace", "workspace"], ["history", "history"], ["monitor", "monitor"], ["model", "model"],
  ["dialog", "dialog"], ["git", "git"], ["git-search", "git"], ["transcript", "transcript"], ["transcript-text", "transcript"], ["transcript-visual", "transcript"],
] as const)("%s의 Ctrl+D/U는 %s 반 페이지 명령에 연결한다", (context, family) => {
  // 목록과 본문 모두 키 이름은 같지만 각 화면의 소유자가 동작을 결정한다.
  const down = commandFor(context, "ctrl+d"), up = commandFor(context, "ctrl+u");

  // 어느 화면도 점프를 단일 항목 이동이나 입력 명령으로 잘못 연결하지 않는다.
  expect(down).toBe(`${family}.half-page-down`); expect(up).toBe(`${family}.half-page-up`);
});

test.each([
  ["workspace", "workspace.previous", "workspace.next"], ["search", "workspace.previous", "workspace.next"],
  ["history", "history.previous", "history.next"], ["history-search", "history.previous", "history.next"],
  ["monitor", "monitor.previous", "monitor.next"], ["monitor-search", "monitor.previous", "monitor.next"],
  ["model", "model.previous", "model.next"], ["model-search", "model.previous", "model.next"],
  ["model-effort", "model.effort-less", "model.effort-more"], ["dialog", "dialog.previous", "dialog.next"],
  ["git", "git.previous", "git.next"], ["git-search", "git.previous", "git.next"],
  ["terminal-tabs", "terminal.tab-previous", "terminal.tab-next"], ["session-tabs", "session.previous", "session.next"],
  ["transcript", "transcript.previous", "transcript.next"], ["transcript-text", "transcript.up", "transcript.down"],
  ["transcript-visual", "transcript.up", "transcript.down"],
] as const)("%s의 Ctrl+N/P는 기존 방향 탐색과 같은 명령을 실행한다", (context, previous, next) => {
  // Ctrl+N/P는 Vim 키가 없을 때만 사용하는 대체재가 아니라 필수 기본값이다.
  const up = commandFor(context, "ctrl+p"), down = commandFor(context, "ctrl+n");

  // 탭·읽기 본문·검색 결과의 현재 포커스에 맞는 이전/다음 동작을 선택한다.
  expect(up).toBe(previous); expect(down).toBe(next);
});

test.each(["editor", "terminal", "prompt", "prompt-completion"] as const)("%s의 Ctrl+D/U는 네이티브 입력 소유권을 유지한다", context => {
  // 일반 프롬프트와 임베디드 프로그램의 입력까지 검색창 차단 정책을 전파하지 않는다.
  const map = defaultKeymap();

  expect(map.bound("ctrl+d", context)).toBe(false); expect(map.bound("ctrl+u", context)).toBe(false);
});

test.each([["search", "workspace"], ["history-search", "history"], ["monitor-search", "monitor"], ["model-search", "model"]] as const)("%s의 Ctrl+D/U는 %s 결과 목록의 점프로 연결하고 Ctrl+C로 검색을 지운다", (context, family) => {
  // 검색 입력을 편집하지 않고 소유한 결과 목록의 반 페이지 동작으로 전달한다.
  const down = commandFor(context, "ctrl+d"), up = commandFor(context, "ctrl+u");

  expect(down).toBe(`${family}.half-page-down`); expect(up).toBe(`${family}.half-page-up`);
  expect(commandFor(context, "ctrl+c")).toBe("search.clear"); expect(commandFor(context, "ctrl+l")).toBeUndefined();
  expect(defaultKeymap().hints("search.clear", context)).toBe("Ctrl+c");
});

test("Git 검색은 기본 탐색·지우기를 제공하고 일반 문자는 입력에 남긴다", () => {
  // Git 모달의 키는 메인 탐색 및 Agent prompt와 소유권을 나눠야 한다.
  const map = defaultKeymap();

  expect(commandFor("git-search", "ctrl+n")).toBe("git.next"); expect(commandFor("git-search", "ctrl+p")).toBe("git.previous");
  expect(commandFor("git-search", "ctrl+c")).toBe("git.search-clear"); expect(commandFor("git-search", "ctrl+l")).toBeUndefined();
  for (const key of ["h", "j", "k", "l", "a", "y", "b"]) expect(commandFor("git-search", key)).toBeUndefined();
  expect(commandFor("git", "b")).toBe("git.refs"); expect(commandFor("git", "ctrl+r")).toBe("git.reflog"); expect(commandFor("git", "r")).toBe("git.refresh");
  expect(map.hint("git.search-clear", "git-search")).toBe("Ctrl+c");
});

test("Git 모달 진입·검색 지우기 키의 사용자 재설정은 기본 바인딩을 대체한다", () => {
  // 모달이 직접 키를 가로채면 사용자 keymap의 재설정을 존중할 수 없다.
  const map = expectOk(parseKeymap({ bindings: { "git.refs": [{ keys: "v", scope: "git" }],
    "git.reflog": [{ keys: "shift+r", scope: "git" }], "git.search-clear": [{ keys: "ctrl+g", scope: "git-search" }] } }));

  expect(map.bound("b", "git")).toBe(false); expect(map.bound("ctrl+r", "git")).toBe(false); expect(map.bound("ctrl+c", "git-search")).toBe(false);
  expect(map.hint("git.refs", "git")).toBe("v"); expect(map.hint("git.reflog", "git")).toBe("Shift+r");
  expect(map.hint("git.search-clear", "git-search")).toBe("Ctrl+g");
});

test("Transcript의 Shift+G는 섹션에서 최신 출력으로 이동하고 본문에서는 섹션 끝으로 이동한다", () => {
  // The same Vim key has a different owner in section navigation and read-only source navigation.
  const map = defaultKeymap();

  // Sections advertise the new bottom shortcut while text/visual keep their source cursor bindings.
  expect(commandFor("transcript", "shift+g")).toBe("transcript.latest");
  expect(commandFor("transcript", "end")).toBe("transcript.last");
  expect(commandFor("transcript", "ctrl+end")).toBe("transcript.latest");
  for (const context of ["transcript-text", "transcript-visual"] as const) {
    expect(commandFor(context, "shift+g")).toBe("transcript.buffer-end");
    expect(commandFor(context, "ctrl+end")).toBe("transcript.buffer-end");
    expect(map.hint("transcript.latest", context)).toBe("g → e");
  }
  expect(map.hint("transcript.latest", "transcript")).toBe("Shift+g");
  for (const context of ["prompt", "prompt-completion", "editor", "terminal"] as const) {
    expect(map.bound("shift+g", context)).toBe(false);
    expect(map.bound("ctrl+end", context)).toBe(false);
  }
});

test("Agent와 Git 프롬프트의 Ctrl+C는 각각 초안을 지우고 사용자 키 재설정을 존중한다", () => {
  // 공용 입력기가 키를 직접 가로채면 사용자 설정으로 기본 지우기를 교체할 수 없게 된다.
  const map = expectOk(parseKeymap({ bindings: { "git.clear": [{ keys: "ctrl+g", scope: "git-prompt" }] } }));

  // 두 기본 경로를 동일한 지우기 동작에 연결하되 명시적 재설정은 기본 바인딩을 대체한다.
  expect(commandFor("prompt", "ctrl+c")).toBe("agent.clear"); expect(commandFor("git-prompt", "ctrl+c")).toBe("git.clear");
  expect(map.bound("ctrl+c", "git-prompt")).toBe(false); expect(map.hint("git.clear", "git-prompt")).toBe("Ctrl+g");
});

test("워크스페이스 검색 지우기와 사용자 점프 재설정은 기본 점프와 충돌하지 않는다", () => {
  // 점프 키 재설정은 검색어 지우기와 별개이며 해당 명령의 기본 바인딩을 교체한다.
  const map = expectOk(parseKeymap({ bindings: { "workspace.half-page-down": [{ keys: "ctrl+y", scope: "workspace" }] } }));

  expect(commandFor("search", "ctrl+u")).toBe("workspace.half-page-up");
  expect(map.hint("workspace.half-page-down", "workspace")).toBe("Ctrl+y");
  expect(map.bound("ctrl+d", "workspace")).toBe(false); expect(map.bound("ctrl+d", "search")).toBe(false);
});
