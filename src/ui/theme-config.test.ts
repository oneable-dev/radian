import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTheme, parseTheme } from "./theme-config.ts";
import { expectError, expectOk } from "../testing/results.ts";

test("Theme settings override only specified roles and empty settings retain terminal colors", () => {
  // A partial theme must not become a complete, terminal-independent palette.
  const overrides = { accent: "#Ab12CD", panel: "#123456" };

  const result = expectOk(parseTheme(overrides));

  expect(result).toEqual(overrides);
  expect(expectOk(parseTheme({}))).toEqual({});
});

test.each([null, [], "dark", { unknown: "#123456" }, { text: "red" }, { accent: "#123" }, { panel: 123456 }, { selected: "#12345678" }].map((value) => ({ value })))(
  "Invalid roles and colors return input errors instead of being silently ignored: %j", ({ value }) => {
    // Only documented roles and unambiguous RGB values may enter the UI.
    const result = parseTheme(value);

    expect(expectError(result).code).toBe("INVALID_INPUT");
  },
);

test("Explicit theme files distinguish missing/corrupt files from valid overrides", async () => {
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

test("Absent default themes follow terminals while existing XDG themes load", async () => {
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
