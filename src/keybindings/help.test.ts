import { expect, test } from "bun:test";
import { defaultKeymap, parseKeymap } from "./config.ts";
import { keymapHelp } from "./help.ts";
import { expectOk } from "../testing/results.ts";

test("도움말은 기본 방향키 대신 실제 등록된 대체 탐색 키를 안내한다", () => {
  // Git은 방향키를 먼저 등록하고 가로·세로 탐색 모두 Vim 대체 키를 제공한다.
  const keymap = defaultKeymap();

  // 현재 문맥에서 사용 가능한 Git 명령만 도움말에 포함한다.
  const help = keymapHelp(keymap, "git", command => command.startsWith("git."));

  expect(help).toMatch(/^k\s+git previous$/mu); expect(help).toMatch(/^j\s+git next$/mu);
  expect(help).toMatch(/^h\s+git left$/mu); expect(help).toMatch(/^l\s+git right$/mu);
  expect(help).not.toMatch(/[↑↓←→]/u); expect(help).not.toContain("arrows");
});

test("도움말은 기본 탐색 키를 숨겨도 사용자 수정키와 시퀀스는 안내한다", () => {
  // 방향키 단독 재지정은 유지하며 의미가 다른 수정키와 시퀀스는 명시한다.
  const keymap = expectOk(parseKeymap({ bindings: {
    "workspace.previous": [{ keys: "up", scope: "workspace" }],
    "workspace.next": [{ keys: "down", scope: "workspace" }, { keys: "ctrl+down", scope: "workspace" }, { keys: "<leader> down", scope: "workspace" }],
  } }));

  // 도움말도 푸터와 같은 생략 정책을 적용한다.
  const help = keymapHelp(keymap, "workspace", command => command.startsWith("workspace."));

  expect(help).not.toContain("workspace previous");
  expect(help).toContain("Ctrl+↓ / Ctrl+Space → ↓"); expect(help).toContain("workspace next");
});
