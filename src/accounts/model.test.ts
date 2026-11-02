import { expect, test } from "bun:test";
import { accountRequestSchema, loginViewSchema, parseAccountsCommand } from "./model.ts";
import { Value } from "typebox/value";
import { expectError, expectOk } from "../testing/results.ts";
import { openLoginUrl } from "./browser.ts";

test.each(["check", "reauthenticate"] as const)(
  "%s schemas require a named target and current revision",
  (type) => {
    // External credentials and malformed targets must not enter managed replacement flows.
    const request = {
      type,
      worktreeId: "one",
      provider: "anthropic",
      accountId: "named",
      revision: 1,
    };

    const valid = Value.Check(accountRequestSchema, request);

    expect(valid).toBe(true);
    expect(Value.Check(accountRequestSchema, { ...request, accountId: null })).toBe(false);
    expect(Value.Check(accountRequestSchema, { ...request, accountId: "" })).toBe(false);
    expect(Value.Check(accountRequestSchema, { ...request, revision: -1 })).toBe(false);
    expect(Value.Check(accountRequestSchema, { ...request, unexpected: true })).toBe(false);
  },
);

test("Login schema preserves legacy add views and accepts replacement intent with persistence warnings", () => {
  // Intent is additive so older add flows retain their original representation.
  const view = { id: "flow", revision: 1, status: "complete", events: [] };

  const replacement = {
    ...view,
    intent: "reauthenticate",
    warning: "Accepted in memory; storage needs repair.",
  };

  expect(Value.Check(loginViewSchema, view)).toBe(true);
  expect(Value.Check(loginViewSchema, replacement)).toBe(true);
  expect(Value.Check(loginViewSchema, { ...view, intent: "replace-all" })).toBe(false);
});

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
  const invalid = parseAccountsCommand("/accounts private-key");
  const other = parseAccountsCommand("/accounts-guide");

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
