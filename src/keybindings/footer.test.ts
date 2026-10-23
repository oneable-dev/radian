import { expect, test } from "bun:test";
import { defaultKeymap, parseKeymap } from "./config.ts";
import type { CommandId, KeyContext } from "./commands.ts";
import { footerKeyHint } from "./footer.ts";
import { expectOk } from "../testing/results.ts";

const defaults = defaultKeymap();

test.each([
  ["workspace.previous", "search"], ["workspace.next", "workspace"], ["workspace.open", "workspace"],
  ["workspace.first", "workspace"], ["workspace.half-page-down", "search"],
  ["completion.next", "prompt-completion"], ["completion.previous", "prompt-completion"], ["completion.dismiss", "prompt-completion"],
  ["agent.clear", "prompt"], ["agent.clear", "prompt-completion"], ["git.clear", "git-prompt"],
  ["git.search-clear", "git-search"], ["search.clear", "search"],
  ["transcript.search-clear", "transcript-search"], ["transcript.search-cancel", "transcript-search"],
  ["history.open", "history"], ["history.dismiss", "history-search"], ["monitor.page-down", "monitor"],
  ["dashboard.next", "dashboard-tabs"], ["model.next", "model-search"],
  ["accounts.dismiss", "accounts-input"], ["accounts.next", "accounts-search"],
  ["session.next", "session-tabs"], ["terminal.tab-previous", "terminal-tabs"], ["terminal.scroll-up", "terminal"],
  ["transcript.next", "transcript"], ["transcript.right", "transcript-text"], ["transcript.visual", "transcript-text"],
  ["transcript.visual-line", "transcript-text"], ["transcript.copy", "transcript-visual"],
  ["git.next", "git-search"], ["git.cancel", "git-prompt"], ["focus.next", "git"], ["dialog.dismiss", "dialog"],
] satisfies [CommandId, KeyContext][])("%s의 기본 %s 조작은 푸터에서만 생략한다", (command, context) => {
  // 목록·입력·본문의 기본 조작은 실제 키맵과 전체 도움말을 유지해야 한다.
  const key = defaults.hint(command, context);

  // 푸터 안내에만 간결화 정책을 적용한다.
  const hint = footerKeyHint(command, context, key);

  // 바인딩은 존재하지만 푸터에서는 공간을 차지하지 않는다.
  expect(key).not.toBe(""); expect(hint).toBe(""); expect(defaults.hint(command, context)).toBe(key);
});

test("버튼의 기본 Enter와 Space 대체 키도 푸터에서는 함께 생략한다", () => {
  // 버튼은 하나의 키가 아닌 대체 키 전체를 안내하는 표면이다.
  const key = defaults.hints("button.activate", "button");

  // 대체 키 조합도 단일 기본 키와 같은 생략 정책을 따른다.
  const hint = footerKeyHint("button.activate", "button", key);

  // 버튼 활성화 기능은 유지하면서 일반적인 안내만 제거한다.
  expect(key).toBe("<CR>/<Space>"); expect(hint).toBe("");
});

test("사용자가 재지정한 탐색 키는 기본 조작이어도 푸터에 남긴다", () => {
  // 기본 l 대신 q로 바꾼 사용자는 실제 재지정한 키를 확인할 수 있어야 한다.
  const map = expectOk(parseKeymap({ bindings: { "dashboard.next": [{ keys: "q", scope: "dashboard-tabs" }] } }));

  // 재지정한 키도 같은 푸터 정책을 통과시킨다.
  const hint = footerKeyHint("dashboard.next", "dashboard-tabs", map.hint("dashboard.next", "dashboard-tabs"));

  // 기본 키 안내만 숨기며 사용자 설정을 지우거나 기본 키로 대체하지 않는다.
  expect(hint).toBe("q"); expect(map.bound("q", "dashboard-tabs")).toBe(true);
});

test.each([
  ["agent.send", "prompt"], ["agent.newline", "prompt"], ["agent.interrupt", "prompt"],
  ["git.submit", "git-prompt"], ["git.newline", "git-prompt"],
] satisfies [CommandId, KeyContext][])("%s 안내는 재지정해도 푸터에서 생략한다", (command, context) => {
  // 전송·줄바꿈·중단은 키 설정과 무관하게 안내가 필요 없다고 지정된 동작이다.
  const map = expectOk(parseKeymap({ bindings: { [command]: [{ keys: "alt+z", scope: context }] } }));

  // 키맵의 실제 재지정 값은 유지한 채 푸터만 간결하게 만든다.
  const key = map.hint(command, context), hint = footerKeyHint(command, context, key);

  // 숨긴 안내 때문에 기능 자체가 비활성화되어서는 안 된다.
  expect(key).toBe("<M-z>"); expect(hint).toBe(""); expect(map.bound("alt+z", context)).toBe(true);
});

test.each([
  ["sidebar.toggle", "prompt"], ["tab.new", "terminal"], ["output.read", "prompt"],
  ["completion.accept", "prompt-completion"], ["transcript.search-submit", "transcript-search"],
  ["transcript.enter", "transcript"], ["transcript.fold", "transcript"], ["transcript.copy", "transcript-text"],
  ["history.preview", "history"], ["model.select", "model"], ["model.effort-more", "model"],
  ["git.open", "git"], ["git.refs", "git"], ["git.reflog", "git"], ["git.preview", "git-search"], ["git.change-session", "git-prompt"],
  ["accounts.browser", "accounts"], ["accounts.copy-url", "accounts"], ["accounts.copy-code", "accounts"],
] satisfies [CommandId, KeyContext][])("%s app-specific actions remain in %s footers", (command, context) => {
  // Non-navigation actions stay discoverable even with identical Enter/Ctrl keys.
  const key = defaults.hint(command, context);

  // 명령 의미를 기준으로 정책을 적용해 물리 키만 보고 일괄 숨기지 않는다.
  const hint = footerKeyHint(command, context, key);

  // 프리뷰·접기·필터·적용처럼 맥락에 따라 의미가 달라지는 동작은 남는다.
  expect(key).not.toBe(""); expect(hint).toBe(key);
});
