import { expect, test } from "bun:test";
import { defaultKeymap, parseKeymap } from "./config.ts";
import { inScope, type CommandId, type KeyContext } from "./commands.ts";
import { expectOk } from "../testing/results.ts";

const commandFor = (context: KeyContext, key: string): CommandId | undefined => defaultKeymap().bindings.find(binding =>
  binding.keys.length === 1 && binding.keys[0] === key && inScope(binding.scope, context))?.command;

test.each([
  ["workspace", "workspace"], ["history", "history"], ["monitor", "monitor"], ["model", "model"],
  ["dialog", "dialog"], ["git", "git"], ["transcript", "transcript"], ["transcript-text", "transcript"], ["transcript-visual", "transcript"],
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
  ["git", "git.previous", "git.next"], ["git-tabs", "git.tab-previous", "git.tab-next"],
  ["terminal-tabs", "terminal.tab-previous", "terminal.tab-next"], ["session-tabs", "session.previous", "session.next"],
  ["transcript", "transcript.previous", "transcript.next"], ["transcript-text", "transcript.up", "transcript.down"],
  ["transcript-visual", "transcript.up", "transcript.down"],
] as const)("%s의 Ctrl+N/P는 기존 방향 탐색과 같은 명령을 실행한다", (context, previous, next) => {
  // Ctrl+N/P는 Vim 키가 없을 때만 사용하는 대체재가 아니라 필수 기본값이다.
  const up = commandFor(context, "ctrl+p"), down = commandFor(context, "ctrl+n");

  // 탭·읽기 본문·검색 결과의 현재 포커스에 맞는 이전/다음 동작을 선택한다.
  expect(up).toBe(previous); expect(down).toBe(next);
});

test.each(["editor", "terminal", "prompt", "prompt-completion", "history-search", "monitor-search", "model-search"] as const)("%s의 Ctrl+D/U는 네이티브 입력 소유권을 유지한다", context => {
  // 검색·입력과 임베디드 프로그램에는 앱의 반 페이지 명령을 설치하지 않는다.
  const map = defaultKeymap();

  expect(map.bound("ctrl+d", context)).toBe(false); expect(map.bound("ctrl+u", context)).toBe(false);
});

test("워크스페이스 검색 지우기와 사용자 점프 재설정은 기본 점프와 충돌하지 않는다", () => {
  // 검색창의 기존 Ctrl+U 의미를 유지하고 점프 키는 다른 키로 교체할 수 있다.
  const map = expectOk(parseKeymap({ bindings: { "workspace.half-page-down": [{ keys: "ctrl+y", scope: "workspace" }] } }));

  expect(commandFor("search", "ctrl+u")).toBe("search.clear");
  expect(map.hint("workspace.half-page-down", "workspace")).toBe("Ctrl+y");
  expect(map.bound("ctrl+d", "workspace")).toBe(false); expect(map.bound("ctrl+d", "search")).toBe(false);
});
