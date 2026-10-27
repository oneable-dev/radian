import { expect, test } from "bun:test";
import { parseAccountsCommand } from "./model.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { openLoginUrl } from "./browser.ts";

test.each(["/accounts", "  /accounts  ", "/accounts\n"])(
  "%j is trimmed and reserved as a host command instead of model input",
  (text) => {
    // Match SDK trimming at the host boundary so commands cannot slip through.
    const reserved = parseAccountsCommand(text);

    expect(expectOk(reserved)).toBe(true);
  },
);

test("Account command arguments are rejected without reserving similar prose", () => {
  // Never send API-key-like command arguments to the model.
  const invalid = parseAccountsCommand("/accounts private-key"),
    other = parseAccountsCommand("/accounts-guide");

  expect(expectError(invalid).code).toBe("INVALID_INPUT");
  expect(expectOk(other)).toBe(false);
});

test.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/html,example", "not a URL"])(
  "Authentication URL %j is rejected before launching a browser",
  async (url) => {
    // Validate URL scheme boundaries without launching external processes.
    const result = await openLoginUrl(url);

    expect(expectError(result).code).toBe("BROWSER_UNAVAILABLE");
  },
);
