import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { validateBrowserUrl, openBrowserUrl } from "./browser.ts";
import { expectError, expectOk } from "./testing/results.ts";

test.each([
  "https://example.invalid/docs?q=one&next=two",
  "http://localhost:3000/preview",
  "https://example.invalid/한글",
])("Web URL %s is allowed as a default-browser target", (url) => {
  // Local development URLs, queries, and Unicode paths are ordinary web links.
  const result = validateBrowserUrl(url);

  expect(expectOk(result)).toBe(url);
});

test.each([
  "file:///tmp/private",
  "javascript:alert(1)",
  "data:text/html,unsafe",
  "command:run",
  "not a URL",
  " https://example.invalid",
  "https:example.invalid",
  "https://example.invalid/\u0000",
  "https://example.invalid/\nnext",
])("Unsafe or invalid URL %j is rejected before process execution", async (url) => {
  // Web-like prefixes cannot bypass control-character rejection.
  const result = await openBrowserUrl(url);

  expect(expectError(result).code).toBe("BROWSER_UNAVAILABLE");
});

test.skipIf(process.platform === "win32")(
  "Default-browser commands receive complete URLs as single arguments without shell interpretation",
  async () => {
    // Prepend PATH with an OS-command stub recording arguments instead of launching browsers.
    const directory = await mkdtemp(join(tmpdir(), "radian-browser-")),
      captured = join(directory, "args");
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    const previousPath = process.env.PATH,
      previousCapture = process.env.RADIAN_TEST_BROWSER_ARGS;
    const url = "https://example.invalid/?next=$(echo%20unsafe)&quoted='value'";
    try {
      await writeFile(
        join(directory, command),
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$RADIAN_TEST_BROWSER_ARGS"\n',
        { mode: 0o700 },
      );
      process.env.PATH = directory + delimiter + (previousPath ?? "");
      process.env.RADIAN_TEST_BROWSER_ARGS = captured;

      // Delegate to the OS default URL handler without choosing browser types.
      const result = await openBrowserUrl(url);

      // Shell metacharacters pass unchanged without expansion or additional execution.
      expect(expectOk(result)).toBeUndefined();
      expect(await readFile(captured, "utf8")).toBe(url + "\n");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCapture === undefined) delete process.env.RADIAN_TEST_BROWSER_ARGS;
      else process.env.RADIAN_TEST_BROWSER_ARGS = previousCapture;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
