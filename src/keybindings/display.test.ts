import { expect, test } from "bun:test";
import { formatKeys, parseKeymap } from "./config.ts";
import { keymapHelp } from "./help.ts";
import { expectError, expectOk } from "../testing/results.ts";

test.each([
  ["ctrl+n", "<C-n>"], ["shift+tab", "<S-Tab>"], ["return", "<CR>"], ["escape", "<Esc>"],
  ["alt+x", "<M-x>"], ["super+tab", "<D-Tab>"], ["ctrl+shift+return", "<C-S-CR>"],
  ["space", "<Space>"], ["f12", "<F12>"], ["pageup", "<PageUp>"], ["pagedown", "<PageDown>"],
  ["backspace", "<BS>"], ["delete", "<Del>"], ["insert", "<Insert>"], ["home", "<Home>"], ["end", "<End>"],
  ["up", "<Up>"], ["ctrl+down", "<C-Down>"], ["shift+g", "G"], ["g", "g"], ["G", "G"],
  ["plus", "+"], ["ctrl+plus", "<C-+>"], ["<", "<lt>"], ["|", "<Bar>"], ["\\", "<Bslash>"],
])("키 %s는 Neovim 표기 %s로 표시한다", (key, expected) => {
  // 입력용 토큰은 기존 설정 형식을 유지한다.
  const keys = [key];

  // 표시만 변환하고 실제 입력 토큰은 수정하지 않는다.
  const label = formatKeys(keys);

  // 수식키와 특수키는 Neovim 이름을 쓰며 일반 문자의 대소문자는 보존한다.
  expect(label).toBe(expected); expect(keys).toEqual([key]);
});

test.each([
  [["<leader>", "b"], "<leader>b"],
  [["g", "g"], "gg"],
  [["z", "a"], "za"],
  [["<leader>", "shift+tab"], "<leader><S-Tab>"],
  [["ctrl+x", "ctrl+f"], "<C-x><C-f>"],
] as const)("키 시퀀스 %j는 구분자 없이 %s로 이어 표시한다", (keys, expected) => {
  // 리더와 여러 키 명령은 순서대로 입력하는 하나의 시퀀스다.
  const sequence = [...keys];

  // 화살표나 공백을 새로운 키처럼 오인하지 않도록 이어 붙인다.
  const label = formatKeys(sequence);

  // 일반 문자와 특수키가 섞여도 각 키의 경계가 Neovim 표기로 드러난다.
  expect(label).toBe(expected);
});

test.each([["ctrl+space", "<C-Space>"], ["ctrl+b", "<C-b>"], ["space r", "<Space>r"]])("리더가 %s여도 안내는 논리적 리더를 유지하고 도움말은 실제 키를 알려 준다", (leader, leaderLabel) => {
  // space로 시작하는 리더는 기본 버튼의 space 입력을 비활성화해야 한다.
  const map = expectOk(parseKeymap({ leader, bindings: { "button.activate": [] } }));

  // 푸터와 도움말이 사용하는 공개 조회 경로를 함께 확인한다.
  const hint = map.hint("tab.new", "terminal"), hints = map.hints("app.detach", "terminal");
  const help = keymapHelp(map, "terminal", () => true);

  // 리더 재설정은 명령 안내를 바꾸지 않고 실제 입력 키 설명만 바꾼다.
  expect(hint).toBe("<leader>n"); expect(hints).toBe("<leader>c");
  expect(help).toContain(`<leader>: ${leaderLabel}`);
  expect(help).toContain("<leader>n"); expect(help).toContain("<leader>c");
  expect(help).toContain("<S-CR>"); expect(help).toContain("<Esc>");
  expect(help).not.toMatch(/ctrl\+|shift\+|alt\+| → /u);
});

test("리더와 같은 실제 키를 명시한 바인딩은 리더로 오인해 표시하지 않는다", () => {
  // 같은 물리 prefix라도 리더 설정을 따르는 바인딩과 고정 바인딩은 다르다.
  const map = expectOk(parseKeymap({ bindings: {
    "app.detach": ["ctrl+space q"], "view.editor": ["<leader> v"],
  } }));

  // 안내는 확장된 키가 아닌 원래 바인딩의 의미를 보존한다.
  const literal = map.hint("app.detach", "terminal"), symbolic = map.hint("view.editor", "terminal");

  // 리더를 나중에 바꾸어도 고정 바인딩을 리더 명령처럼 오해하지 않는다.
  expect(literal).toBe("<C-Space>q"); expect(symbolic).toBe("<leader>v");
});

test("여러 키 리더를 확장한 실제 시퀀스가 길이 제한을 넘으면 거부한다", () => {
  // 논리 토큰은 짧아도 라우터가 받는 실제 시퀀스는 여덟 키를 넘을 수 있다.
  const config = { leader: "space r", bindings: { "app.detach": ["<leader> q q q q q q q"] } };

  // 표시 토큰을 별도로 보관해도 기존 입력 검증을 완화하지 않는다.
  const result = parseKeymap(config);

  // 유효하지 않은 입력은 기본 키맵으로 숨기지 않고 오류를 반환한다.
  expect(expectError(result).code).toBe("INVALID_INPUT");
});
