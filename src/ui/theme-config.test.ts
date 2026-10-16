import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTheme, parseTheme } from "./theme-config.ts";
import { expectError, expectOk } from "../testing/results.ts";

test("테마 설정은 지정한 역할만 재정의하고 빈 설정은 터미널 색상을 유지한다", () => {
  // A partial theme must not become a complete, terminal-independent palette.
  const overrides = { accent: "#Ab12CD", panel: "#123456" };

  const result = expectOk(parseTheme(overrides));

  expect(result).toEqual(overrides);
  expect(expectOk(parseTheme({}))).toEqual({});
});

test.each([null, [], "dark", { unknown: "#123456" }, { text: "red" }, { accent: "#123" }, { panel: 123456 }, { selected: "#12345678" }].map((value) => ({ value })))(
  "잘못된 역할과 색상은 조용히 무시하지 않고 입력 오류로 반환한다: %j", ({ value }) => {
    // Only documented roles and unambiguous RGB values may enter the UI.
    const result = parseTheme(value);

    expect(expectError(result).code).toBe("INVALID_INPUT");
  },
);

test("명시한 테마 파일의 누락·손상과 유효한 재정의를 구분한다", async () => {
  // No test may consult or overwrite the user's actual theme file.
  const directory = await mkdtemp(join(tmpdir(), "radian-theme-")), path = join(directory, "theme.json");
  try {
    const missing = await loadTheme(path);
    await writeFile(path, "{"); const malformed = await loadTheme(path);
    await writeFile(path, '{"accent":"#abcdef"}'); const valid = await loadTheme(path);

    expect(expectError(missing).code).toBe("STORAGE_FAILED");
    expect(expectError(malformed).code).toBe("INVALID_INPUT");
    expect(expectOk(valid)).toEqual({ accent: "#abcdef" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("기본 테마 파일이 없으면 터미널을 따르고 XDG 테마가 있으면 읽는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-theme-xdg-"));
  const previous = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = directory;
  try {
    // Optional default configuration is distinct from an explicitly missing file.
    const absent = await loadTheme();
    await mkdir(join(directory, "radian"));
    await writeFile(join(directory, "radian", "theme.json"), '{"text":"#102030"}');
    const configured = await loadTheme();

    expect(expectOk(absent)).toEqual({});
    expect(expectOk(configured)).toEqual({ text: "#102030" });
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
