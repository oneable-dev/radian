import { expect, test } from "bun:test";
import { parseAccountsCommand } from "./model.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { openLoginUrl } from "./browser.ts";

test.each(["/accounts", "  /accounts  ", "/accounts\n"])("%j는 공백을 정리해 모델 입력 대신 호스트 명령으로 예약한다", text => {
  // SDK도 입력을 trim하므로 호스트 경계에서 같은 명령을 놓치면 안 된다.
  const reserved = parseAccountsCommand(text);

  expect(expectOk(reserved)).toBe(true);
});

test("계정 명령의 인수는 거절하고 비슷한 일반 문장은 예약하지 않는다", () => {
  // API 키처럼 보이는 문자열을 인수로 붙여도 모델 프롬프트로 보내지 않는다.
  const invalid = parseAccountsCommand("/accounts private-key"), other = parseAccountsCommand("/accounts-guide");

  expect(expectError(invalid).code).toBe("INVALID_INPUT"); expect(expectOk(other)).toBe(false);
});

test.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/html,example", "not a URL"])("인증 URL %j는 브라우저 명령 실행 전에 거절한다", async url => {
  // 외부 프로세스를 실행하지 않고 URL 스킴 경계를 검증한다.
  const result = await openLoginUrl(url);

  expect(expectError(result).code).toBe("BROWSER_UNAVAILABLE");
});
