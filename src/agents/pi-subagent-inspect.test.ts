import { expect, test } from "bun:test";
import { readSubagentInspection } from "./pi-subagent-inspect.ts";
import { expectError, expectOk } from "../testing/results.ts";

test.each(
  [
    undefined,
    [],
    ["invalid"],
    ["PI_SUBAGENT_INSPECT_JSON:{"],
    [
      "PI_SUBAGENT_INSPECT_JSON:" +
        JSON.stringify({ kind: "pi-subagents.inspect-reply", version: 2, requestId: "request" }),
    ],
  ].map((value) => ({ value })),
)(
  "Malformed or unsupported inspection packets fail with a stable protocol code: %j",
  ({ value }) => {
    expect(expectError(readSubagentInspection(value)).code).toBe("PROTOCOL_ERROR");
  },
);

test("Inspection errors retain their request identity and error outcome", () => {
  const reply = {
    kind: "pi-subagents.inspect-reply",
    version: 1,
    requestId: "request",
    error: { code: "not_found", message: "No run" },
  };

  const result = expectOk(
    readSubagentInspection(["PI_SUBAGENT_INSPECT_JSON:" + JSON.stringify(reply)]),
  );

  expect(result.failed).toBe(true);
  expect(JSON.parse(result.text)).toEqual(reply);
});
