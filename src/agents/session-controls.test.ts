import { expect, test } from "bun:test";
import { parseSessionControl, sessionControlCommands } from "./session-controls.ts";
import { expectError, expectOk } from "../testing/results.ts";

test("완성 목록의 세션 명령은 같은 이름의 실행 파서와 일치한다", () => {
  // Only commands backed by host dispatch may be advertised as built-ins.
  const names = sessionControlCommands.map((item) => item.value);
  const actions = names.map((name) => expectOk(parseSessionControl(`/${name}`))?.action);
  expect(names).toEqual(["new", "compact"]); expect(actions.join(",")).toBe("new,compact");
});

test.each(["/new", "/new  ", "/new\n"])("새 대화 명령은 공백 외의 내용을 보내지 않는다: %j", (text) => {
  // Whitespace is not an implicit first prompt in the new conversation.
  expect(expectOk(parseSessionControl(text))).toEqual({ action: "new" });
});

test("new의 추가 입력은 버리지 않고 명시적으로 거부한다", () => {
  // A typed next task must never silently disappear during session replacement.
  const result = parseSessionControl("/new implement auth");
  expect(expectError(result).code).toBe("INVALID_INPUT");
});

test("압축의 여러 줄 지시는 내부 내용을 잘라내거나 단일 줄로 바꾸지 않는다", () => {
  const instructions = "Keep the plan\nPreserve 한글 👩🏽‍💻 constraints";
  const result = parseSessionControl(`/compact ${instructions}`);
  expect(expectOk(result)).toEqual({ action: "compact", instructions });
});

test.each(["compact", "/compact-more", "/newspaper", "/skill:strategic-compact", "Please use /new"])("일반 입력과 다른 자원 명령은 가로채지 않는다: %j", (text) => {
  // Prefix matches must not turn an ordinary message into a control operation.
  expect(expectOk(parseSessionControl(text))).toBeNull();
});
