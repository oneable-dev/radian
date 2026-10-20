import { expect, test } from "bun:test";
import { parseHistoryCommand } from "./history-command.ts";
import { expectError, expectOk } from "../testing/results.ts";

test.each(["/history", "/history  ", "/history\n\t"])("history는 뒤의 공백을 인수로 해석하지 않는다: %j", text => {
  // 공백만 있는 인수는 자동완성이 붙인 구분자와 같은 입력이다.
  const result = parseHistoryCommand(text);

  // 유효한 명령은 팝업 전용 경로에서 처리할 수 있어야 한다.
  expect(expectOk(result)).toBe(true);
});

test.each(["/history recent", "/history\nsearch"])("history의 인수는 무시하지 않고 명시적으로 거부한다: %j", text => {
  // 줄바꿈 뒤의 요청도 모델 입력으로 잘못 전송하지 않도록 검사한다.
  const result = parseHistoryCommand(text);

  // 원문을 유지할 수 있도록 안정적인 입력 오류를 반환한다.
  expect(expectError(result).code).toBe("INVALID_INPUT");
});

test.each(["/history-more", "/history/recent", "history", "Explain /history"])("다른 명령과 일반 문장의 history는 가로채지 않는다: %j", text => {
  // 명령 이름의 일부 일치나 문장 안의 토큰은 히스토리 열기가 아니다.
  const result = parseHistoryCommand(text);

  // 다른 자원 명령과 일반 대화는 기존 경로에 남긴다.
  expect(expectOk(result)).toBe(false);
});
