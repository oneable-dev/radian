import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { validateBrowserUrl, openBrowserUrl } from "./browser.ts";
import { expectError, expectOk } from "./testing/results.ts";

test.each(["https://example.invalid/docs?q=one&next=two", "http://localhost:3000/preview", "https://example.invalid/한글"])("웹 URL %s는 기본 브라우저 대상으로 허용한다", url => {
  // 로컬 개발 주소와 쿼리·Unicode 경로도 일반 웹 링크이다.
  const result = validateBrowserUrl(url);

  expect(expectOk(result)).toBe(url);
});

test.each(["file:///tmp/private", "javascript:alert(1)", "data:text/html,unsafe", "command:run", "not a URL", " https://example.invalid", "https:example.invalid", "https://example.invalid/\u0000", "https://example.invalid/\nnext"])("위험하거나 잘못된 URL %j는 프로세스 실행 전에 거절한다", async url => {
  // 웹 주소처럼 시작해도 제어 문자가 들어 있으면 실행 경계를 통과하지 못한다.
  const result = await openBrowserUrl(url);

  expect(expectError(result).code).toBe("BROWSER_UNAVAILABLE");
});

test.skipIf(process.platform === "win32")("OS 기본 브라우저 명령에 URL 전체를 하나의 인수로 전달하고 셸로 해석하지 않는다", async () => {
  // 실제 브라우저 대신 실행 인수만 기록하는 OS 명령 대역을 PATH 앞에 둔다.
  const directory = await mkdtemp(join(tmpdir(), "radian-browser-")), captured = join(directory, "args");
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const previousPath = process.env.PATH, previousCapture = process.env.RADIAN_TEST_BROWSER_ARGS;
  const url = "https://example.invalid/?next=$(echo%20unsafe)&quoted='value'";
  try {
    await writeFile(join(directory, command), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$RADIAN_TEST_BROWSER_ARGS"\n', { mode: 0o700 });
    process.env.PATH = directory + delimiter + (previousPath ?? ""); process.env.RADIAN_TEST_BROWSER_ARGS = captured;

    // 브라우저 종류를 지정하지 않고 현재 OS의 기본 URL 처리기에 위임한다.
    const result = await openBrowserUrl(url);

    // 셸 확장 문자가 포함된 URL도 변형이나 추가 명령 실행 없이 전달된다.
    expect(expectOk(result)).toBeUndefined(); expect(await readFile(captured, "utf8")).toBe(url + "\n");
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.RADIAN_TEST_BROWSER_ARGS; else process.env.RADIAN_TEST_BROWSER_ARGS = previousCapture;
    await rm(directory, { recursive: true, force: true });
  }
});
