import { expect, test } from "bun:test";
import { parseSessionControl, sessionControlCommands } from "./session-controls.ts";
import { expectError, expectOk } from "../testing/results.ts";

test("완성 목록은 새 탭·대화 초기화·리로드·압축 명령을 실행 파서와 같은 의미로 안내한다", () => {
  // Host-reserved commands must not be shadowed by SDK commands with different meanings.
  const names = sessionControlCommands.map((item) => item.value);
  const actions = names.map((name) => expectOk(parseSessionControl(`/${name}`))?.action);
  expect(names).toEqual(["new", "clear", "reload", "compact"]); expect(actions).toEqual(["new-tab", "clear", "reload", "compact"]);
  expect(sessionControlCommands.find((item) => item.value === "new")?.description).toContain("new session tab");
  expect(sessionControlCommands.find((item) => item.value === "clear")?.description).toContain("History");
});

test.each(["/new", "/new  ", "/new\n"])("new는 현재 대화 초기화가 아니라 새 탭 생성으로 해석한다: %j", (text) => {
  // Whitespace must not turn into an implicit first model prompt.
  expect(expectOk(parseSessionControl(text))).toEqual({ action: "new-tab" });
});

test.each(["/clear", "/clear  ", "/clear\n"])("clear는 현재 탭의 대화 교체로 해석한다: %j", (text) => {
  expect(expectOk(parseSessionControl(text))).toEqual({ action: "clear" });
});

test.each(["new", "clear", "reload"])("%s의 추가 입력은 버리지 않고 명시적으로 거부한다", (command) => {
  const result = parseSessionControl(`/${command} implement auth`);
  expect(expectError(result).code).toBe("INVALID_INPUT");
  expect(expectError(result).message).toBe(`Usage: /${command} (no arguments).`);
});

test.each(["/reload", "/reload  ", "/reload\n"])("reload는 인수 없이 명시적인 리소스 갱신으로 해석한다: %j", text => {
  // 공백은 지시문이나 새 모델 입력이 아니라 명령 구분자로만 취급한다.
  const result = parseSessionControl(text);

  expect(expectOk(result)).toEqual({ action: "reload" });
});

test("압축의 여러 줄 지시는 내부 내용을 잘라내거나 단일 줄로 바꾸지 않는다", () => {
  const instructions = "Keep the plan\nPreserve 한글 👩🏽‍💻 constraints";
  expect(expectOk(parseSessionControl(`/compact ${instructions}`))).toEqual({ action: "compact", instructions });
});

test.each(["compact", "/compact-more", "/newspaper", "/clearance", "/skill:strategic-compact", "Please use /new"])("일반 입력과 다른 자원 명령은 가로채지 않는다: %j", (text) => {
  expect(expectOk(parseSessionControl(text))).toBeNull();
});
